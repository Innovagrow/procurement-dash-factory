/**
 * Primary detection source: the Upwork GraphQL marketplace search.
 *
 * The exact field set exposed by marketplaceJobPostingsSearch depends on the
 * API tier granted to the app, so this module is written defensively: the
 * selection sets below are the shape to edit if the account's schema differs
 * (remove a field the server rejects, or add one it exposes), and every value is
 * read through the pick* helpers so a missing or renamed field degrades to null
 * instead of crashing the poll.
 */

import type { AxiosResponse } from 'axios';
import { env } from '../config/env';
import { RateLimitError, UpstreamError } from '../lib/errors';
import { createHttpClient, requestWithRetry } from '../lib/http';
import { toIso } from '../lib/time';
import type { RawJob, SourceContext, SourceResult } from '../types';
import { BaseSource, isSourceSelected } from './base';
import {
  asRecord,
  cleanQuestions,
  cleanSkills,
  parseHourlyRange,
  pickArray,
  pickBoolean,
  pickDate,
  pickInt,
  pickNumber,
  pickPath,
  pickString,
  safeNormalizeJob,
  toStringOrNull,
  UPWORK_JOB_BASE,
} from './normalize';
import { authorizedHeaders, forceRefreshAccessToken, isOAuthConfigured } from './upwork-oauth';

export const SOURCE_NAME = 'upwork_api';
const SOURCE_ALIASES = ['upwork', 'upwork_graphql', 'graphql', 'api'];

const MAX_PAGES_PER_QUERY = 10;
const PAGE_SIZE = 50;

/**
 * Search query. `marketPlaceJobFilter` carries both the filters and the
 * pagination block (`pagination_eq: { after, first }`) in the current schema.
 */
export const MARKETPLACE_SEARCH_QUERY = `
query marketplaceJobPostingsSearch(
  $marketPlaceJobFilter: MarketplaceJobPostingsSearchFilter,
  $searchType: MarketplaceJobPostingSearchType,
  $sortAttributes: [MarketplaceJobPostingSearchSortAttribute]
) {
  marketplaceJobPostingsSearch(
    marketPlaceJobFilter: $marketPlaceJobFilter,
    searchType: $searchType,
    sortAttributes: $sortAttributes
  ) {
    totalCount
    edges {
      node {
        id
        ciphertext
        title
        description
        category
        subcategory
        skills {
          name
          prettyName
        }
        job {
          contractTerms
        }
        amount {
          rawValue
          currency
          displayValue
        }
        hourlyBudgetType
        hourlyBudgetMin {
          rawValue
          currency
          displayValue
        }
        hourlyBudgetMax {
          rawValue
          currency
          displayValue
        }
        duration
        durationLabel
        engagement
        experienceLevel
        createdDateTime
        publishedDateTime
        totalApplicants
        preferredFreelancerLocation
        preferredFreelancerLocationMandatory
        premium
        client {
          totalSpent {
            rawValue
            currency
          }
          totalHires
          totalPostedJobs
          totalReviews
          totalFeedback
          verificationStatus
          companyRid
          edcUserId
          location {
            country
            city
          }
        }
      }
    }
    pageInfo {
      endCursor
      hasNextPage
    }
  }
}
`.trim();

/**
 * Detail query used to enrich a shortlisted job with the full description and
 * the screening questions, which the search payload does not include.
 */
export const JOB_DETAIL_QUERY = `
query marketplaceJobPosting($id: ID!) {
  marketplaceJobPosting(id: $id) {
    id
    ciphertext
    content {
      title
      description
    }
    description
    questions
    classification {
      category {
        prefLabel
      }
      subCategory {
        prefLabel
      }
      skills {
        prefLabel
      }
      additionalSkills {
        prefLabel
      }
    }
    contractTerms {
      contractType
      fixedPriceContractTerms {
        amount {
          rawValue
          currency
        }
      }
      hourlyContractTerms {
        engagementDuration {
          label
        }
        hourlyBudgetMin
        hourlyBudgetMax
      }
    }
    activityStat {
      applicationsBidStats {
        avgRateBid {
          rawValue
        }
      }
      jobActivity {
        lastClientActivity
        totalApplicants
        totalHired
        totalInvitedToInterview
      }
    }
    ownership {
      company {
        name
      }
    }
  }
}
`.trim();

