/**
 * Housekeeping. Runs every 15 minutes and is the reason the system can be left
 * alone: it retires dead rows, keeps the tables from growing without bound,
 * repairs quota state after a Redis eviction, unsticks half-finished
 * submissions and shouts when a source has quietly stopped producing.
 *
 * Every step is independent and individually guarded - one failing step must
 * not stop the others.
 */

import { Prisma } from '@prisma/client';
import { env, publicUrl } from '../config/env';
import { toErrorMessage } from '../lib/errors';
import { child } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { getCounter, incrementCounter, redis, withLock } from '../lib/redis';
import {
  daysAgo,
  hoursAgo,
  intervalMs,
  minutesAgo,
  secondsUntilEndOfDay,
  toIso,
} from '../lib/time';
import { notifyDailyDigest, notifySystemAlert } from '../notify';
import { getEnabledSources } from '../sources/registry';
import { connectsDayKey } from '../submit';
import type { PipelineStats } from '../types';

const log = child('worker:maintenance');

/** Nothing older than this is worth bidding on, whatever its status says. */
export const JOB_MAX_AGE_HOURS = 168;

/** A posting we stopped seeing this long ago has almost certainly been closed. */
export const JOB_UNSEEN_HOURS = 48;

export const PENDING_APPROVAL_TTL_HOURS = 24;
export const LOG_RETENTION_DAYS = 90;
export const STUCK_SUBMITTING_MINUTES = 15;
export const SOURCE_STALENESS_MULTIPLIER = 3;
export const MIN_SOURCE_STALENESS_MS = 5 * 60_000;

export const MAINTENANCE_LOCK_TTL_MS = 10 * 60_000;

const SOURCE_ALERT_WINDOW_SECONDS = 3600;

/** Mirrors the key prefix used by incrementCounter/getCounter in lib/redis. */
const COUNTER_PREFIX = 'upbid:counter:';

const ACTIVE_JOB_STATUSES = ['NEW', 'SCORED', 'DRAFTED', 'QUEUED'];

const EXPIRE_BATCH = 500;
const RECONCILE_BATCH = 200;

export interface MaintenanceReport {
  jobsExpired: number;
  proposalsExpired: number;
  notificationsPruned: number;
  auditsPruned: number;
  ledgerRowsFixed: number;
  countersReconciled: number;
  submissionsReconciled: number;
  staleSources: string[];
  errors: string[];
  durationMs: number;
  skipped?: string;
}

function emptyReport(): MaintenanceReport {
  return {
    jobsExpired: 0,
    proposalsExpired: 0,
    notificationsPruned: 0,
    auditsPruned: 0,
    ledgerRowsFixed: 0,
    countersReconciled: 0,
    submissionsReconciled: 0,
    staleSources: [],
    errors: [],
    durationMs: 0,
  };
}

async function step<T>(
  report: MaintenanceReport,
  name: string,
  fn: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const message = toErrorMessage(err);
    log.error({ err, step: name }, 'maintenance step failed');
    report.errors.push(`${name}: ${message}`);
    return fallback;
  }
}

/* -------------------------------------------------------------- expiration */

/** Retires postings that aged out or stopped appearing in any source. */
export async function expireStaleJobs(at: Date = new Date()): Promise<number> {
  const ageCutoff = hoursAgo(JOB_MAX_AGE_HOURS, at);
  const unseenCutoff = hoursAgo(JOB_UNSEEN_HOURS, at);

  const result = await prisma.job.updateMany({
    where: {
      status: { in: ACTIVE_JOB_STATUSES },
      OR: [
        { postedAt: { lt: ageCutoff } },
        { AND: [{ postedAt: null }, { firstSeenAt: { lt: ageCutoff } }] },
        { lastSeenAt: { lt: unseenCutoff } },
      ],
    },
    data: { status: 'EXPIRED' },
  });

  if (result.count > 0) {
    log.info({ expired: result.count, ageCutoff: toIso(ageCutoff) }, 'expired stale jobs');
  }
  return result.count;
}

