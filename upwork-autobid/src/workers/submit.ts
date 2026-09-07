/**
 * Submission worker.
 *
 * All of the policy lives in ../submit; this worker adds the two things a queue
 * has to add: serialisation per profile so quota checks cannot be raced, and a
 * retry decision. The dispatcher never throws, so a failure arrives as a result
 * object and this file decides whether BullMQ should try again.
 */

import { env, publicUrl } from '../config/env';
import { RetryableError } from '../lib/errors';
import { child } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { incrementCounter, withLock } from '../lib/redis';
import { dayBucket, secondsUntilEndOfDay } from '../lib/time';
import { notifySubmitted, notifySystemAlert } from '../notify';
import { dispatch, type SubmitAttemptResult } from '../submit';
import type { SubmitJobData } from '../types';

const log = child('worker:submit');

/**
 * Long enough for a slow upstream submit, short enough that a killed worker
 * frees the profile again quickly.
 */
export const SUBMIT_PROFILE_LOCK_TTL_MS = 120_000;

/** Statuses that mean there is nothing left to dispatch. */
const TERMINAL_STATUSES = new Set<string>(['SUBMITTED', 'REJECTED', 'EXPIRED']);

const LOCK_BUSY_PATTERN = /another worker is already dispatching/i;

/** Checked first: a permanent problem must never be retried five times. */
const TERMINAL_FAILURE_PATTERN =
  /(not configured|missing scope|unauthor|forbidden|guardrail|not submittable|no submitter|cannot send|already submitted|\b40[0134]\b|\b409\b|\b422\b)/i;

const RETRYABLE_FAILURE_PATTERN =
  /(timeout|timed out|etimedout|econnreset|econnrefused|enotfound|eai_again|socket hang up|network|rate limit|too many requests|\b429\b|\b50[0234]\b|temporarily|unavailable|circuit open|try again)/i;

/** True when re-running the same dispatch could plausibly succeed. */
export function isRetryableFailure(message: string): boolean {
  const text = (message ?? '').trim();
  if (text === '') return false;
  if (TERMINAL_FAILURE_PATTERN.test(text)) return false;
  return RETRYABLE_FAILURE_PATTERN.test(text);
}

export interface SubmitRunContext {
  /** 1-based attempt number from BullMQ, used to stop notifying on every retry. */
  attempt?: number;
  maxAttempts?: number;
}

async function recordMetric(name: string, by = 1): Promise<void> {
  if (!env.METRICS_ENABLED || by === 0) return;
  try {
    await incrementCounter(`metrics:${name}:${dayBucket()}`, secondsUntilEndOfDay(), by);
  } catch (err) {
    log.debug({ err, metric: name }, 'metric increment failed');
  }
}

/**
 * Confirmation that something actually left the building (or would have, in a
 * dry run). The dispatcher stays silent on success, so this is the operator's
 * only signal that the loop closed.
 */
async function notifySubmission(proposalId: string, result: SubmitAttemptResult): Promise<void> {
  try {
    const full = await prisma.proposal.findUnique({
      where: { id: proposalId },
      include: { job: true, profile: true },
    });
    if (!full) return;

    await notifySubmitted({
      job: full.job,
      proposal: {
        id: full.id,
        coverLetter: full.coverLetter,
        bidAmount: full.bidAmount,
        hourlyRate: full.hourlyRate,
        estimatedDurationLabel: full.estimatedDurationLabel,
        connectsCost: full.connectsCost,
      },
      profile: { id: full.profile.id, name: full.profile.name, hourlyRate: full.profile.hourlyRate },
      submitter: env.SUBMITTER,
      status: result.status,
      message: result.message,
      connectsSpent: result.connectsSpent ?? null,
      externalRef: result.externalRef ?? null,
      dryRun: result.status === 'DRY_RUN',
    });
  } catch (err) {
    log.error({ err, proposalId }, 'failed to send submission confirmation');
  }
}

async function jobFacts(jobId: string): Promise<{ title: string; url: string }> {
  try {
    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: { title: true, url: true },
    });
    return { title: job?.title ?? jobId, url: job?.url ?? publicUrl(`/#/jobs/${jobId}`) };
  } catch {
    return { title: jobId, url: publicUrl(`/#/jobs/${jobId}`) };
  }
}

async function notifyTerminalFailure(
  proposalId: string,
  jobId: string,
  result: SubmitAttemptResult,
): Promise<void> {
  const { title, url } = await jobFacts(jobId);
  try {
    await notifySystemAlert({
      kind: 'DEGRADED',
      component: 'submit',
      severity: 'CRITICAL',
      detail:
        `${result.message} The proposal will not be retried automatically - open the job and ` +
        'submit it by hand if it is still worth bidding on.',
      facts: [
        { label: 'Job', value: title },
        { label: 'Upwork', value: url },
        { label: 'Proposal', value: proposalId },
      ],
      dashboardUrl: publicUrl(`/#/proposals/${proposalId}`),
      refId: proposalId,
    });
  } catch (err) {
    log.error({ err, proposalId }, 'failed to send submission failure notification');
  }
}

