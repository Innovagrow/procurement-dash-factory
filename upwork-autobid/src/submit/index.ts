/**
 * Public surface of the submission layer.
 *
 * The two human entry points live here: approveProposal (a tap on the Telegram
 * button or the dashboard) and rejectProposal. Everything else is re-exported so
 * the API, the workers and the tests import from one place.
 */

import { child } from '../lib/logger';
import { prisma } from '../lib/prisma';
import type { ProposalStatus } from '../types';
import { dispatch, recordAudit } from './dispatcher';
import type { SubmitAttemptResult } from './policy';

const log = child('submit');

/** Statuses a human may still approve. SUBMITTING is excluded: it is in flight. */
const APPROVABLE = new Set<string>(['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'FAILED']);
const REJECTABLE = new Set<string>(['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'FAILED', 'REJECTED']);

export interface ReviewOutcome {
  ok: boolean;
  proposalId: string;
  status: ProposalStatus | string;
  message: string;
  result?: SubmitAttemptResult;
}

/**
 * Marks a proposal approved and immediately dispatches it. The policy still
 * runs: approval answers "should this be sent", not "can this be sent", so
 * quotas and submitter capability are re-checked and a missing submitter turns
 * into a "submit it from the job page" outcome rather than a silent no-op.
 */
export async function approveProposal(proposalId: string, actor: string): Promise<ReviewOutcome> {
  const proposal = await prisma.proposal.findUnique({
    where: { id: proposalId },
    select: { id: true, status: true },
  });

  if (!proposal) {
    return { ok: false, proposalId, status: 'UNKNOWN', message: 'proposal not found' };
  }

  if (proposal.status === 'SUBMITTED') {
    return { ok: true, proposalId, status: proposal.status, message: 'already submitted' };
  }

  if (proposal.status === 'SUBMITTING') {
    return {
      ok: false,
      proposalId,
      status: proposal.status,
      message: 'a submission is already in flight for this proposal',
    };
  }

  if (!APPROVABLE.has(proposal.status)) {
    return {
      ok: false,
      proposalId,
      status: proposal.status,
      message: `proposal cannot be approved from status ${proposal.status}`,
    };
  }

  await prisma.proposal.update({
    where: { id: proposalId },
    data: { status: 'APPROVED', approvedAt: new Date(), approvedBy: actor },
  });

  await recordAudit('proposal.approved', proposalId, actor, {
    previousStatus: proposal.status,
  });

  log.info({ proposalId, actor }, 'proposal approved by a human');

  const result = await dispatch(proposalId, { actor, humanApproved: true });

  const after = await prisma.proposal.findUnique({
    where: { id: proposalId },
    select: { status: true },
  });

  return {
    ok: result.status === 'SUBMITTED' || result.status === 'DRY_RUN' || result.status === 'SKIPPED',
    proposalId,
    status: after?.status ?? 'APPROVED',
    message: result.message,
    result,
  };
}

/** Marks a proposal rejected. Idempotent: rejecting twice is not an error. */
export async function rejectProposal(
  proposalId: string,
  actor: string,
  reason?: string,
): Promise<ReviewOutcome> {
  const proposal = await prisma.proposal.findUnique({
    where: { id: proposalId },
    select: { id: true, status: true },
  });

  if (!proposal) {
    return { ok: false, proposalId, status: 'UNKNOWN', message: 'proposal not found' };
  }

  if (proposal.status === 'REJECTED') {
    return { ok: true, proposalId, status: proposal.status, message: 'already rejected' };
  }

  if (proposal.status === 'SUBMITTED' || !REJECTABLE.has(proposal.status)) {
    return {
      ok: false,
      proposalId,
      status: proposal.status,
      message: `proposal cannot be rejected from status ${proposal.status}`,
    };
  }

  const rejectionReason = (reason ?? '').trim() || 'rejected by operator';

  await prisma.proposal.update({
    where: { id: proposalId },
    data: { status: 'REJECTED', rejectedAt: new Date(), rejectionReason },
  });

  await recordAudit('proposal.rejected', proposalId, actor, {
    previousStatus: proposal.status,
    reason: rejectionReason,
  });

  log.info({ proposalId, actor, reason: rejectionReason }, 'proposal rejected by a human');

  return { ok: true, proposalId, status: 'REJECTED', message: rejectionReason };
}

/* ------------------------------------------------------------- re-exports */

export {
  decideSubmission,
  highRedFlags,
  isPreparable,
  MIN_COVER_LETTER_CHARS,
  parseRedFlags,
  persistsOwnSubmission,
  proposalGuardrailErrors,
} from './policy';
export type {
  PolicyDecision,
  PolicyInput,
  PolicyMatchView,
  PolicyProfileView,
  PolicyProposalView,
  PreparableSubmitter,
  SelfPersistingSubmitter,
  SubmissionAction,
  SubmitAttemptResult,
} from './policy';

export {
  checkQuota,
  connectsDayKey,
  CONNECTS_LEDGER_REASON,
  DEFAULT_CONNECTS_PER_PROPOSAL,
  estimateConnects,
  limitsFor,
  quotaSnapshot,
  readCounters,
  recordSubmission,
  SCOPE_CONNECTS_DAY,
  SCOPE_SUBMISSIONS_DAY,
  SCOPE_SUBMISSIONS_HOUR,
  submissionsDayKey,
  submissionsHourKey,
} from './quotas';
export type { QuotaCounters, QuotaDecision, RecordSubmissionResult } from './quotas';

export {
  APPROVE_ROUTE,
  buildActionUrl,
  buildProposalUrl,
  buildReviewNotification,
  fireReviewNotification,
  isReviewAction,
  PREVIEW_CHARS,
  REJECT_ROUTE,
  resetNotifierCache,
  REVIEW_ACTIONS,
  ReviewQueueSubmitter,
  reviewQueueSubmitter,
  signAction,
  SUBMITTER_NAME as REVIEW_QUEUE_SUBMITTER_NAME,
  verifyAction,
} from './review-queue';
export type { ReviewAction } from './review-queue';

export {
  ApiSubmitter,
  apiSubmitter,
  PROPOSAL_SUBMIT_OPERATION,
  SUBMITTER_NAME as API_SUBMITTER_NAME,
} from './api-submitter';
export type { ProposalSubmitOperation } from './api-submitter';

export {
  buildHeaders as buildWebhookHeaders,
  buildWebhookPayload,
  EVENT_HEADER,
  IDEMPOTENCY_HEADER,
  SIGNATURE_HEADER,
  SUBMITTER_NAME as WEBHOOK_SUBMITTER_NAME,
  TIMESTAMP_HEADER,
  WEBHOOK_EVENT,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_TIMEOUT_MS,
  WebhookSubmitter,
  webhookSubmitter,
} from './webhook-submitter';
export type { WebhookPayload } from './webhook-submitter';

export {
  DISPATCH_LOCK_TTL_MS,
  dispatch,
  parseQuestionAnswers,
  recordAudit,
  selectSubmitter,
  SUBMITTERS,
  submitterByName,
  submitterStatus,
} from './dispatcher';
export type { DispatchOptions, SubmitterStatus } from './dispatcher';