/**
 * A proposal waiting for a tap for a full day is dead: the posting has moved on
 * and submitting it now would be worse than not bidding.
 */
export async function expireStaleProposals(at: Date = new Date()): Promise<number> {
  const cutoff = hoursAgo(PENDING_APPROVAL_TTL_HOURS, at);

  const stale = await prisma.proposal.findMany({
    where: { status: 'PENDING_APPROVAL', createdAt: { lt: cutoff } },
    select: { id: true },
    take: EXPIRE_BATCH,
  });
  if (stale.length === 0) return 0;

  const ids = stale.map((row) => row.id);
  const updated = await prisma.proposal.updateMany({
    where: { id: { in: ids }, status: 'PENDING_APPROVAL' },
    data: { status: 'EXPIRED' },
  });

  try {
    await prisma.auditEvent.createMany({
      data: ids.map((id) => ({
        actor: 'system',
        action: 'proposal.expired',
        refType: 'proposal',
        refId: id,
        details: {
          reason: `pending approval for more than ${PENDING_APPROVAL_TTL_HOURS}h`,
        } as Prisma.InputJsonValue,
      })),
    });
  } catch (err) {
    log.warn({ err, count: ids.length }, 'failed to audit expired proposals');
  }

  log.info({ expired: updated.count }, 'expired stale pending-approval proposals');
  return updated.count;
}

/* ------------------------------------------------------------------ pruning */

export async function pruneLogs(
  at: Date = new Date(),
): Promise<{ notifications: number; audits: number }> {
  const cutoff = daysAgo(LOG_RETENTION_DAYS, at);
  const [notifications, audits] = await Promise.all([
    prisma.notificationLog.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    prisma.auditEvent.deleteMany({ where: { createdAt: { lt: cutoff } } }),
  ]);

  if (notifications.count > 0 || audits.count > 0) {
    log.info(
      { notifications: notifications.count, audits: audits.count, cutoff: toIso(cutoff) },
      'pruned old log rows',
    );
  }
  return { notifications: notifications.count, audits: audits.count };
}

/* ------------------------------------------------------------ connects ledger */

function startOfUtcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

export interface LedgerReconciliation {
  rowsFixed: number;
  countersReconciled: number;
}

/**
 * The ledger is the durable record; the Redis counter is a cache that can be
 * evicted or flushed. This recomputes today's running balance from the ledger,
 * backfills balanceAfter, and raises the counter if it drifted low - never
 * lowers it, because an under-count would hand out free quota.
 */
export async function reconcileConnectsLedger(
  at: Date = new Date(),
): Promise<LedgerReconciliation> {
  const profiles = await prisma.profile.findMany({
    where: { isActive: true },
    select: { id: true, name: true, maxDailyConnects: true },
  });

  const dayStart = startOfUtcDay(at);
  let rowsFixed = 0;
  let countersReconciled = 0;

  for (const profile of profiles) {
    const rows = await prisma.connectsLedger.findMany({
      where: { profileId: profile.id, createdAt: { gte: dayStart } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, delta: true, balanceAfter: true },
    });

    let spent = 0;
    for (const row of rows) {
      if (row.delta < 0) spent += -row.delta;
      const expected = profile.maxDailyConnects - spent;
      if (row.balanceAfter === expected) continue;
      try {
        await prisma.connectsLedger.update({
          where: { id: row.id },
          data: { balanceAfter: expected },
        });
        rowsFixed += 1;
      } catch (err) {
        log.warn({ err, ledgerId: row.id }, 'failed to correct a connects ledger balance');
      }
    }

    const bucketKey = connectsDayKey(profile.id, at);
    try {
      const counter = await getCounter(bucketKey);
      if (counter < spent) {
        await redis.set(
          `${COUNTER_PREFIX}${bucketKey}`,
          String(spent),
          'EX',
          secondsUntilEndOfDay(at),
        );
        countersReconciled += 1;
        log.warn(
          { profileId: profile.id, profile: profile.name, counter, ledgerSpend: spent },
          'connects counter was behind the ledger; raised it',
        );
      }
    } catch (err) {
      log.warn({ err, profileId: profile.id }, 'failed to reconcile the connects counter');
    }
  }

  return { rowsFixed, countersReconciled };
}

