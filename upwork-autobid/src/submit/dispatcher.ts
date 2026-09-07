/**
 * Turns a drafted proposal into exactly one outcome, once.
 *
 * Everything the submission layer promises is enforced here: a Redis lock so a
 * retried queue job cannot double-submit, a short-circuit when a SUBMITTED
 * Submission already exists, the policy gate, the fall back to the review queue
 * whenever the configured submitter cannot (or must not) send, and the audit
 * trail for whichever branch ran.
 */

import type { Prisma } from '@prisma/client';
import { env } from '../config/env';
import { toErrorMessage } from '../lib/errors';
import { child } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { withLock } from '../lib/redis';
import type {
  ProposalStatus,
  ProposalSubmitter,
  QuestionAnswer,
  SubmitContext,
  SubmitJobView,
} from '../types';
import { apiSubmitter } from './api-submitter';
import {
  decideSubmission,
  isPreparable,
  parseRedFlags,
  persistsOwnSubmission,
  type PolicyDecision,
  type PolicyMatchView,
  type PolicyProfileView,
  type PolicyProposalView,
  type SubmitAttemptResult,
} from './policy';
import { checkQuota, estimateConnects, recordSubmission } from './quotas';
import { reviewQueueSubmitter } from './review-queue';
import { webhookSubmitter } from './webhook-submitter';

const log = child('submit:dispatcher');

export const DISPATCH_LOCK_TTL_MS = 180_000;

const MAX_MESSAGE_CHARS = 4000;

export const SUBMITTERS: Record<'api' | 'webhook' | 'review_queue', ProposalSubmitter> = {
  api: apiSubmitter,
  webhook: webhookSubmitter,
  review_queue: reviewQueueSubmitter,
};

export function submitterByName(name: string): ProposalSubmitter | null {
  if (name === 'api' || name === 'webhook' || name === 'review_queue') {
    return SUBMITTERS[name];
  }
  return null;
}

function configurationHint(submitter: ProposalSubmitter): string {
  const hint = (submitter as { configurationHint?: () => string }).configurationHint;
  if (typeof hint === 'function') {
    try {
      return hint.call(submitter);
    } catch {
      return 'not configured';
    }
  }
  return submitter.isConfigured() ? 'configured' : 'not configured';
}

/**
 * The submitter env.SUBMITTER asks for, or the review queue when that one is not
 * usable. Never throws and never returns something that cannot run.
 */
export async function selectSubmitter(): Promise<ProposalSubmitter> {
  const chosen = submitterByName(env.SUBMITTER) ?? reviewQueueSubmitter;

  if (isPreparable(chosen)) {
    try {
      await chosen.prepare();
    } catch (err) {
      log.warn({ err, submitter: chosen.name }, 'submitter preparation failed');
    }
  }

  if (chosen.name === reviewQueueSubmitter.name) return chosen;

  if (!chosen.isConfigured()) {
    log.warn(
      { submitter: chosen.name, hint: configurationHint(chosen) },
      'configured submitter is not usable; falling back to the human review queue',
    );
    return reviewQueueSubmitter;
  }

  return chosen;
}

export interface SubmitterStatus {
  requested: string;
  effective: string;
  configured: boolean;
  canAutoSubmit: boolean;
  fellBack: boolean;
  autoSubmitEnabled: boolean;
  dryRun: boolean;
  detail: string;
}

/** Snapshot for /health and the dashboard. */
export async function submitterStatus(): Promise<SubmitterStatus> {
  const requested = submitterByName(env.SUBMITTER) ?? reviewQueueSubmitter;
  const effective = await selectSubmitter();
  return {
    requested: requested.name,
    effective: effective.name,
    configured: requested.isConfigured(),
    canAutoSubmit: effective.canAutoSubmit && effective.isConfigured(),
    fellBack: effective.name !== requested.name,
    autoSubmitEnabled: env.AUTO_SUBMIT,
    dryRun: env.DRY_RUN,
    detail: configurationHint(requested),
  };
}

/* --------------------------------------------------------------- utilities */

function asJson(value: unknown): Prisma.InputJsonValue {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return {};
    const parsed: unknown = JSON.parse(serialized);
    if (parsed === null || typeof parsed !== 'object') {
      return { value: parsed } as Prisma.InputJsonValue;
    }
    return parsed as Prisma.InputJsonValue;
  } catch {
    return { unserializable: true };
  }
}