interface GraphqlError {
  message?: unknown;
  path?: unknown;
  extensions?: unknown;
}

interface GraphqlEnvelope {
  data?: unknown;
  errors?: unknown;
}

// 4xx bodies carry GraphQL error details worth logging; 5xx/429 stay throwable
// so requestWithRetry can back off and the circuit breaker can see the failure.
const graphqlClient = createHttpClient({
  timeoutMs: env.HTTP_TIMEOUT_MS,
  headers: { 'Content-Type': 'application/json' },
  validateStatus: (status: number) => status < 500 && status !== 429,
});

function collectGraphqlErrors(errors: unknown): string[] {
  if (!Array.isArray(errors)) return [];
  return errors
    .map((entry) => {
      const record = asRecord(entry) as GraphqlError | null;
      const message = record ? toStringOrNull(record.message) : null;
      return message ?? (typeof entry === 'string' ? entry : null);
    })
    .filter((message): message is string => message !== null && message.length > 0);
}

function looksRateLimited(messages: string[]): boolean {
  return messages.some((message) => /rate.?limit|too many requests|throttl/i.test(message));
}

async function postGraphql(
  query: string,
  variables: Record<string, unknown>,
  label: string,
): Promise<AxiosResponse<GraphqlEnvelope>> {
  const headers = await authorizedHeaders({ 'Content-Type': 'application/json' });
  return requestWithRetry<GraphqlEnvelope>(
    {
      url: env.UPWORK_GRAPHQL_URL,
      method: 'POST',
      data: { query, variables },
      headers,
    },
    { client: graphqlClient, label, maxRetries: env.HTTP_MAX_RETRIES },
  );
}

/**
 * Executes a GraphQL document. Refreshes the access token once on 401, turns a
 * `errors` array into UpstreamError (or RateLimitError when the message says so)
 * and returns the `data` object.
 */
export async function executeGraphql<T = Record<string, unknown>>(
  query: string,
  variables: Record<string, unknown>,
  label: string,
): Promise<T> {
  let response = await postGraphql(query, variables, label);

  if (response.status === 401) {
    await forceRefreshAccessToken();
    response = await postGraphql(query, variables, `${label} (after token refresh)`);
  }

  if (response.status === 429) {
    throw new RateLimitError(`${label} rate limited by Upwork`, undefined, {
      details: { label, status: response.status },
    });
  }

  if (response.status >= 400) {
    const messages = collectGraphqlErrors(response.data?.errors);
    throw new UpstreamError(
      `${label} failed with HTTP ${response.status}${messages.length > 0 ? `: ${messages.join('; ')}` : ''}`,
      { upstreamStatus: response.status, details: { label, messages } },
    );
  }

  const messages = collectGraphqlErrors(response.data?.errors);
  if (messages.length > 0) {
    if (looksRateLimited(messages)) {
      throw new RateLimitError(`${label} rate limited: ${messages.join('; ')}`, undefined, {
        details: { label, messages },
      });
    }
    throw new UpstreamError(`${label} returned GraphQL errors: ${messages.join('; ')}`, {
      upstreamStatus: response.status,
      details: { label, messages },
    });
  }

  const data = asRecord(response.data?.data);
  if (!data) {
    throw new UpstreamError(`${label} returned no data block`, {
      upstreamStatus: response.status,
      details: { label },
    });
  }

  return data as unknown as T;
}

/* ------------------------------------------------------------------ search */