/* ------------------------------------------------------ stuck submissions */

/**
 * A proposal left in SUBMITTING means a worker died mid-dispatch. If a
 * successful Submission row exists the outcome is known and the proposal just
 * needs the status; otherwise it is failed so a human can decide.
 */
export async function reconcileStuckSubmissions(at: Date = new Date()): Promise<number> {
  const cutoff = minutesAgo(STUCK_SUBMITTING_MINUTES, at);

  const stuck = await prisma.proposal.findMany({
    where: { status: 'SUBMITTING', updatedAt: { lt: cutoff } },
    select: { id: true, jobId: true, profileId: true },
    take: RECONCILE_BATCH,
  });
  if (stuck.length === 0) return 0;

  const failed: { proposalId: string; jobId: string }[] = [];
  let reconciled = 0;

  for (const proposal of stuck) {
    try {
      const submitted = await prisma.submission.findFirst({
        where: { proposalId: proposal.id, status: 'SUBMITTED' },
        orderBy: { createdAt: 'desc' },
        select: { id: true, connectsSpent: true, externalRef: true },
      });

      if (submitted) {
        await prisma.proposal.update({
          where: { id: proposal.id },
          data: { status: 'SUBMITTED', connectsCost: submitted.connectsSpent ?? undefined },
        });
        await prisma.job
          .update({ where: { id: proposal.jobId }, data: { status: 'SUBMITTED' } })
          .catch((err: unknown) => {
            log.warn({ err, jobId: proposal.jobId }, 'could not mark job as submitted');
          });
        await recordAudit('proposal.reconciled_submitted', proposal.id, {
          submissionId: submitted.id,
          externalRef: submitted.externalRef,
        });
      } else {
        await prisma.proposal.update({
          where: { id: proposal.id },
          data: { status: 'FAILED' },
        });
        await recordAudit('proposal.reconciled_failed', proposal.id, {
          reason: `stuck in SUBMITTING for more than ${STUCK_SUBMITTING_MINUTES} minutes`,
        });
        failed.push({ proposalId: proposal.id, jobId: proposal.jobId });
      }
      reconciled += 1;
    } catch (err) {
      log.error({ err, proposalId: proposal.id }, 'failed to reconcile a stuck submission');
    }
  }

  if (failed.length > 0) {
    await sendStuckAlert(failed);
  }

  log.warn({ reconciled, failed: failed.length }, 'reconciled proposals stuck in SUBMITTING');
  return reconciled;
}

async function sendStuckAlert(failed: { proposalId: string; jobId: string }[]): Promise<void> {
  try {
    await notifySystemAlert({
      kind: 'DEGRADED',
      component: 'submit',
      severity: 'CRITICAL',
      detail:
        `${failed.length} proposal${failed.length > 1 ? 's' : ''} sat in SUBMITTING for more than ` +
        `${STUCK_SUBMITTING_MINUTES} minutes with no recorded outcome and were marked failed. ` +
        'Check the job pages before re-submitting: a submission may have landed anyway.',
      facts: failed.slice(0, 10).map((entry) => ({
        label: 'Proposal',
        value: publicUrl(`/#/proposals/${entry.proposalId}`),
      })),
      refId: 'stuck-submissions',
    });
  } catch (err) {
    log.error({ err }, 'failed to send stuck submission alert');
  }
}