function clip(value: string | undefined, max = MAX_MESSAGE_CHARS): string {
  const text = value ?? '';
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/** Parses the Proposal.questionAnswers JSON column. */
export function parseQuestionAnswers(value: unknown): QuestionAnswer[] {
  if (!Array.isArray(value)) return [];
  const answers: QuestionAnswer[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const question = typeof record.question === 'string' ? record.question : null;
    const answer = typeof record.answer === 'string' ? record.answer : null;
    if (question === null || answer === null) continue;
    answers.push({ question, answer });
  }
  return answers;
}

interface ProposalPatch {
  status?: ProposalStatus;
  connectsCost?: number;
  approvedAt?: Date | null;
  approvedBy?: string | null;
  rejectedAt?: Date | null;
  rejectionReason?: string | null;
}

async function patchProposal(proposalId: string, patch: ProposalPatch): Promise<void> {
  try {
    await prisma.proposal.update({ where: { id: proposalId }, data: patch });
  } catch (err) {
    log.error({ err, proposalId, patch }, 'failed to update proposal');
  }
}

export async function recordAudit(
  action: string,
  proposalId: string,
  actor: string,
  details: Record<string, unknown>,
): Promise<void> {
  try {
    await prisma.auditEvent.create({
      data: {
        actor,
        action,
        refType: 'proposal',
        refId: proposalId,
        details: asJson(details),
      },
    });
  } catch (err) {
    log.warn({ err, proposalId, action }, 'failed to write audit event');
  }
}

async function recordSubmissionRow(
  proposalId: string,
  submitterName: string,
  result: SubmitAttemptResult,
): Promise<string | null> {
  try {
    const row = await prisma.submission.create({
      data: {
        proposalId,
        submitter: submitterName,
        status: result.status,
        externalRef: result.externalRef ?? null,
        message: clip(result.message),
        attempt: Math.max(1, result.attempt ?? 1),
        connectsSpent: result.connectsSpent ?? 0,
        payload: result.payload === undefined ? undefined : asJson(result.payload),
      },
      select: { id: true },
    });
    return row.id;
  } catch (err) {
    log.error({ err, proposalId, submitter: submitterName }, 'failed to persist submission row');
    return null;
  }
}

/* ---------------------------------------------------------------- dispatch */

export interface DispatchOptions {
  /** Who triggered this dispatch; recorded on the audit event. */
  actor?: string;
  /** Set by approveProposal: the auto-submission gates are already answered. */
  humanApproved?: boolean;
}

/**
 * Runs a proposal through the submission layer exactly once.
 * Never throws: the caller is a BullMQ job that must not die on a bad proposal.
 */
export async function dispatch(
  proposalId: string,
  options: DispatchOptions = {},
): Promise<SubmitAttemptResult> {
  const actor = options.actor ?? 'system';
  const outcome = await withLock(`submit:proposal:${proposalId}`, DISPATCH_LOCK_TTL_MS, () =>
    dispatchLocked(proposalId, options, actor),
  );

  if (outcome === null) {
    log.debug({ proposalId }, 'dispatch skipped: lock held by another worker');
    return {
      status: 'SKIPPED',
      message: 'another worker is already dispatching this proposal',
      attempt: 0,
    };
  }

  return outcome;
}

async function dispatchLocked(
  proposalId: string,
  options: DispatchOptions,
  actor: string,
): Promise<SubmitAttemptResult> {
  try {
    const proposal = await prisma.proposal.findUnique({
      where: { id: proposalId },
      include: { job: true, profile: true },
    });

    if (!proposal) {
      log.warn({ proposalId }, 'dispatch skipped: proposal not found');
      return { status: 'SKIPPED', message: `proposal ${proposalId} no longer exists`, attempt: 0 };
    }

    const alreadySubmitted = await prisma.submission.findFirst({
      where: { proposalId, status: 'SUBMITTED' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, externalRef: true, attempt: true, connectsSpent: true },
    });

    if (alreadySubmitted || proposal.status === 'SUBMITTED') {
      if (proposal.status !== 'SUBMITTED') {
        await patchProposal(proposalId, { status: 'SUBMITTED' });
      }
      log.info({ proposalId }, 'dispatch short-circuited: proposal already submitted');
      return {
        status: 'SUBMITTED',
        ...(alreadySubmitted?.externalRef ? { externalRef: alreadySubmitted.externalRef } : {}),
        message: 'already submitted; nothing sent',
        connectsSpent: alreadySubmitted?.connectsSpent ?? 0,
        attempt: alreadySubmitted?.attempt ?? 1,
      };
    }

    const profileView: PolicyProfileView = {
      id: proposal.profile.id,
      name: proposal.profile.name,
      autoSubmit: proposal.profile.autoSubmit,
      hourlyRate: proposal.profile.hourlyRate,
      maxDailySubmissions: proposal.profile.maxDailySubmissions,
      maxHourlySubmissions: proposal.profile.maxHourlySubmissions,
      maxDailyConnects: proposal.profile.maxDailyConnects,
      autoBidThreshold: proposal.profile.autoBidThreshold,
    };

    const jobView: SubmitJobView = {
      id: proposal.job.id,
      source: proposal.job.source,
      externalId: proposal.job.externalId,
      url: proposal.job.url,
      title: proposal.job.title,
      jobType: proposal.job.jobType,
      connectsRequired: proposal.job.connectsRequired,
      budgetAmount: proposal.job.budgetAmount,
    };

    const ctx: SubmitContext = {
      proposalId,
      profile: profileView,
      job: jobView,
      coverLetter: proposal.coverLetter,
      bidAmount: proposal.bidAmount,
      hourlyRate: proposal.hourlyRate,
      questionAnswers: parseQuestionAnswers(proposal.questionAnswers),
      dryRun: env.DRY_RUN,
    };

    const match = await prisma.jobProfileMatch.findUnique({
      where: { jobId_profileId: { jobId: proposal.jobId, profileId: proposal.profileId } },
      select: { score: true, decision: true, redFlags: true },
    });

    const matchView: PolicyMatchView = match
      ? {
          decision: match.decision,
          score: match.score,
          redFlags: parseRedFlags(match.redFlags),
        }
      : { decision: 'REVIEW', score: 0, redFlags: [] };

    const proposalView: PolicyProposalView = {
      id: proposal.id,
      status: proposal.status,
      coverLetter: proposal.coverLetter,
      bidAmount: proposal.bidAmount,
      hourlyRate: proposal.hourlyRate,
      warnings: proposal.warnings,
    };

    const submitter = await selectSubmitter();
    const connectsNeeded = proposal.connectsCost ?? estimateConnects(jobView);
    const quota = await checkQuota(profileView, connectsNeeded);

    const decision: PolicyDecision = decideSubmission({
      profile: profileView,
      match: matchView,
      proposal: proposalView,
      submitter,
      quota,
      humanApproved: options.humanApproved === true,
    });

    log.info(
      {
        proposalId,
        jobId: proposal.jobId,
        submitter: submitter.name,
        action: decision.action,
        reason: decision.reason,
        score: matchView.score,
        quotaAllowed: quota.allowed,
      },
      'submission policy decision',
    );

    if (decision.action === 'HOLD') {
      const result: SubmitAttemptResult = {
        status: 'SKIPPED',
        message: decision.reason,
        attempt: 1,
        connectsSpent: 0,
      };
      await recordSubmissionRow(proposalId, submitter.name, result);
      await patchProposal(proposalId, { status: 'FAILED' });
      await recordAudit('submission.held', proposalId, actor, {
        reason: decision.reason,
        guardrailErrors: decision.guardrailErrors,
        submitter: submitter.name,
      });
      return result;
    }

    if (decision.action === 'REVIEW') {
      if (options.humanApproved === true) {
        // A person already approved this one; re-queueing it would loop.
        const result: SubmitAttemptResult = {
          status: 'SKIPPED',
          message: `${decision.reason}. Open ${jobView.url} and submit the approved proposal manually.`,
          attempt: 1,
          connectsSpent: 0,
        };
        await recordSubmissionRow(proposalId, submitter.name, result);
        await recordAudit('submission.manual_required', proposalId, actor, {
          reason: decision.reason,
          submitter: submitter.name,
          jobUrl: jobView.url,
        });
        return result;
      }

      const queued = await runSubmitter(reviewQueueSubmitter, ctx, proposalId);
      if (!persistsOwnSubmission(reviewQueueSubmitter)) {
        await recordSubmissionRow(proposalId, reviewQueueSubmitter.name, queued);
      }
      await recordAudit('submission.queued_for_review', proposalId, actor, {
        reason: decision.reason,
        blockers: decision.blockers,
        score: matchView.score,
        submitter: reviewQueueSubmitter.name,
        result: queued.status,
      });
      return queued;
    }

    /* ------------------------------------------------------ auto submission */

    await patchProposal(proposalId, { status: 'SUBMITTING' });
    const result = await runSubmitter(submitter, ctx, proposalId);

    if (!persistsOwnSubmission(submitter)) {
      await recordSubmissionRow(proposalId, submitter.name, result);
    }

    if (result.status === 'SUBMITTED') {
      const spent = result.connectsSpent ?? connectsNeeded;
      await patchProposal(proposalId, { status: 'SUBMITTED', connectsCost: spent });
      try {
        await prisma.job.update({ where: { id: proposal.jobId }, data: { status: 'SUBMITTED' } });
      } catch (err) {
        log.warn({ err, jobId: proposal.jobId }, 'could not mark job as submitted');
      }
      await recordSubmission(profileView, spent, proposalId);
      await recordAudit('submission.submitted', proposalId, actor, {
        submitter: submitter.name,
        externalRef: result.externalRef ?? null,
        connectsSpent: spent,
        attempt: result.attempt ?? 1,
        score: matchView.score,
      });
      return result;
    }

    if (result.status === 'DRY_RUN') {
      // Nothing left the process, so no quota is consumed and the proposal stays
      // ready to be sent for real once DRY_RUN is turned off.
      await patchProposal(proposalId, { status: 'APPROVED' });
      await recordAudit('submission.dry_run', proposalId, actor, {
        submitter: submitter.name,
        message: result.message,
      });
      return result;
    }

    if (result.status === 'FAILED' && result.fallbackToReview === true) {
      log.warn(
        { proposalId, submitter: submitter.name, message: result.message },
        'submitter cannot send for this account; falling back to the review queue',
      );
      const queued = await runSubmitter(reviewQueueSubmitter, ctx, proposalId);
      if (!persistsOwnSubmission(reviewQueueSubmitter)) {
        await recordSubmissionRow(proposalId, reviewQueueSubmitter.name, queued);
      }
      await recordAudit('submission.fallback_to_review', proposalId, actor, {
        submitter: submitter.name,
        failure: result.message,
        queued: queued.status,
      });
      return {
        ...queued,
        message: `${result.message} | ${queued.message}`,
      };
    }

    if (result.status === 'FAILED') {
      await patchProposal(proposalId, { status: 'FAILED' });
      await recordAudit('submission.failed', proposalId, actor, {
        submitter: submitter.name,
        message: result.message,
        attempt: result.attempt ?? 1,
      });
      return result;
    }

    await recordAudit('submission.other', proposalId, actor, {
      submitter: submitter.name,
      status: result.status,
      message: result.message,
    });
    return result;
  } catch (err) {
    log.error({ err, proposalId }, 'dispatch failed unexpectedly');
    await patchProposal(proposalId, { status: 'FAILED' });
    await recordAudit('submission.error', proposalId, actor, { error: toErrorMessage(err) });
    return {
      status: 'FAILED',
      message: `dispatch failed: ${toErrorMessage(err)}`,
      attempt: 0,
    };
  }
}

/** Runs a submitter without letting it throw into the dispatch flow. */
async function runSubmitter(
  submitter: ProposalSubmitter,
  ctx: SubmitContext,
  proposalId: string,
): Promise<SubmitAttemptResult> {
  try {
    return await submitter.submit(ctx);
  } catch (err) {
    log.error({ err, proposalId, submitter: submitter.name }, 'submitter threw');
    return {
      status: 'FAILED',
      message: `submitter "${submitter.name}" threw: ${toErrorMessage(err)}`,
      attempt: 0,
    };
  }
}
