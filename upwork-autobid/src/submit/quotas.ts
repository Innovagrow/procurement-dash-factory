/**
 * Submission quotas. Counters live in Redis (UTC hour/day buckets from lib/time)
 * because they must be shared by every worker process; the connects spend is
 * mirrored into the ConnectsLedger table so the dashboard has a durable trail.
 */

import { child } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { getCounter, incrementCounter } from '../lib/redis';
import {
  dayBucket,
  hourBucket,
  quotaKey,
  secondsUntilEndOfDay,
  secondsUntilEndOfHour,
} from '../lib/time';
import type { SubmitJobView, SubmitProfileView } from '../types';

const log = child('submit:quotas');

export const SCOPE_SUBMISSIONS_HOUR = 'submissions:hour';
export const SCOPE_SUBMISSIONS_DAY = 'submissions:day';
export const SCOPE_CONNECTS_DAY = 'connects:day';

/** Used when a posting does not tell us how many connects it costs. */
export const DEFAULT_CONNECTS_PER_PROPOSAL = 10;

export const CONNECTS_LEDGER_REASON = 'proposal_submission';

export interface QuotaCounters {
  hourlySubmissions: number;
  dailySubmissions: number;
  dailyConnects: number;
}

export interface QuotaDecision {
  allowed: boolean;
  reason: string;
  remaining: QuotaCounters;
  used: QuotaCounters;
  limits: QuotaCounters;
  connectsNeeded: number;
}

export function submissionsHourKey(profileId: string, at: Date = new Date()): string {
  return quotaKey(SCOPE_SUBMISSIONS_HOUR, profileId, hourBucket(at));
}

export function submissionsDayKey(profileId: string, at: Date = new Date()): string {
  return quotaKey(SCOPE_SUBMISSIONS_DAY, profileId, dayBucket(at));
}

export function connectsDayKey(profileId: string, at: Date = new Date()): string {
  return quotaKey(SCOPE_CONNECTS_DAY, profileId, dayBucket(at));
}

/** Connects a proposal for this job will cost. */
export function estimateConnects(job: Pick<SubmitJobView, 'connectsRequired'>): number {
  const required = job.connectsRequired;
  if (typeof required === 'number' && Number.isFinite(required) && required >= 0) {
    return Math.floor(required);
  }
  return DEFAULT_CONNECTS_PER_PROPOSAL;
}