async function recordAudit(
  action: string,
  proposalId: string,
  details: Record<string, unknown>,
): Promise<void> {
  try {
    await prisma.auditEvent.create({
      data: {
        actor: 'maintenance',
        action,
        refType: 'proposal',
        refId: proposalId,
        details: JSON.parse(JSON.stringify(details)) as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    log.warn({ err, action, proposalId }, 'failed to write maintenance audit event');
  }
}

/* ------------------------------------------------------- source freshness */

export interface SourceFreshness {
  source: string;
  lastSuccessAt: Date | null;
  ageMs: number | null;
  stale: boolean;
}

export interface FreshnessOptions {
  /** Off for read-only callers (the digest) so reporting never pages anyone. */
  alert?: boolean;
}

/** A source that has not succeeded in 3x its poll interval is treated as down. */
export async function checkSourceFreshness(
  at: Date = new Date(),
  options: FreshnessOptions = {},
): Promise<SourceFreshness[]> {
  const enabled = getEnabledSources().map((source) => source.name);
  if (enabled.length === 0) return [];

  const rows = await prisma.sourceCheckpoint.findMany({
    where: { source: { in: enabled } },
    select: { source: true, lastSuccessAt: true },
  });

  const threshold = Math.max(
    intervalMs(env.POLL_INTERVAL_SECONDS) * SOURCE_STALENESS_MULTIPLIER,
    MIN_SOURCE_STALENESS_MS,
  );

  // A source with no checkpoint row at all has never run in this deployment;
  // that is a cold start, not an outage, so it is left out of the report.
  const newest = new Map<string, Date | null>();
  for (const row of rows) {
    const current = newest.get(row.source) ?? null;
    const candidate = row.lastSuccessAt;
    newest.set(row.source, candidate && (!current || candidate > current) ? candidate : current);
  }

  const report: SourceFreshness[] = [];
  for (const source of enabled) {
    if (!newest.has(source)) continue;
    const lastSuccessAt = newest.get(source) ?? null;
    const ageMs = lastSuccessAt ? at.getTime() - lastSuccessAt.getTime() : null;
    const stale = ageMs === null || ageMs > threshold;
    report.push({ source, lastSuccessAt, ageMs, stale });
  }

  if (options.alert !== false) {
    for (const entry of report) {
      if (!entry.stale) continue;
      await alertStaleSource(entry, threshold);
    }
  }

  return report;
}

async function alertStaleSource(entry: SourceFreshness, thresholdMs: number): Promise<void> {
  try {
    const count = await incrementCounter(
      `alert:stale-source:${entry.source}`,
      SOURCE_ALERT_WINDOW_SECONDS,
      1,
    );
    if (count !== 1) return;
  } catch (err) {
    log.warn({ err, source: entry.source }, 'could not rate-limit the stale source alert');
  }

  try {
    await notifySystemAlert({
      kind: 'SOURCE_FAILING',
      component: entry.source,
      severity: 'WARN',
      detail:
        `"${entry.source}" has not completed a successful fetch in the last ` +
        `${Math.round(thresholdMs / 60_000)} minutes. Detection is still running through the ` +
        'other sources.',
      facts: [
        {
          label: 'Last success',
          value: entry.lastSuccessAt ? (toIso(entry.lastSuccessAt) ?? 'never') : 'never',
        },
      ],
      refId: entry.source,
    });
  } catch (err) {
    log.error({ err, source: entry.source }, 'failed to send stale source alert');
  }
}

/* ---------------------------------------------------------------- the job */

/** Full housekeeping sweep. Guarded so overlapping schedules run it once. */
export async function runMaintenance(at: Date = new Date()): Promise<MaintenanceReport> {
  const startedAt = Date.now();
  const report = emptyReport();

  const ran = await withLock('maintenance:sweep', MAINTENANCE_LOCK_TTL_MS, async () => {
    report.jobsExpired = await step(report, 'expireStaleJobs', () => expireStaleJobs(at), 0);
    report.proposalsExpired = await step(
      report,
      'expireStaleProposals',
      () => expireStaleProposals(at),
      0,
    );

    const pruned = await step(report, 'pruneLogs', () => pruneLogs(at), {
      notifications: 0,
      audits: 0,
    });
    report.notificationsPruned = pruned.notifications;
    report.auditsPruned = pruned.audits;

    const ledger = await step(
      report,
      'reconcileConnectsLedger',
      () => reconcileConnectsLedger(at),
      { rowsFixed: 0, countersReconciled: 0 },
    );
    report.ledgerRowsFixed = ledger.rowsFixed;
    report.countersReconciled = ledger.countersReconciled;

    report.submissionsReconciled = await step(
      report,
      'reconcileStuckSubmissions',
      () => reconcileStuckSubmissions(at),
      0,
    );

    const freshness = await step(
      report,
      'checkSourceFreshness',
      () => checkSourceFreshness(at),
      [] as SourceFreshness[],
    );
    report.staleSources = freshness.filter((entry) => entry.stale).map((entry) => entry.source);

    return true;
  });

  report.durationMs = Date.now() - startedAt;

  if (ran === null) {
    report.skipped = 'another worker is already running maintenance';
    log.debug('maintenance skipped: lock busy');
    return report;
  }

  log.info(report, 'maintenance sweep complete');
  return report;
}

/* --------------------------------------------------------------- digest */

export interface DigestPayload extends PipelineStats {
  topMatches: { title: string; url: string; score: number; profile: string }[];
  staleSources: string[];
  generatedAt: string;
}

/** Numbers behind the daily 08:00 UTC summary. */
export async function collectPipelineStats(at: Date = new Date()): Promise<PipelineStats> {
  const since = hoursAgo(24, at);

  const [jobsSeen24h, jobsScored24h, proposalsDrafted24h, submitted24h, pendingApproval, avg] =
    await Promise.all([
      prisma.job.count({ where: { firstSeenAt: { gte: since } } }),
      prisma.jobProfileMatch.count({ where: { scoredAt: { gte: since } } }),
      prisma.proposal.count({ where: { createdAt: { gte: since } } }),
      prisma.submission.count({ where: { createdAt: { gte: since }, status: 'SUBMITTED' } }),
      prisma.proposal.count({ where: { status: 'PENDING_APPROVAL' } }),
      prisma.jobProfileMatch.aggregate({
        _avg: { score: true },
        where: { scoredAt: { gte: since } },
      }),
    ]);

  const avgScore = avg._avg.score;

  return {
    jobsSeen24h,
    jobsScored24h,
    proposalsDrafted24h,
    submitted24h,
    pendingApproval,
    avgScore24h: typeof avgScore === 'number' ? Math.round(avgScore * 10) / 10 : null,
  };
}

/** Builds and sends the daily digest. Never throws. */
export async function runDigest(at: Date = new Date()): Promise<DigestPayload> {
  const since = hoursAgo(24, at);
  const stats = await collectPipelineStats(at);

  const matches = await prisma.jobProfileMatch.findMany({
    where: { scoredAt: { gte: since }, decision: { in: ['BID', 'REVIEW'] } },
    orderBy: { score: 'desc' },
    take: 5,
    select: {
      score: true,
      job: { select: { title: true, url: true } },
      profile: { select: { name: true } },
    },
  });

  const freshness = await checkSourceFreshness(at, { alert: false }).catch((err: unknown) => {
    log.warn({ err }, 'digest could not check source freshness');
    return [] as SourceFreshness[];
  });

  const payload: DigestPayload = {
    ...stats,
    topMatches: matches.map((entry) => ({
      title: entry.job.title,
      url: entry.job.url,
      score: entry.score,
      profile: entry.profile.name,
    })),
    staleSources: freshness.filter((entry) => entry.stale).map((entry) => entry.source),
    generatedAt: at.toISOString(),
  };

  const notes =
    payload.staleSources.length > 0
      ? [`Sources with no recent success: ${payload.staleSources.join(', ')}`]
      : [];

  try {
    await notifyDailyDigest({
      periodLabel: 'last 24h',
      stats,
      highlights: payload.topMatches.map((match) => ({
        title: `${match.title} (${match.profile})`,
        score: match.score,
        url: match.url,
      })),
      notes,
      dashboardUrl: publicUrl('/'),
    });
  } catch (err) {
    log.error({ err }, 'failed to send the daily digest');
  }

  log.info(payload, 'daily digest sent');
  return payload;
}
