/**
 * Submits through the Upwork GraphQL API using the OAuth client in
 * ../sources/upwork-oauth.
 *
 * Ordinary freelancer apps are not granted the proposal-submission scope, so the
 * server usually answers "cannot query field" / 403 / 404. That answer is mapped
 * to a FAILED result flagged for fallback, and the dispatcher re-routes the
 * proposal to the review queue rather than pretending it was sent.
 */

import type { AxiosResponse } from 'axios';
import { env, hasUpworkOAuth } from '../config/env';
import { isRetryable, toErrorMessage } from '../lib/errors';
import { backoffDelay, createHttpClient, parseRetryAfter, requestWithRetry, sleep } from '../lib/http';
import { child } from '../lib/logger';
import {
  authorizedHeaders,
  forceRefreshAccessToken,
  getConnectionStatus,
  isOAuthConfigured,
} from '../sources/upwork-oauth';
import type { ProposalSubmitter, SubmitContext } from '../types';
import type { PreparableSubmitter, SubmitAttemptResult } from './policy';
import { estimateConnects } from './quotas';

const log = child('submit:api');

export const SUBMITTER_NAME = 'api';

/* ========================================================================== */
/*  ADJUST HERE when the account is granted the proposal-submission scope.     */
/*                                                                            */
/*  Everything about the wire shape of a submission lives in this one          */
/*  constant: the endpoint, the mutation document, the variables, and where    */
/*  the created proposal id sits in the response. Nothing else in the codebase */
/*  needs to change when Upwork hands out a different field set.               */
/* ========================================================================== */

export interface ProposalSubmitOperation {
  readonly endpoint: string;
  readonly operationName: string;
  readonly document: string;
  /** Path to the created proposal id inside the GraphQL `data` block. */
  readonly idPath: readonly string[];
  buildVariables(ctx: SubmitContext): Record<string, unknown>;
}

export const PROPOSAL_SUBMIT_OPERATION: ProposalSubmitOperation = {
  endpoint: env.UPWORK_GRAPHQL_URL,
  operationName: 'createProposal',
  document: `
mutation createProposal($input: ProposalCreateInput!) {
  createProposal(input: $input) {
    proposal {
      id
      status
    }
  }
}
`.trim(),
  idPath: ['createProposal', 'proposal', 'id'],
  buildVariables(ctx: SubmitContext): Record<string, unknown> {
    const isHourly = String(ctx.job.jobType).toUpperCase() === 'HOURLY';
    const input: Record<string, unknown> = {
      marketplaceJobPostingId: ctx.job.externalId,
      coverLetter: ctx.coverLetter,
    };

    if (isHourly) {
      const rate = ctx.hourlyRate ?? ctx.profile.hourlyRate;
      if (typeof rate === 'number' && Number.isFinite(rate)) {
        input.chargeRate = { rawValue: rate.toFixed(2), currency: 'USD' };
      }
    } else if (typeof ctx.bidAmount === 'number' && Number.isFinite(ctx.bidAmount)) {
      input.amount = { rawValue: ctx.bidAmount.toFixed(2), currency: 'USD' };
    }

    if (ctx.questionAnswers.length > 0) {
      input.questionAnswers = ctx.questionAnswers.map((entry) => ({
        question: entry.question,
        answer: entry.answer,
      }));
    }

    return { input };
  },
};

/* ------------------------------------------------------------------ wiring */

interface GraphqlEnvelope {
  data?: Record<string, unknown> | null;
  errors?: unknown;
}

const mutationClient = createHttpClient({
  timeoutMs: Math.min(env.HTTP_TIMEOUT_MS, 45_000),
  headers: { 'Content-Type': 'application/json' },
  // Read every status ourselves: a 4xx body carries the scope error we need.
  validateStatus: () => true,
});

/** Anything matching this means "this account may not submit proposals here". */
const SCOPE_DENIED_PATTERN =
  /cannot query field|unknown field|unknown argument|not permitted|no permission|permission denied|access denied|unauthori[sz]ed|forbidden|insufficient scope|missing scope|not allowed/i;