async function notifyHeld(
  proposalId: string,
  jobId: string,
  result: SubmitAttemptResult,
): Promise<void> {
  const { title, url } = await jobFacts(jobId);
  try {
    await notifySystemAlert({
      kind: 'DEGRADED',
      component: 'submit',
      severity: 'WARN',
      detail: `${result.message} Nothing was sent; review the proposal in the dashboard.`,
      facts: [
        { label: 'Job', value: title },
        { label: 'Upwork', value: url },
        { label: 'Proposal', value: proposalId },
      ],
      dashboardUrl: publicUrl(`/#/proposals/${proposalId}`),
      refId: proposalId,
    });
  } catch (err) {
    log.error({ err, proposalId }, 'failed to send submission hold notification');
  }
}

/* ----------------------------------------------------------------- the job */

/**
 * Dispatches one proposal. Safe to run twice: the dispatcher short-circuits on
 * an existing SUBMITTED submission and holds its own idempotency lock.
 */
export async function runSubmit(
  data: SubmitJobData,
  ctx: SubmitRunContext = {},
): Promise<SubmitAttemptResult> {
  const { proposalId } = data;
  const attempt = Math.max(1, ctx.attempt ?? 1);
  const maxAttempts = Math.max(1, ctx.maxAttempts ?? 1);
  const lastAttempt = attempt >= maxAttempts;

  const proposal = await prisma.proposal.findUnique({
    where: { id: proposalId },
    select: { id: true, jobId: true, profileId: true, status: true },
  });

  if (!proposal) {
    log.warn({ proposalId }, 'submit skipped: proposal no longer exists');
    return { status: 'SKIPPED', message: 'proposal not found', attempt: 0 };
  }

  if (TERMINAL_STATUSES.has(proposal.status)) {
    log.debug({ proposalId, status: proposal.status }, 'submit skipped: proposal is terminal');
    return {
      status: 'SKIPPED',
      message: `proposal is already ${proposal.status}`,
      attempt: 0,
    };
  }

  // One in-flight submission per profile: the quota counters are read-then-write
  // and two concurrent dispatches could both see room under the daily cap.
  const result = await withLock(
    `submit:profile:${proposal.profileId}`,
    SUBMIT_PROFILE_LOCK_TTL_MS,
    () =>
      dispatch(proposalId, {
        actor: data.approvedBy ?? 'worker',
        humanApproved: Boolean(data.approvedBy),
      }),
  );

  if (result === null) {
    const message = `another submission is in flight for profile ${proposal.profileId}`;
    if (lastAttempt) {
      log.warn({ proposalId, profileId: proposal.profileId }, `${message}; giving up`);
      return { status: 'SKIPPED', message, attempt };
    }
    throw new RetryableError(message, { details: { proposalId, profileId: proposal.profileId } });
  }

  log.info(
    {
      proposalId,
      jobId: proposal.jobId,
      profileId: proposal.profileId,
      status: result.status,
      message: result.message,
      connectsSpent: result.connectsSpent ?? 0,
      attempt,
    },
    'submission dispatched',
  );

  switch (result.status) {
    case 'SUBMITTED':
      await recordMetric('submissions.submitted', 1);
      await recordMetric('connects.spent', result.connectsSpent ?? 0);
      await notifySubmission(proposalId, result);
      return result;

    case 'DRY_RUN':
      await recordMetric('submissions.dry_run', 1);
      await notifySubmission(proposalId, result);
      return result;

    case 'QUEUED_FOR_REVIEW':
      await recordMetric('submissions.queued_for_review', 1);
      return result;

    case 'SKIPPED': {
      // The dispatcher's own lock lost a race: retry rather than dropping it.
      if (LOCK_BUSY_PATTERN.test(result.message) && !lastAttempt) {
        throw new RetryableError(result.message, { details: { proposalId } });
      }
      await recordMetric('submissions.skipped', 1);
      const after = await prisma.proposal.findUnique({
        where: { id: proposalId },
        select: { status: true },
      });
      if (after?.status === 'FAILED') {
        await notifyHeld(proposalId, proposal.jobId, result);
      }
      return result;
    }

    case 'FAILED': {
      if (isRetryableFailure(result.message) && !lastAttempt) {
        log.warn(
          { proposalId, attempt, maxAttempts, message: result.message },
          'submission failed with a transient error; retrying',
        );
        throw new RetryableError(result.message, { details: { proposalId, attempt } });
      }
      await recordMetric('submissions.failed', 1);
      await ensureFailed(proposalId);
      await notifyTerminalFailure(proposalId, proposal.jobId, result);
      return result;
    }

    default:
      await recordMetric('submissions.unknown', 1);
      log.warn({ proposalId, result }, 'submission returned an unrecognised status');
      return result;
  }
}

/** The dispatcher normally does this; belt-and-braces so nothing is left in SUBMITTING. */
async function ensureFailed(proposalId: string): Promise<void> {
  try {
    await prisma.proposal.updateMany({
      where: { id: proposalId, status: { in: ['SUBMITTING', 'APPROVED', 'PENDING_APPROVAL'] } },
      data: { status: 'FAILED' },
    });
  } catch (err) {
    log.warn({ err, proposalId }, 'could not mark proposal as failed');
  }
}