export interface SearchParams {
  searchExpression?: string | null;
  first?: number;
  after?: string | null;
  /** Extra filter keys merged into marketPlaceJobFilter verbatim. */
  filter?: Record<string, unknown>;
}

export interface SearchPage {
  nodes: unknown[];
  endCursor: string | null;
  hasNextPage: boolean;
  totalCount: number | null;
}

export async function searchJobPostings(params: SearchParams): Promise<SearchPage> {
  const first = Math.max(1, Math.min(params.first ?? PAGE_SIZE, 100));
  const marketPlaceJobFilter: Record<string, unknown> = {
    ...(params.filter ?? {}),
    pagination_eq: { after: params.after ?? '0', first },
  };

  const expression = toStringOrNull(params.searchExpression);
  if (expression !== null) marketPlaceJobFilter.searchExpression_eq = expression;

  const data = await executeGraphql(
    MARKETPLACE_SEARCH_QUERY,
    {
      marketPlaceJobFilter,
      searchType: 'USER_JOBS_SEARCH',
      sortAttributes: [{ field: 'RECENCY' }],
    },
    'POST upwork/graphql(marketplaceJobPostingsSearch)',
  );

  const root = asRecord(pickPath(data, 'marketplaceJobPostingsSearch'));
  if (!root) {
    return { nodes: [], endCursor: null, hasNextPage: false, totalCount: null };
  }

  const edges = pickArray(root, 'edges');
  const nodes = edges
    .map((edge) => {
      const record = asRecord(edge);
      if (!record) return null;
      // Some tiers return the node inline instead of wrapped in an edge.
      return record.node !== undefined ? record.node : record;
    })
    .filter((node) => node !== null && node !== undefined);

  const inlineNodes = nodes.length === 0 ? pickArray(root, 'nodes') : [];

  return {
    nodes: nodes.length > 0 ? nodes : inlineNodes,
    endCursor: pickString(root, 'pageInfo.endCursor'),
    hasNextPage: pickBoolean(root, 'pageInfo.hasNextPage') ?? false,
    totalCount: pickInt(root, 'totalCount'),
  };
}

/* ----------------------------------------------------------------- mapping */

function contractTypeOf(node: unknown): string | null {
  return pickString(
    node,
    'hourlyBudgetType',
    'job.contractTerms.contractType',
    'contractTerms.contractType',
    'jobType',
    'type',
  );
}

