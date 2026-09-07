/**
 * Scoring worker: one (job, profile) pair per queue job.
 *
 * The rules engine plus the optional LLM rerank live in ../scoring; this file
 * owns persistence and routing. A BID lands a high-priority draft and a push
 * notification within the same tick, REVIEW drafts at normal priority, SKIP
 * ends the job's life.
 */

import { Prisma } from '@prisma/client';
import { env } from '../config/env';
import { child } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { incrementCounter } from '../lib/redis';
import { dayBucket, secondsUntilEndOfDay } from '../lib/time';
import { notifyHotJob } from '../notify';
import { evaluate } from '../scoring';
import type { Decision, ScoreJobData } from '../types';
import { addDraftJob, PRIORITY } from '../queue/queues';

const log = child('worker:score');

/** Job statuses that a fresh score is allowed to overwrite. */
const OVERWRITABLE_STATUSES = new Set<string>(['NEW', 'SCORED', 'SKIPPED', 'EXPIRED']);

export interface ScoreOutcome {
  jobId: string;
  profileId: string;
  score: number;
  decision: Decision | 'NONE';
  matchId: string | null;
  enqueuedDraft: boolean;
  notified: boolean;
  skipped?: string;
}

function toJsonArray(value: unknown[]): Prisma.InputJsonValue {
  try {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  } catch {
    return [];
  }
}

function toIntOrNull(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round(value);
}

async function recordMetric(name: string, by = 1): Promise<void> {
  if (!env.METRICS_ENABLED || by === 0) return;
  try {
    await incrementCounter(`metrics:${name}:${dayBucket()}`, secondsUntilEndOfDay(), by);
  } catch (err) {
    log.debug({ err, metric: name }, 'metric increment failed');
  }
}

/* ----------------------------------------------------------------- the job */

/**
 * Scores one job for one profile. Idempotent: the match row is upserted and the
 * draft job carries a deterministic id, so a retry re-scores without duplicating
 * downstream work.
 */
export async function runScore(data: ScoreJobData): Promise<ScoreOutcome> {
  const { jobId, profileId } = data;
  const base: ScoreOutcome = {
    jobId,
    profileId,
    score: 0,
    decision: 'NONE',
    matchId: null,
    enqueuedDraft: false,
    notified: false,
  };

  const [job, profile] = await Promise.all([
    prisma.job.findUnique({ where: { id: jobId } }),
    prisma.profile.findUnique({ where: { id: profileId } }),
  ]);

  if (!job) {
    log.warn({ jobId, profileId }, 'score skipped: job no longer exists');
    return { ...base, skipped: 'job not found' };
  }
  if (!profile) {
    log.warn({ jobId, profileId }, 'score skipped: profile no longer exists');
    return { ...base, skipped: 'profile not found' };
  }
  if (!profile.isActive) {
    log.debug({ jobId, profileId }, 'score skipped: profile is inactive');
    return { ...base, skipped: 'profile is inactive' };
  }
  if (job.status === 'SUBMITTED') {
    log.debug({ jobId, profileId }, 'score skipped: a proposal was already submitted');
    return { ...base, skipped: 'already submitted' };
  }

  const previous = await prisma.jobProfileMatch.findUnique({
    where: { jobId_profileId: { jobId, profileId } },
    select: { id: true, decision: true, score: true },
  });

  const result = await evaluate(job, profile);
  const scoredAt = new Date();

  const matchPayload = {
    score: Math.round(result.score),
    decision: result.decision,
    breakdown: toJsonArray(result.breakdown),
    redFlags: toJsonArray(result.redFlags),
    reasons: result.reasons,
    matchedKeywords: result.matchedKeywords,
    matchedSkills: result.matchedSkills,
    llmScore: toIntOrNull(result.llmScore),
    llmRationale: result.llmRationale ?? null,
    scoredAt,
  };

  const match = await prisma.jobProfileMatch.upsert({
    where: { jobId_profileId: { jobId, profileId } },
    create: { jobId, profileId, ...matchPayload },
    update: matchPayload,
    select: { id: true },
  });

  base.matchId = match.id;
  base.score = matchPayload.score;
  base.decision = result.decision;

  const nextStatus = result.decision === 'SKIP' ? 'SKIPPED' : 'SCORED';
  if (OVERWRITABLE_STATUSES.has(job.status) && job.status !== nextStatus) {
    try {
      await prisma.job.update({ where: { id: jobId }, data: { status: nextStatus } });
    } catch (err) {
      log.warn({ err, jobId, nextStatus }, 'could not update job status after scoring');
    }
  }

  log.info(
    {
      jobId,
      profileId,
      profile: profile.name,
      score: matchPayload.score,
      previousScore: previous?.score ?? null,
      decision: result.decision,
      llmScore: matchPayload.llmScore,
      redFlags: result.redFlags.map((flag) => flag.code),
      hardFilterFailures: result.hardFilterFailures,
    },
    'job scored',
  );

  await Promise.all([
    recordMetric('jobs.scored', 1),
    recordMetric(`decision.${result.decision.toLowerCase()}`, 1),
  ]);

  if (result.decision === 'SKIP') {
    return base;
  }

  // Only the transition into BID is worth a push: a re-score that stays BID
  // would otherwise buzz the operator on every content change.
  const isNewBid = result.decision === 'BID' && previous?.decision !== 'BID';
  if (isNewBid) {
    try {
      await notifyHotJob({
        job,
        match: {
          score: matchPayload.score,
          decision: result.decision,
          reasons: result.reasons,
          redFlags: result.redFlags,
          matchedSkills: result.matchedSkills,
          matchedKeywords: result.matchedKeywords,
          llmScore: matchPayload.llmScore,
          llmRationale: result.llmRationale ?? null,
        },
        profile: { id: profile.id, name: profile.name, hourlyRate: profile.hourlyRate },
      });
      base.notified = true;
    } catch (err) {
      // A dead notification channel must never stop the draft from happening.
      log.error({ err, jobId, profileId }, 'failed to send hot job notification');
    }
  }

  try {
    await addDraftJob(
      { jobId, profileId, matchId: match.id },
      { priority: result.decision === 'BID' ? PRIORITY.hot : PRIORITY.normal },
    );
    base.enqueuedDraft = true;
  } catch (err) {
    log.error({ err, jobId, profileId }, 'failed to enqueue draft job');
    throw err;
  }

  return base;
}

/** Re-scores every active profile against one job. Used by the API. */
export async function rescoreJob(jobId: string): Promise<ScoreOutcome[]> {
  const profiles = await prisma.profile.findMany({
    where: { isActive: true },
    select: { id: true },
  });

  const outcomes: ScoreOutcome[] = [];
  for (const profile of profiles) {
    try {
      outcomes.push(await runScore({ jobId, profileId: profile.id }));
    } catch (err) {
      log.error({ err, jobId, profileId: profile.id }, 'rescore failed for a profile');
    }
  }
  return outcomes;
}
