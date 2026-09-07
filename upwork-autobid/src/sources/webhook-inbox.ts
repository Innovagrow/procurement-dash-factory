/**
 * Webhook inbox source. The HTTP API pushes anything it receives on
 * POST /api/inbox into a Redis list, and this source drains it on the next poll.
 * That is the escape hatch for browser extensions, Zapier/Make scenarios and
 * any scraper the operator already runs: they only need to speak plain JSON.
 */

import { z } from 'zod';
import { toErrorMessage } from '../lib/errors';
import { child } from '../lib/logger';
import { redis } from '../lib/redis';
import { toIso } from '../lib/time';
import type { RawJob, SourceContext, SourceResult } from '../types';
import { BaseSource, isSourceSelected } from './base';
import { safeNormalizeJob } from './normalize';

export const SOURCE_NAME = 'webhook';
const SOURCE_ALIASES = ['inbox', 'webhook_inbox', 'push'];

const log = child('source:webhook');

export const INBOX_KEY = 'upbid:inbox';
/** Hard cap so a runaway producer cannot grow the list without bound. */
export const INBOX_MAX_LENGTH = 5000;
const DRAIN_CHUNK = 100;

const clientSchema = z
  .object({
    country: z.string().max(120).nullish(),
    city: z.string().max(120).nullish(),
    paymentVerified: z.union([z.boolean(), z.string(), z.number()]).nullish(),
    totalSpent: z.union([z.number(), z.string()]).nullish(),
    totalHires: z.union([z.number(), z.string()]).nullish(),
    hireRate: z.union([z.number(), z.string()]).nullish(),
    avgRating: z.union([z.number(), z.string()]).nullish(),
    reviewsCount: z.union([z.number(), z.string()]).nullish(),
    memberSince: z.union([z.string(), z.number()]).nullish(),
    openJobs: z.union([z.number(), z.string()]).nullish(),
    clientId: z.string().max(200).nullish(),
    companyName: z.string().max(200).nullish(),
  })
  .passthrough();

const numberish = z.union([z.number(), z.string()]).nullish();

/**
 * Deliberately permissive: producers are third-party tools. Everything beyond
 * "something that identifies a job" is optional and normalised downstream.
 */
export const inboxItemSchema = z
  .object({
    source: z.string().min(1).max(64).optional(),
    externalId: z.string().min(1).max(255).optional(),
    ciphertext: z.string().min(1).max(255).optional(),
    id: z.union([z.string(), z.number()]).optional(),
    url: z.string().min(4).max(2000).optional(),
    link: z.string().min(4).max(2000).optional(),
    title: z.string().min(1).max(500),
    description: z.string().max(60000).optional(),
    descriptionHtml: z.string().max(120000).optional(),
    postedAt: z.union([z.string(), z.number()]).optional(),
    skills: z.union([z.array(z.union([z.string(), z.record(z.unknown())])), z.string()]).optional(),
    category: z.string().max(200).optional(),
    subcategory: z.string().max(200).optional(),
    jobType: z.string().max(64).optional(),
    budgetAmount: numberish,
    budgetText: z.string().max(120).optional(),
    hourlyMin: numberish,
    hourlyMax: numberish,
    hourlyRangeText: z.string().max(120).optional(),
    currency: z.string().max(8).optional(),
    durationLabel: z.string().max(120).optional(),
    experienceLevel: z.string().max(64).optional(),
    workload: z.string().max(64).optional(),
    connectsRequired: numberish,
    proposalsCount: numberish,
    interviewingCount: numberish,
    screeningQuestions: z.array(z.union([z.string(), z.record(z.unknown())])).optional(),
    client: clientSchema.nullish(),
  })
  .passthrough()
  .refine((item) => Boolean(item.url ?? item.link ?? item.externalId ?? item.ciphertext ?? item.id), {
    message: 'one of url, link, externalId, ciphertext or id is required',
  });

export type InboxItem = z.infer<typeof inboxItemSchema>;

export interface InboxPushResult {
  accepted: boolean;
  depth: number;
  error?: string;
}

function itemToRawJob(item: InboxItem): RawJob | null {
  return safeNormalizeJob({
    source: typeof item.source === 'string' && item.source.trim() !== '' ? item.source.trim() : SOURCE_NAME,
    externalId: item.externalId,
    ciphertext: item.ciphertext,
    id: item.id,
    url: item.url ?? item.link,
    title: item.title,
    description: item.description,
    descriptionHtml: item.descriptionHtml,
    postedAt: item.postedAt,
    skills: item.skills,
    category: item.category,
    subcategory: item.subcategory,
    jobType: item.jobType,
    budgetAmount: item.budgetAmount,
    budgetText: item.budgetText,
    hourlyMin: item.hourlyMin,
    hourlyMax: item.hourlyMax,
    hourlyRangeText: item.hourlyRangeText,
    currency: item.currency,
    durationLabel: item.durationLabel,
    experienceLevel: item.experienceLevel,
    workload: item.workload,
    connectsRequired: item.connectsRequired,
    proposalsCount: item.proposalsCount,
    interviewingCount: item.interviewingCount,
    screeningQuestions: item.screeningQuestions,
    client: item.client,
    raw: item,
  });
}