/** Maps one search node onto a RawJob. Returns null when it is unusable. */
export function mapSearchNode(node: unknown): RawJob | null {
  const record = asRecord(node);
  if (!record) return null;

  const ciphertext = pickString(record, 'ciphertext', 'cipherText', 'uid');
  const id = pickString(record, 'id', 'recordNumber');

  const hourlyMin = pickNumber(
    record,
    'hourlyBudgetMin.rawValue',
    'hourlyBudgetMin',
    'job.contractTerms.hourlyContractTerms.hourlyBudgetMin',
    'contractTerms.hourlyContractTerms.hourlyBudgetMin',
  );
  const hourlyMax = pickNumber(
    record,
    'hourlyBudgetMax.rawValue',
    'hourlyBudgetMax',
    'job.contractTerms.hourlyContractTerms.hourlyBudgetMax',
    'contractTerms.hourlyContractTerms.hourlyBudgetMax',
  );
  const budgetAmount = pickNumber(
    record,
    'amount.rawValue',
    'amount',
    'budget.rawValue',
    'job.contractTerms.fixedPriceContractTerms.amount.rawValue',
    'contractTerms.fixedPriceContractTerms.amount.rawValue',
  );

  const currency = pickString(
    record,
    'amount.currency',
    'hourlyBudgetMin.currency',
    'hourlyBudgetMax.currency',
    'currency',
  );

  const skills = cleanSkills([
    ...pickArray(record, 'skills'),
    ...pickArray(record, 'classification.skills'),
    ...pickArray(record, 'attrs'),
  ]);

  const clientRecord = asRecord(record.client) ?? asRecord(record.clientCompanyPublic) ?? {};

  return safeNormalizeJob({
    source: SOURCE_NAME,
    externalId: ciphertext ?? id,
    ciphertext,
    id,
    url: ciphertext ?? (id === null ? null : `${UPWORK_JOB_BASE}${id}`),
    title: pickString(record, 'title', 'content.title'),
    description: pickString(record, 'description', 'content.description'),
    postedAt: pickDate(record, 'publishedDateTime', 'createdDateTime', 'postedOn', 'renewedDateTime'),
    skills,
    category: pickString(record, 'category', 'classification.category.prefLabel', 'occupations.category.prefLabel'),
    subcategory: pickString(
      record,
      'subcategory',
      'classification.subCategory.prefLabel',
      'occupations.subCategories.0.prefLabel',
    ),
    jobType: contractTypeOf(record),
    budgetAmount,
    hourlyMin,
    hourlyMax,
    currency,
    durationLabel: pickString(record, 'durationLabel', 'duration', 'engagementDuration.label'),
    experienceLevel: pickString(record, 'experienceLevel', 'tierText', 'tier'),
    workload: pickString(record, 'engagement', 'workload'),
    connectsRequired: pickInt(record, 'connectsRequired', 'connects', 'proposalConnects'),
    proposalsCount: pickInt(record, 'totalApplicants', 'applicationsCount', 'proposalsCount'),
    interviewingCount: pickInt(record, 'totalInvitedToInterview', 'interviewingCount'),
    screeningQuestions: cleanQuestions(pickArray(record, 'questions')),
    client: clientRecord,
    raw: record,
  });
}

/* ------------------------------------------------------------ job detail */

export interface JobDetail {
  externalId: string;
  title: string | null;
  description: string | null;
  screeningQuestions: string[];
  skills: string[];
  category: string | null;
  subcategory: string | null;
  jobType: string | null;
  budgetAmount: number | null;
  hourlyMin: number | null;
  hourlyMax: number | null;
  durationLabel: string | null;
  proposalsCount: number | null;
  interviewingCount: number | null;
  raw: unknown;
}

/**
 * Enriches a job before drafting: the search payload omits the screening
 * questions and often truncates the description.
 */
export async function fetchJobDetail(ciphertextOrId: string): Promise<JobDetail> {
  const id = ciphertextOrId.trim();
  if (id === '') {
    throw new UpstreamError('fetchJobDetail requires a job ciphertext or id');
  }

  const data = await executeGraphql(
    JOB_DETAIL_QUERY,
    { id: id.startsWith('~') ? id : `~${id}` },
    'POST upwork/graphql(marketplaceJobPosting)',
  );

  const node = asRecord(pickPath(data, 'marketplaceJobPosting'));
  if (!node) {
    throw new UpstreamError(`Upwork returned no job posting for ${id}`, { details: { id } });
  }

  const hourly = parseHourlyRange(pickString(node, 'contractTerms.hourlyContractTerms.hourlyBudgetText'));

  return {
    externalId: pickString(node, 'ciphertext', 'id') ?? id,
    title: pickString(node, 'content.title', 'title'),
    description: pickString(node, 'content.description', 'description'),
    screeningQuestions: cleanQuestions(pickArray(node, 'questions', 'screeningQuestions')),
    skills: cleanSkills([
      ...pickArray(node, 'classification.skills'),
      ...pickArray(node, 'classification.additionalSkills'),
      ...pickArray(node, 'skills'),
    ]),
    category: pickString(node, 'classification.category.prefLabel', 'category'),
    subcategory: pickString(node, 'classification.subCategory.prefLabel', 'subcategory'),
    jobType: pickString(node, 'contractTerms.contractType', 'hourlyBudgetType'),
    budgetAmount: pickNumber(
      node,
      'contractTerms.fixedPriceContractTerms.amount.rawValue',
      'amount.rawValue',
    ),
    hourlyMin:
      pickNumber(node, 'contractTerms.hourlyContractTerms.hourlyBudgetMin', 'hourlyBudgetMin.rawValue') ??
      hourly.min,
    hourlyMax:
      pickNumber(node, 'contractTerms.hourlyContractTerms.hourlyBudgetMax', 'hourlyBudgetMax.rawValue') ??
      hourly.max,
    durationLabel: pickString(
      node,
      'contractTerms.hourlyContractTerms.engagementDuration.label',
      'durationLabel',
    ),
    proposalsCount: pickInt(node, 'activityStat.jobActivity.totalApplicants', 'totalApplicants'),
    interviewingCount: pickInt(
      node,
      'activityStat.jobActivity.totalInvitedToInterview',
      'totalInvitedToInterview',
    ),
    raw: node,
  };
}