const MAX_ATTEMPTS = Math.max(1, Math.min(env.HTTP_MAX_RETRIES + 1, 4));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectErrors(errors: unknown): string[] {
  if (!Array.isArray(errors)) return [];
  const messages: string[] = [];
  for (const entry of errors) {
    if (typeof entry === 'string') {
      messages.push(entry);
      continue;
    }
    if (isRecord(entry) && typeof entry.message === 'string') {
      messages.push(entry.message);
    }
  }
  return messages;
}

function pickPath(source: unknown, path: readonly string[]): string | null {
  let cursor: unknown = source;
  for (const segment of path) {
    if (!isRecord(cursor)) return null;
    cursor = cursor[segment];
  }
  if (typeof cursor === 'string' && cursor.length > 0) return cursor;
  if (typeof cursor === 'number') return String(cursor);
  return null;
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!isRecord(headers)) return undefined;
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

const SCOPE_HELP =
  'This Upwork app is not granted the proposal-submission scope, so the API cannot send ' +
  'proposals for this account. Falling back to the review queue: approve from the ' +
  'notification or the dashboard and submit from the job page. Set SUBMITTER=review_queue ' +
  'to stop attempting the API call.';

function looksScopeDenied(status: number, messages: string[]): boolean {
  if (status === 403 || status === 404) return true;
  return messages.some((message) => SCOPE_DENIED_PATTERN.test(message));
}

async function postMutation(
  variables: Record<string, unknown>,
  label: string,
): Promise<AxiosResponse<GraphqlEnvelope>> {
  const headers = await authorizedHeaders({ 'Content-Type': 'application/json' });
  return requestWithRetry<GraphqlEnvelope>(
    {
      url: PROPOSAL_SUBMIT_OPERATION.endpoint,
      method: 'POST',
      data: {
        query: PROPOSAL_SUBMIT_OPERATION.document,
        operationName: PROPOSAL_SUBMIT_OPERATION.operationName,
        variables,
      },
      headers,
    },
    // maxRetries 0: this module owns the retry policy because a mutation must
    // never be replayed once the server has answered with a body.
    { client: mutationClient, label, maxRetries: 0 },
  );
}

/* --------------------------------------------------------------- submitter */

export class ApiSubmitter implements ProposalSubmitter, PreparableSubmitter {
  readonly name = SUBMITTER_NAME;

  readonly canAutoSubmit = true;

  private tokenPresent: boolean | null = null;

  /** Refreshes the "is an account actually connected" flag isConfigured() reports. */
  async prepare(): Promise<void> {
    if (!hasUpworkOAuth()) {
      this.tokenPresent = false;
      return;
    }
    const status = await getConnectionStatus();
    this.tokenPresent = status.connected;
  }

  isConfigured(): boolean {
    return isOAuthConfigured() && this.tokenPresent === true;
  }

  /** Reason isConfigured() is false, for logs and the dashboard. */
  configurationHint(): string {
    if (!hasUpworkOAuth()) {
      return 'UPWORK_CLIENT_ID, UPWORK_CLIENT_SECRET and UPWORK_REDIRECT_URI must be set';
    }
    if (this.tokenPresent !== true) {
      return 'no Upwork OAuth token is stored; connect the account at /oauth/upwork/start';
    }
    return 'configured';
  }

