/**
 * Source registry. Owns the singleton instances, decides which ones the
 * operator turned on, and runs them concurrently for a single poll tick.
 */

import pLimit from 'p-limit';
import { env, sourcesEnabled } from '../config/env';
import { getRuntimeConfig } from '../config/runtime';
import { toErrorMessage } from '../lib/errors';
import { child } from '../lib/logger';
import type { JobSource, RawJob, SourceContext, SourceResult } from '../types';
import { BaseSource } from './base';
import { dedupeSourceKey, dedupeUrlKey } from './normalize';
import { imapSource, ImapSource } from './email-imap';
import { rssSource } from './rss';
import { upworkGraphqlSource } from './upwork-graphql';
import { webhookInboxSource } from './webhook-inbox';

const log = child('sources:registry');

const MAX_CONCURRENT_SOURCES = 4;

/** Every source instance, whether or not it is currently enabled. */
const REGISTRY: readonly BaseSource[] = [
  upworkGraphqlSource,
  rssSource,
  imapSource,
  webhookInboxSource,
] as const;

export function allSources(): BaseSource[] {
  return [...REGISTRY];
}

export function getSourceByName(name: string): BaseSource | undefined {
  const wanted = name.trim().toLowerCase();
  return REGISTRY.find((source) => source.name.toLowerCase() === wanted);
}

/** Instances that are both selected in SOURCES and fully configured. */
export function getEnabledSources(): JobSource[] {
  return REGISTRY.filter((source) => source.isEnabled());
}

export interface SourceDescription {
  name: string;
  enabled: boolean;
  selected: boolean;
}

/** Per-source status for /health and the dashboard. */
export function describeSources(): SourceDescription[] {
  const selected = new Set(sourcesEnabled.map((entry) => entry.trim().toLowerCase()));
  return REGISTRY.map((source) => ({
    name: source.name,
    enabled: source.isEnabled(),
    selected: selected.has(source.name.toLowerCase()),
  }));
}

export function sourceSnapshots(): ReturnType<BaseSource['snapshot']>[] {
  return REGISTRY.map((source) => source.snapshot());
}

/** Starts long-lived watchers (currently only IMAP IDLE). Never throws. */
export async function startSourceWatchers(): Promise<string[]> {
  const started: string[] = [];
  // isEnabled() reads the runtime config synchronously, so it has to be loaded
  // once before the check or a mailbox configured only in the dashboard would
  // not get its watcher until the next restart. This never rejects.
  await getRuntimeConfig();

  for (const source of REGISTRY) {
    if (!(source instanceof ImapSource)) continue;
    if (!source.isEnabled()) continue;
    try {
      await source.startWatching();
      started.push(source.name);
    } catch (err) {
      log.warn({ err, source: source.name }, 'failed to start source watcher');
    }
  }
  return started;
}

export async function stopSourceWatchers(): Promise<void> {
  for (const source of REGISTRY) {
    if (!(source instanceof ImapSource)) continue;
    try {
      await source.stopWatching();
    } catch (err) {
      log.warn({ err, source: source.name }, 'failed to stop source watcher');
    }
  }
}

export interface SourceRunSummary {
  name: string;
  count: number;
  ms: number;
  error?: string;
  skipped?: string;
}

export interface FetchAllResult {
  jobs: RawJob[];
  perSource: SourceRunSummary[];
  duplicates: number;
  cursors: Record<string, string | null>;
}

function metaString(meta: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = meta?.[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Ranks two views of the same posting so cross-source dedupe keeps the richest
 * record (the API payload usually beats the RSS summary of the same job).
 */
function completeness(job: RawJob): number {
  let score = job.description.length;
  if (job.skills.length > 0) score += 200;
  if (job.screeningQuestions.length > 0) score += 300;
  if (job.budgetAmount !== null || job.hourlyMin !== null) score += 150;
  if (job.client.paymentVerified !== null) score += 100;
  if (job.client.totalSpent !== null) score += 100;
  if (job.proposalsCount !== null) score += 50;
  if (job.postedAt !== null) score += 50;
  return score;
}

/**
 * Runs every enabled source concurrently and merges the results.
 * Deduped twice: once per (source, externalId) and once by canonical URL, so
 * the same posting arriving via API, RSS and email lands as one job.
 */
export async function fetchAllSources(ctx: SourceContext): Promise<FetchAllResult> {
  const sources = getEnabledSources();
  if (sources.length === 0) {
    log.warn({ configured: sourcesEnabled }, 'no job sources are enabled');
    return { jobs: [], perSource: [], duplicates: 0, cursors: {} };
  }

  const limit = pLimit(Math.max(1, Math.min(MAX_CONCURRENT_SOURCES, sources.length)));
  const perSourceLimit = Math.max(1, Math.min(ctx.limit || env.MAX_JOBS_PER_POLL, 1000));

  const settled = await Promise.all(
    sources.map((source) =>
      limit(async (): Promise<{ name: string; ms: number; result: SourceResult | null; error?: string }> => {
        const startedAt = Date.now();
        try {
          const result = await source.fetch({ ...ctx, limit: perSourceLimit });
          return { name: source.name, ms: Date.now() - startedAt, result };
        } catch (err) {
          // BaseSource.fetch already swallows failures; this guards any source
          // implemented outside that base class.
          const error = toErrorMessage(err);
          log.error({ err, source: source.name }, 'source threw out of fetch');
          return { name: source.name, ms: Date.now() - startedAt, result: null, error };
        }
      }),
    ),
  );

  const perSource: SourceRunSummary[] = [];
  const cursors: Record<string, string | null> = {};
  const bySourceKey = new Map<string, RawJob>();
  let duplicates = 0;

  for (const entry of settled) {
    const meta = entry.result?.meta;
    const error = entry.error ?? metaString(meta, 'error');
    const skipped = metaString(meta, 'skipped');

    const jobs = entry.result?.jobs ?? [];
    for (const job of jobs) {
      const key = dedupeSourceKey(job);
      if (bySourceKey.has(key)) {
        duplicates += 1;
        continue;
      }
      bySourceKey.set(key, job);
    }

    cursors[entry.name] = entry.result?.cursor ?? null;
    perSource.push({
      name: entry.name,
      count: jobs.length,
      ms: entry.ms,
      ...(error ? { error } : {}),
      ...(skipped ? { skipped } : {}),
    });
  }

  const byUrl = new Map<string, RawJob>();
  for (const job of bySourceKey.values()) {
    const key = dedupeUrlKey(job);
    const existing = byUrl.get(key);
    if (!existing) {
      byUrl.set(key, job);
      continue;
    }
    duplicates += 1;
    if (completeness(job) > completeness(existing)) byUrl.set(key, job);
  }

  const jobs = Array.from(byUrl.values()).sort((a, b) => {
    const left = a.postedAt ? a.postedAt.getTime() : 0;
    const right = b.postedAt ? b.postedAt.getTime() : 0;
    return right - left;
  });

  log.debug(
    { count: jobs.length, duplicates, sources: perSource.map((entry) => `${entry.name}:${entry.count}`) },
    'source sweep complete',
  );

  return { jobs, perSource, duplicates, cursors };
}

export { imapSource, rssSource, upworkGraphqlSource, webhookInboxSource };