function nonNegativeInt(value: number | null | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

export function limitsFor(profile: SubmitProfileView): QuotaCounters {
  return {
    hourlySubmissions: nonNegativeInt(profile.maxHourlySubmissions, 0),
    dailySubmissions: nonNegativeInt(profile.maxDailySubmissions, 0),
    dailyConnects: nonNegativeInt(profile.maxDailyConnects, 0),
  };
}

export async function readCounters(
  profileId: string,
  at: Date = new Date(),
): Promise<QuotaCounters> {
  const [hourlySubmissions, dailySubmissions, dailyConnects] = await Promise.all([
    getCounter(submissionsHourKey(profileId, at)),
    getCounter(submissionsDayKey(profileId, at)),
    getCounter(connectsDayKey(profileId, at)),
  ]);
  return {
    hourlySubmissions: Math.max(0, hourlySubmissions),
    dailySubmissions: Math.max(0, dailySubmissions),
    dailyConnects: Math.max(0, dailyConnects),
  };
}

function remainingFrom(used: QuotaCounters, limits: QuotaCounters): QuotaCounters {
  return {
    hourlySubmissions: Math.max(0, limits.hourlySubmissions - used.hourlySubmissions),
    dailySubmissions: Math.max(0, limits.dailySubmissions - used.dailySubmissions),
    dailyConnects: Math.max(0, limits.dailyConnects - used.dailyConnects),
  };
}

const ZERO: QuotaCounters = { hourlySubmissions: 0, dailySubmissions: 0, dailyConnects: 0 };

/**
 * Decides whether one more submission fits inside the profile's budget.
 * Redis being unreachable blocks the submission: the dispatcher then routes to
 * the review queue, which is the safe direction to fail.
 */
export async function checkQuota(
  profile: SubmitProfileView,
  connectsNeeded = 0,
  at: Date = new Date(),
): Promise<QuotaDecision> {
  const limits = limitsFor(profile);
  const needed = Math.max(0, Math.floor(connectsNeeded));

  let used: QuotaCounters;
  try {
    used = await readCounters(profile.id, at);
  } catch (err) {
    log.error({ err, profileId: profile.id }, 'quota counters unreadable; blocking auto-submit');
    return {
      allowed: false,
      reason: 'quota backend (redis) is unreachable, so submission volume cannot be bounded',
      remaining: ZERO,
      used: ZERO,
      limits,
      connectsNeeded: needed,
    };
  }

  const remaining = remainingFrom(used, limits);
  const decision = (allowed: boolean, reason: string): QuotaDecision => ({
    allowed,
    reason,
    remaining,
    used,
    limits,
    connectsNeeded: needed,
  });

  if (limits.hourlySubmissions <= 0) {
    return decision(false, 'profile maxHourlySubmissions is 0');
  }
  if (limits.dailySubmissions <= 0) {
    return decision(false, 'profile maxDailySubmissions is 0');
  }
  if (used.hourlySubmissions >= limits.hourlySubmissions) {
    return decision(
      false,
      `hourly submission quota exhausted (${used.hourlySubmissions}/${limits.hourlySubmissions} in ${hourBucket(at)}Z)`,
    );
  }
  if (used.dailySubmissions >= limits.dailySubmissions) {
    return decision(
      false,
      `daily submission quota exhausted (${used.dailySubmissions}/${limits.dailySubmissions} on ${dayBucket(at)})`,
    );
  }
  if (needed > 0) {
    if (limits.dailyConnects <= 0) {
      return decision(false, 'profile maxDailyConnects is 0');
    }
    if (used.dailyConnects + needed > limits.dailyConnects) {
      return decision(
        false,
        `daily connects budget exhausted (${used.dailyConnects}+${needed} > ${limits.dailyConnects} on ${dayBucket(at)})`,
      );
    }
  }

  return decision(true, 'within submission and connects quotas');
}

export interface RecordSubmissionResult {
  used: QuotaCounters;
  remaining: QuotaCounters;
  limits: QuotaCounters;
  connectsSpent: number;
  ledgerId: string | null;
}

/**
 * Counts one submission against the profile's hourly/daily budgets and writes
 * the connects spend to the ledger. Counter failures are logged but never
 * bubble up: a submission that already happened must still be persisted.
 */
export async function recordSubmission(
  profile: SubmitProfileView,
  connects: number,
  refId?: string,
  at: Date = new Date(),
): Promise<RecordSubmissionResult> {
  const limits = limitsFor(profile);
  const spent = Math.max(0, Math.floor(connects));
  let used: QuotaCounters = ZERO;

  try {
    const [hourlySubmissions, dailySubmissions] = await Promise.all([
      incrementCounter(submissionsHourKey(profile.id, at), secondsUntilEndOfHour(at), 1),
      incrementCounter(submissionsDayKey(profile.id, at), secondsUntilEndOfDay(at), 1),
    ]);
    const dailyConnects =
      spent > 0
        ? await incrementCounter(connectsDayKey(profile.id, at), secondsUntilEndOfDay(at), spent)
        : await getCounter(connectsDayKey(profile.id, at));

    used = {
      hourlySubmissions: Math.max(0, hourlySubmissions),
      dailySubmissions: Math.max(0, dailySubmissions),
      dailyConnects: Math.max(0, dailyConnects),
    };
  } catch (err) {
    log.error({ err, profileId: profile.id }, 'failed to update quota counters after a submission');
  }

  const remaining = remainingFrom(used, limits);

  let ledgerId: string | null = null;
  if (spent > 0) {
    try {
      const row = await prisma.connectsLedger.create({
        data: {
          profileId: profile.id,
          delta: -spent,
          balanceAfter: remaining.dailyConnects,
          reason: CONNECTS_LEDGER_REASON,
          refId: refId ?? null,
        },
        select: { id: true },
      });
      ledgerId = row.id;
    } catch (err) {
      log.error({ err, profileId: profile.id, refId }, 'failed to write connects ledger entry');
    }
  }

  log.info(
    {
      profileId: profile.id,
      connectsSpent: spent,
      used,
      limits,
      refId,
    },
    'submission recorded against quota',
  );

  return { used, remaining, limits, connectsSpent: spent, ledgerId };
}

/** Read-only snapshot for the dashboard and /health. */
export async function quotaSnapshot(
  profile: SubmitProfileView,
  at: Date = new Date(),
): Promise<QuotaDecision> {
  return checkQuota(profile, 0, at);
}