/* ------------------------------------------------------------------ source */

export class UpworkGraphqlSource extends BaseSource {
  constructor() {
    super({
      name: SOURCE_NAME,
      rateCapacity: 8,
      rateRefillPerSecond: 2,
      breaker: { failureThreshold: 4, cooldownMs: 120_000 },
      cooldownBaseMs: 60_000,
      cooldownMaxMs: 30 * 60_000,
    });
  }

  override isEnabled(): boolean {
    return isSourceSelected(SOURCE_NAME, SOURCE_ALIASES) && isOAuthConfigured();
  }

  protected override async run(ctx: SourceContext): Promise<SourceResult> {
    const queries = ctx.queries.filter((query) => query.trim() !== '');
    const effectiveQueries = queries.length > 0 ? queries : [''];
    const perQuery = Math.max(1, Math.ceil(ctx.limit / effectiveQueries.length));

    const collected = new Map<string, RawJob>();
    const sinceMs = ctx.since ? ctx.since.getTime() : null;
    let newest: Date | null = null;
    let pagesFetched = 0;
    let stoppedEarly = false;

    for (const query of effectiveQueries) {
      let offset = 0;
      let after: string | null = null;

      for (let page = 0; page < MAX_PAGES_PER_QUERY; page += 1) {
        await this.limiter.take();

        const pageSize = Math.min(PAGE_SIZE, Math.max(1, perQuery - offset));
        const result = await searchJobPostings({
          searchExpression: query === '' ? null : query,
          first: pageSize,
          after: after ?? String(offset),
        });
        pagesFetched += 1;

        if (result.nodes.length === 0) break;

        let olderThanSince = 0;
        for (const node of result.nodes) {
          const job = mapSearchNode(node);
          if (!job) continue;

          if (job.postedAt && (newest === null || job.postedAt.getTime() > newest.getTime())) {
            newest = job.postedAt;
          }
          if (sinceMs !== null && job.postedAt && job.postedAt.getTime() <= sinceMs) {
            olderThanSince += 1;
            continue;
          }
          collected.set(`${job.source}::${job.externalId}`, job);
        }

        offset += result.nodes.length;

        // RECENCY sort means a full page below the watermark ends the walk.
        if (sinceMs !== null && olderThanSince >= result.nodes.length) {
          stoppedEarly = true;
          break;
        }
        if (offset >= perQuery || !result.hasNextPage) break;

        after = result.endCursor;
        if (after === null) after = String(offset);
      }

      if (collected.size >= ctx.limit) break;
    }

    const jobs = Array.from(collected.values()).slice(0, ctx.limit);

    return {
      jobs,
      cursor: newest ? toIso(newest) : ctx.cursor,
      meta: {
        queries: effectiveQueries.length,
        pages: pagesFetched,
        stoppedEarly,
        since: toIso(ctx.since),
      },
    };
  }
}

export const upworkGraphqlSource = new UpworkGraphqlSource();