/** Validates and enqueues one payload. Used by the POST /api/inbox route. */
export async function pushInboxItem(payload: unknown): Promise<InboxPushResult> {
  const parsed = inboxItemSchema.safeParse(payload);
  if (!parsed.success) {
    const error = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return { accepted: false, depth: await inboxDepth(), error };
  }

  try {
    const depth = await redis.rpush(INBOX_KEY, JSON.stringify(parsed.data));
    if (depth > INBOX_MAX_LENGTH) {
      await redis.ltrim(INBOX_KEY, -INBOX_MAX_LENGTH, -1);
      return { accepted: true, depth: INBOX_MAX_LENGTH };
    }
    return { accepted: true, depth };
  } catch (err) {
    const message = toErrorMessage(err);
    log.error({ err }, 'failed to push inbox item');
    return { accepted: false, depth: 0, error: message };
  }
}

/** Bulk variant for producers that batch (Zapier "multiple items"). */
export async function pushInboxItems(payloads: unknown[]): Promise<{
  accepted: number;
  rejected: number;
  errors: string[];
  depth: number;
}> {
  let accepted = 0;
  let rejected = 0;
  const errors: string[] = [];
  let depth = 0;

  for (const payload of payloads.slice(0, INBOX_MAX_LENGTH)) {
    const result = await pushInboxItem(payload);
    if (result.accepted) {
      accepted += 1;
      depth = result.depth;
    } else {
      rejected += 1;
      if (result.error && errors.length < 10) errors.push(result.error);
    }
  }

  return { accepted, rejected, errors, depth: depth || (await inboxDepth()) };
}

export async function inboxDepth(): Promise<number> {
  try {
    return await redis.llen(INBOX_KEY);
  } catch (err) {
    log.warn({ err }, 'failed to read inbox depth');
    return 0;
  }
}

async function popBatch(count: number): Promise<string[]> {
  try {
    const popped = await redis.lpop(INBOX_KEY, count);
    if (popped === null) return [];
    return Array.isArray(popped) ? popped : [popped];
  } catch {
    // LPOP with a count needs Redis >= 6.2; fall back to single pops.
    const items: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const value = await redis.lpop(INBOX_KEY);
      if (value === null) break;
      items.push(value);
    }
    return items;
  }
}

export interface DrainResult {
  jobs: RawJob[];
  drained: number;
  invalid: number;
}

/** Drains up to `limit` queued payloads and normalises them. */
export async function drainInbox(limit: number): Promise<DrainResult> {
  const jobs: RawJob[] = [];
  let drained = 0;
  let invalid = 0;

  while (drained < limit) {
    const batch = await popBatch(Math.min(DRAIN_CHUNK, limit - drained));
    if (batch.length === 0) break;
    drained += batch.length;

    for (const entry of batch) {
      let payload: unknown;
      try {
        payload = JSON.parse(entry);
      } catch {
        invalid += 1;
        continue;
      }

      const parsed = inboxItemSchema.safeParse(payload);
      if (!parsed.success) {
        invalid += 1;
        log.debug(
          { issues: parsed.error.issues.map((issue) => issue.message) },
          'dropping invalid inbox item',
        );
        continue;
      }

      const job = itemToRawJob(parsed.data);
      if (job) {
        jobs.push(job);
      } else {
        invalid += 1;
      }
    }
  }

  return { jobs, drained, invalid };
}

export class WebhookInboxSource extends BaseSource {
  constructor() {
    super({
      name: SOURCE_NAME,
      rateCapacity: 50,
      rateRefillPerSecond: 25,
      breaker: { failureThreshold: 8, cooldownMs: 30_000 },
      cooldownBaseMs: 15_000,
      cooldownMaxMs: 5 * 60_000,
    });
  }

  override isEnabled(): boolean {
    return isSourceSelected(SOURCE_NAME, SOURCE_ALIASES);
  }

  protected override async run(ctx: SourceContext): Promise<SourceResult> {
    const result = await drainInbox(ctx.limit);

    const byKey = new Map<string, RawJob>();
    let newest: Date | null = null;
    for (const job of result.jobs) {
      byKey.set(`${job.source}::${job.externalId}`, job);
      if (job.postedAt && (newest === null || job.postedAt.getTime() > newest.getTime())) {
        newest = job.postedAt;
      }
    }

    const remaining = await inboxDepth();

    return {
      jobs: Array.from(byKey.values()),
      cursor: newest ? toIso(newest) : ctx.cursor,
      meta: {
        drained: result.drained,
        invalid: result.invalid,
        remaining,
      },
    };
  }
}

export const webhookInboxSource = new WebhookInboxSource();