  async submit(ctx: SubmitContext): Promise<SubmitAttemptResult> {
    const variables = PROPOSAL_SUBMIT_OPERATION.buildVariables(ctx);
    const payload = {
      endpoint: PROPOSAL_SUBMIT_OPERATION.endpoint,
      operationName: PROPOSAL_SUBMIT_OPERATION.operationName,
      query: PROPOSAL_SUBMIT_OPERATION.document,
      variables,
    };
    const connects = estimateConnects(ctx.job);
    const label = `POST upwork/graphql(${PROPOSAL_SUBMIT_OPERATION.operationName}) proposal=${ctx.proposalId}`;

    if (ctx.dryRun || env.DRY_RUN) {
      log.info({ proposalId: ctx.proposalId, jobId: ctx.job.id }, 'dry run: upwork mutation not sent');
      return {
        status: 'DRY_RUN',
        message: `DRY_RUN: would POST ${PROPOSAL_SUBMIT_OPERATION.operationName} to ${PROPOSAL_SUBMIT_OPERATION.endpoint}`,
        payload,
        attempt: 0,
        connectsSpent: 0,
      };
    }

    if (!this.isConfigured()) {
      return {
        status: 'FAILED',
        message: `upwork api submitter is not usable: ${this.configurationHint()}`,
        payload,
        attempt: 0,
        fallbackToReview: true,
      };
    }

    let attempt = 0;
    let refreshedToken = false;
    let lastMessage = 'no attempt was made';

    while (attempt < MAX_ATTEMPTS) {
      attempt += 1;

      let response: AxiosResponse<GraphqlEnvelope>;
      try {
        response = await postMutation(variables, label);
      } catch (err) {
        // No response at all: the request never produced a server answer, so a
        // retry cannot duplicate a submission.
        lastMessage = toErrorMessage(err);
        log.warn({ err, proposalId: ctx.proposalId, attempt }, 'upwork submit request failed');
        if (attempt < MAX_ATTEMPTS && isRetryable(err)) {
          await sleep(backoffDelay(attempt));
          continue;
        }
        return {
          status: 'FAILED',
          message: `upwork submit failed after ${attempt} attempt(s): ${lastMessage}`,
          payload,
          attempt,
        };
      }

      const status = response.status;
      const messages = collectErrors(response.data?.errors);

      if (status === 401 && !refreshedToken) {
        refreshedToken = true;
        try {
          await forceRefreshAccessToken();
        } catch (err) {
          log.warn({ err, proposalId: ctx.proposalId }, 'forced token refresh failed');
        }
        lastMessage = 'unauthorized (401); refreshed the access token';
        if (attempt < MAX_ATTEMPTS) continue;
      }

      if (status === 429 && attempt < MAX_ATTEMPTS) {
        const retryAfterMs = parseRetryAfter(headerValue(response.headers, 'retry-after'));
        lastMessage = 'rate limited by upwork (429)';
        log.warn({ proposalId: ctx.proposalId, attempt, retryAfterMs }, lastMessage);
        await sleep(Math.min(retryAfterMs ?? backoffDelay(attempt), 30_000));
        continue;
      }

      if (status >= 500) {
        lastMessage = `upwork returned HTTP ${status}`;
        log.warn({ proposalId: ctx.proposalId, attempt, status }, lastMessage);
        if (attempt < MAX_ATTEMPTS) {
          await sleep(backoffDelay(attempt));
          continue;
        }
        return {
          status: 'FAILED',
          message: `${lastMessage} after ${attempt} attempt(s)`,
          payload,
          attempt,
        };
      }

      if (looksScopeDenied(status, messages)) {
        const detail = messages.length > 0 ? messages.join('; ') : `HTTP ${status}`;
        log.error(
          { proposalId: ctx.proposalId, status, messages, attempt },
          'upwork rejected the proposal mutation: submission scope is not granted',
        );
        return {
          status: 'FAILED',
          message: `${SCOPE_HELP} Upstream said: ${detail}`,
          payload,
          attempt,
          fallbackToReview: true,
        };
      }

      if (status >= 400 || messages.length > 0) {
        // The server answered. Whatever happened, it may have happened for
        // real, so this is terminal for this proposal.
        const detail = messages.length > 0 ? messages.join('; ') : `HTTP ${status}`;
        log.error({ proposalId: ctx.proposalId, status, messages, attempt }, 'upwork submit rejected');
        return {
          status: 'FAILED',
          message: `upwork rejected the submission (${detail}); not retrying because the request reached the server`,
          payload,
          attempt,
        };
      }

      const externalRef = pickPath(response.data?.data, PROPOSAL_SUBMIT_OPERATION.idPath);
      log.info(
        { proposalId: ctx.proposalId, jobId: ctx.job.id, externalRef, attempt },
        'proposal submitted through the upwork api',
      );
      return {
        status: 'SUBMITTED',
        ...(externalRef ? { externalRef } : {}),
        message: `submitted via upwork api${externalRef ? ` (${externalRef})` : ''}`,
        connectsSpent: connects,
        payload,
        attempt,
      };
    }

    return {
      status: 'FAILED',
      message: `upwork submit exhausted ${MAX_ATTEMPTS} attempts: ${lastMessage}`,
      payload,
      attempt,
    };
  }
}

export const apiSubmitter = new ApiSubmitter();

export default apiSubmitter;
