/**
 * The detection loop.
 *
 * For every active profile it builds one SourceContext, fans out across the
 * enabled sources, and folds the merged results into the Job table. Anything
 * new or materially changed is queued for scoring within the same tick, which
 * is what keeps time-to-proposal in the seconds-to-minutes range.
 */

import { Prisma } from '@prisma/client';
import type { Profile } from '@prisma/client';
import pLimit from 'p-limit';
import { env } from '../config/env';
import { hashJobContent } from '../lib/hash';
import { toErrorMessage } from '../lib/errors';
import { child } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { incrementCounter, withLock } from '../lib/redis';
import { dayBucket, hourBucket, minutesAgo, secondsUntilEndOfDay, toIso } from '../lib/time';
import { notifySystemAlert } from '../notify';
import { fetchAllSources, type SourceRunSummary } from '../sources/registry';
import type { RawJob, SourceContext } from '../types';
import {
  PRIORITY,
  addScoreJob,
  type DiscoverJobData,
  type DiscoverLane,
} from '../queue/queues';

const log = child('worker:discover');

/** Profiles that only care about very fresh postings ride the fast lane. */
export const FAST_LANE_MAX_JOB_AGE_MINUTES = 30;

/** Pseudo-source name for the per-profile run checkpoint. Real sources own their own rows. */
export const DISCOVER_CHECKPOINT_SOURCE = 'discover';

/** One ingest sweep must never outlive this, or the lock would wedge the lane. */
export const DISCOVER_LOCK_TTL_MS = 5 * 60_000;

/** Upper bound on search terms per profile so one profile cannot exhaust an API budget. */
export const MAX_QUERIES_PER_PROFILE = 12;

/** Statuses that mean "this job has never been scored", so it must be re-queued. */
const UNSCORED_STATUSES = new Set<string>(['NEW']);

/** A changed posting goes back to NEW unless it already produced a submission. */
const KEEP_STATUS_ON_CHANGE = new Set<string>(['SUBMITTED']);

const SOURCE_ALERT_WINDOW_SECONDS = 3600;

const INGEST_CONCURRENCY = 4;

export type IngestOutcome = 'created' | 'changed' | 'unchanged';

export interface DiscoverProfileSummary {
  profileId: string;
  profileName: string;
  fetched: number;
  created: number;
  changed: number;
  unchanged: number;
  enqueued: number;
  errors: number;
  durationMs: number;
  skipped?: string;
  perSource: SourceRunSummary[];
}

export interface DiscoverSummary {
  lane: DiscoverLane;
  profiles: number;
  fetched: number;
  created: number;
  changed: number;
  enqueued: number;
  durationMs: number;
  results: DiscoverProfileSummary[];
}

/* ------------------------------------------------------------------ helpers */

function toInputJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(JSON.stringify(value));
    if (parsed === undefined || parsed === null) return undefined;
    if (typeof parsed !== 'object') return { value: parsed } as Prisma.InputJsonValue;
    return parsed as Prisma.InputJsonValue;
  } catch {
    return undefined;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

async function recordMetric(name: string, by = 1): Promise<void> {
  if (!env.METRICS_ENABLED || by === 0) return;
  try {
    await incrementCounter(`metrics:${name}:${dayBucket()}`, secondsUntilEndOfDay(), by);
  } catch (err) {
    log.debug({ err, metric: name }, 'metric increment failed');
  }
}

/** Search terms: explicit queries first, then include keywords as a fallback net. */
export function buildQueries(profile: Profile): string[] {
  const merged = [...profile.searchQueries, ...profile.includeKeywords]
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return Array.from(new Set(merged)).slice(0, MAX_QUERIES_PER_PROFILE);
}

export function buildSourceContext(profile: Profile): SourceContext {
  const ageMinutes = Math.min(Math.max(profile.maxJobAgeMinutes, 5), 7 * 24 * 60);
  return {
    profileId: profile.id,
    profileName: profile.name,
    queries: buildQueries(profile),
    // A floor only: BaseSource raises it to its own checkpoint when it has one.
    since: minutesAgo(ageMinutes),
    cursor: null,
    limit: env.MAX_JOBS_PER_POLL,
  };
}

async function selectProfiles(data: DiscoverJobData): Promise<Profile[]> {
  const where: Prisma.ProfileWhereInput = { isActive: true };
  if (data.profileId) where.id = data.profileId;
  if (data.lane === 'fast') {
    where.maxJobAgeMinutes = { lte: FAST_LANE_MAX_JOB_AGE_MINUTES };
  }
  return prisma.profile.findMany({ where, orderBy: { createdAt: 'asc' } });
}

/* ---------------------------------------------------------------- ingestion */

function createData(raw: RawJob, contentHash: string, at: Date): Prisma.JobCreateInput {
  const rawJson = toInputJson(raw.raw);
  return {
    source: raw.source,
    externalId: raw.externalId,
    url: raw.url,
    title: raw.title,
    description: raw.description,
    skills: raw.skills,
    category: raw.category,
    subcategory: raw.subcategory,
    jobType: raw.jobType,
    budgetAmount: raw.budgetAmount,
    hourlyMin: raw.hourlyMin,
    hourlyMax: raw.hourlyMax,
    currency: raw.currency ?? 'USD',
    durationLabel: raw.durationLabel,
    experienceLevel: raw.experienceLevel,
    workload: raw.workload,
    connectsRequired: raw.connectsRequired,
    proposalsCount: raw.proposalsCount,
    interviewingCount: raw.interviewingCount,
    clientCountry: raw.client.country,
    clientCity: raw.client.city,
    clientPaymentVerified: raw.client.paymentVerified,
    clientTotalSpent: raw.client.totalSpent,
    clientTotalHires: raw.client.totalHires,
    clientHireRate: raw.client.hireRate,
    clientAvgRating: raw.client.avgRating,
    clientReviewsCount: raw.client.reviewsCount,
    clientMemberSince: raw.client.memberSince,
    clientOpenJobs: raw.client.openJobs,
    screeningQuestions: raw.screeningQuestions,
    postedAt: raw.postedAt,
    firstSeenAt: at,
    lastSeenAt: at,
    contentHash,
    status: 'NEW',
    ...(rawJson === undefined ? {} : { raw: rawJson }),
  };
}

/**
 * Everything a re-crawl may legitimately change. firstSeenAt is deliberately
 * absent: it is the detection latency record and must never move.
 */
function changedData(
  raw: RawJob,
  contentHash: string,
  at: Date,
  currentStatus: string,
): Prisma.JobUpdateInput {
  const rawJson = toInputJson(raw.raw);
  return {
    url: raw.url,
    title: raw.title,
    description: raw.description,
    skills: raw.skills,
    category: raw.category,
    subcategory: raw.subcategory,
    jobType: raw.jobType,
    budgetAmount: raw.budgetAmount,
    hourlyMin: raw.hourlyMin,
    hourlyMax: raw.hourlyMax,
    currency: raw.currency ?? 'USD',
    durationLabel: raw.durationLabel,
    experienceLevel: raw.experienceLevel,
    workload: raw.workload,
    connectsRequired: raw.connectsRequired,
    proposalsCount: raw.proposalsCount,
    interviewingCount: raw.interviewingCount,
    clientCountry: raw.client.country,
    clientCity: raw.client.city,
    clientPaymentVerified: raw.client.paymentVerified,
    clientTotalSpent: raw.client.totalSpent,
    clientTotalHires: raw.client.totalHires,
    clientHireRate: raw.client.hireRate,
    clientAvgRating: raw.client.avgRating,
    clientReviewsCount: raw.client.reviewsCount,
    clientMemberSince: raw.client.memberSince,
    clientOpenJobs: raw.client.openJobs,
    screeningQuestions: raw.screeningQuestions,
    postedAt: raw.postedAt,
    lastSeenAt: at,
    contentHash,
    // A rewritten posting is a new decision, so send it back through scoring
    // unless we already committed a proposal to it.
    status: KEEP_STATUS_ON_CHANGE.has(currentStatus) ? currentStatus : 'NEW',
    ...(rawJson === undefined ? {} : { raw: rawJson }),
  };
}

export interface IngestResult {
  outcome: IngestOutcome;
  jobId: string;
  contentHash: string;
  /** True when the row still needs a first score (new, changed, or never scored). */
  needsScoring: boolean;
}

/**
 * Idempotent upsert of one posting. Re-running it with the same payload only
 * bumps lastSeenAt, so an overlapping poll costs a single UPDATE.
 */
export async function ingestJob(raw: RawJob, at: Date = new Date()): Promise<IngestResult> {
  const contentHash = hashJobContent({
    title: raw.title,
    description: raw.description,
    budgetAmount: raw.budgetAmount,
    hourlyMin: raw.hourlyMin,
    hourlyMax: raw.hourlyMax,
    jobType: raw.jobType,
    skills: raw.skills,
    screeningQuestions: raw.screeningQuestions,
  });

  const where: Prisma.JobWhereUniqueInput = {
    source_externalId: { source: raw.source, externalId: raw.externalId },
  };

  const existing = await prisma.job.findUnique({
    where,
    select: { id: true, contentHash: true, status: true },
  });

  if (!existing) {
    try {
      const created = await prisma.job.create({
        data: createData(raw, contentHash, at),
        select: { id: true },
      });
      return { outcome: 'created', jobId: created.id, contentHash, needsScoring: true };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Another worker won the race; fall through and treat it as an update.
      const raced = await prisma.job.findUnique({
        where,
        select: { id: true, contentHash: true, status: true },
      });
      if (!raced) throw err;
      return updateExisting(raw, contentHash, at, raced);
    }
  }

  return updateExisting(raw, contentHash, at, existing);
}

async function updateExisting(
  raw: RawJob,
  contentHash: string,
  at: Date,
  existing: { id: string; contentHash: string; status: string },
): Promise<IngestResult> {
  if (existing.contentHash !== contentHash) {
    await prisma.job.update({
      where: { id: existing.id },
      data: changedData(raw, contentHash, at, existing.status),
    });
    return { outcome: 'changed', jobId: existing.id, contentHash, needsScoring: true };
  }

  // Volatile counters are excluded from the content hash on purpose, but they
  // still drive the competition score, so refresh them on every sighting. Only
  // when the source actually reported them: a leaner view of the same posting
  // must not erase numbers a richer one already gave us.
  await prisma.job.update({
    where: { id: existing.id },
    data: {
      lastSeenAt: at,
      ...(raw.proposalsCount === null ? {} : { proposalsCount: raw.proposalsCount }),
      ...(raw.interviewingCount === null ? {} : { interviewingCount: raw.interviewingCount }),
    },
  });

  return {
    outcome: 'unchanged',
    jobId: existing.id,
    contentHash,
    // Self-healing: a job that was ingested but whose score job was lost still
    // sits at NEW, so re-queue it instead of stranding it forever.
    needsScoring: UNSCORED_STATUSES.has(existing.status),
  };
}

/* --------------------------------------------------------------- alerting */

/**
 * One alert per source per hour. The Redis counter is created with the window
 * TTL on its first increment, so only the first failure in a window notifies.
 */
async function alertSourceFailure(source: string, detail: string): Promise<void> {
  try {
    const count = await incrementCounter(
      `alert:source:${source}`,
      SOURCE_ALERT_WINDOW_SECONDS,
      1,
    );
    if (count !== 1) return;
  } catch (err) {
    log.warn({ err, source }, 'could not rate-limit the source alert; sending anyway');
  }

  try {
    await notifySystemAlert({
      kind: 'SOURCE_FAILING',
      component: source,
      severity: 'WARN',
      detail:
        `Detection through "${source}" failed and returned no jobs: ${detail}. ` +
        'The other sources keep running.',
      facts: [{ label: 'Alert window', value: 'once per hour per source' }],
      refId: source,
    });
  } catch (err) {
    log.error({ err, source }, 'failed to send source failure alert');
  }
}

/* ------------------------------------------------------------- checkpoints */

async function updateRunCheckpoint(
  profileId: string,
  summary: DiscoverProfileSummary,
  lastItemAt: Date | null,
  ok: boolean,
  at: Date,
): Promise<void> {
  const state = toInputJson({
    sources: summary.perSource.map((entry) => `${entry.name}:${entry.count}`),
    fetched: summary.fetched,
    created: summary.created,
    changed: summary.changed,
    unchanged: summary.unchanged,
    enqueued: summary.enqueued,
    errors: summary.errors,
    durationMs: summary.durationMs,
    perSource: summary.perSource,
    at: toIso(at),
  });

  try {
    const existing = await prisma.sourceCheckpoint.findFirst({
      where: { source: DISCOVER_CHECKPOINT_SOURCE, profileId },
      select: { id: true },
    });

    if (!existing) {
      await prisma.sourceCheckpoint.create({
        data: {
          source: DISCOVER_CHECKPOINT_SOURCE,
          profileId,
          lastRunAt: at,
          lastSuccessAt: ok ? at : null,
          lastItemAt,
          consecutiveFailures: ok ? 0 : 1,
          ...(state === undefined ? {} : { state }),
        },
      });
      return;
    }

    await prisma.sourceCheckpoint.update({
      where: { id: existing.id },
      data: {
        lastRunAt: at,
        ...(ok
          ? { lastSuccessAt: at, consecutiveFailures: 0 }
          : { consecutiveFailures: { increment: 1 } }),
        ...(lastItemAt ? { lastItemAt } : {}),
        ...(state === undefined ? {} : { state }),
      },
    });
  } catch (err) {
    // The checkpoint is observability, not correctness: never fail a sweep on it.
    log.warn({ err, profileId }, 'failed to update discover checkpoint');
  }
}

/* ------------------------------------------------------------- profile run */

async function discoverForProfile(
  profile: Profile,
  lane: DiscoverLane,
): Promise<DiscoverProfileSummary> {
  const startedAt = Date.now();
  const base: DiscoverProfileSummary = {
    profileId: profile.id,
    profileName: profile.name,
    fetched: 0,
    created: 0,
    changed: 0,
    unchanged: 0,
    enqueued: 0,
    errors: 0,
    durationMs: 0,
    perSource: [],
  };

  // Per-profile lock: the fast and standard lanes overlap by design, and this is
  // what stops the same posting being ingested twice at the same instant.
  const result = await withLock(`discover:profile:${profile.id}`, DISCOVER_LOCK_TTL_MS, async () => {
    const ctx = buildSourceContext(profile);
    const sweep = await fetchAllSources(ctx);
    const at = new Date();

    base.perSource = sweep.perSource;
    base.fetched = sweep.jobs.length;

    const limit = pLimit(INGEST_CONCURRENCY);
    let lastItemAt: Date | null = null;

    const ingested = await Promise.all(
      sweep.jobs.map((raw) =>
        limit(async (): Promise<IngestResult | null> => {
          try {
            const outcome = await ingestJob(raw, at);
            if (raw.postedAt && (!lastItemAt || raw.postedAt > lastItemAt)) {
              lastItemAt = raw.postedAt;
            }
            return outcome;
          } catch (err) {
            base.errors += 1;
            log.error(
              { err, source: raw.source, externalId: raw.externalId },
              'failed to ingest job',
            );
            return null;
          }
        }),
      ),
    );

    for (const entry of ingested) {
      if (!entry) continue;
      if (entry.outcome === 'created') base.created += 1;
      else if (entry.outcome === 'changed') base.changed += 1;
      else base.unchanged += 1;

      if (!entry.needsScoring) continue;

      try {
        // The queue de-duplicates on the fingerprint. For a job that is simply
        // still unscored (its first score job was lost) the hour bucket lets it
        // be retried at most once an hour instead of never.
        const fingerprint =
          entry.outcome === 'unchanged'
            ? `${entry.contentHash}:${hourBucket()}`
            : entry.contentHash;
        await addScoreJob(
          { jobId: entry.jobId, profileId: profile.id },
          {
            contentHash: fingerprint,
            // Freshest first: a brand new posting is the one worth racing on.
            priority: entry.outcome === 'created' ? PRIORITY.hot : PRIORITY.normal,
          },
        );
        base.enqueued += 1;
      } catch (err) {
        base.errors += 1;
        log.error({ err, jobId: entry.jobId, profileId: profile.id }, 'failed to enqueue score job');
      }
    }

    const failedSources = sweep.perSource.filter((entry) => Boolean(entry.error));
    for (const failure of failedSources) {
      await alertSourceFailure(failure.name, failure.error ?? 'unknown error');
    }

    // The run counts as a success as long as something produced results; a
    // single dead source must not mark the whole profile's detection as broken.
    const anySourceSucceeded =
      sweep.perSource.length === 0 || failedSources.length < sweep.perSource.length;

    base.durationMs = Date.now() - startedAt;
    await updateRunCheckpoint(profile.id, base, lastItemAt, anySourceSucceeded, at);

    log.info(
      {
        profileId: profile.id,
        profile: profile.name,
        lane,
        fetched: base.fetched,
        created: base.created,
        changed: base.changed,
        unchanged: base.unchanged,
        enqueued: base.enqueued,
        duplicates: sweep.duplicates,
        errors: base.errors,
        durationMs: base.durationMs,
        perSource: sweep.perSource.map((entry) => ({
          name: entry.name,
          count: entry.count,
          ms: entry.ms,
          ...(entry.error ? { error: entry.error } : {}),
          ...(entry.skipped ? { skipped: entry.skipped } : {}),
        })),
      },
      'discovery sweep finished',
    );

    return base;
  });

  if (result) return result;

  base.durationMs = Date.now() - startedAt;
  base.skipped = 'another worker is already polling this profile';
  log.debug({ profileId: profile.id, lane }, 'discover skipped: profile lock busy');
  return base;
}

/* ----------------------------------------------------------------- the job */

/**
 * Processes one discover tick. Never throws for a single profile's failure -
 * one dead source or one bad row must not stop the other profiles.
 */
export async function runDiscover(data: DiscoverJobData): Promise<DiscoverSummary> {
  const startedAt = Date.now();
  const lane: DiscoverLane = data.lane === 'fast' ? 'fast' : 'standard';

  const summary: DiscoverSummary = {
    lane,
    profiles: 0,
    fetched: 0,
    created: 0,
    changed: 0,
    enqueued: 0,
    durationMs: 0,
    results: [],
  };

  const profiles = await selectProfiles(data);
  summary.profiles = profiles.length;

  if (profiles.length === 0) {
    summary.durationMs = Date.now() - startedAt;
    log.debug({ lane, profileId: data.profileId ?? null }, 'no active profiles matched this lane');
    return summary;
  }

  for (const profile of profiles) {
    try {
      const result = await discoverForProfile(profile, lane);
      summary.results.push(result);
      summary.fetched += result.fetched;
      summary.created += result.created;
      summary.changed += result.changed;
      summary.enqueued += result.enqueued;
    } catch (err) {
      log.error(
        { err, profileId: profile.id, profile: profile.name, lane },
        'discovery failed for a profile',
      );
      summary.results.push({
        profileId: profile.id,
        profileName: profile.name,
        fetched: 0,
        created: 0,
        changed: 0,
        unchanged: 0,
        enqueued: 0,
        errors: 1,
        durationMs: 0,
        skipped: toErrorMessage(err),
        perSource: [],
      });
    }
  }

  summary.durationMs = Date.now() - startedAt;

  await Promise.all([
    recordMetric('jobs.seen', summary.fetched),
    recordMetric('jobs.created', summary.created),
    recordMetric('jobs.changed', summary.changed),
    recordMetric(`discover.${lane}.ticks`, 1),
  ]);

  log.info(
    {
      lane,
      profiles: summary.profiles,
      fetched: summary.fetched,
      created: summary.created,
      changed: summary.changed,
      enqueued: summary.enqueued,
      durationMs: summary.durationMs,
    },
    'discover tick complete',
  );

  return summary;
}

/** Exposed for the API's "poll now" button. */
export async function discoverProfileNow(profileId: string): Promise<DiscoverSummary> {
  return runDiscover({ lane: 'standard', profileId, reason: 'manual' });
}
