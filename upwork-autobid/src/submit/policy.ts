/**
 * The gate between "we drafted something" and "we sent something".
 *
 * Detection, scoring and drafting run unattended; this file decides whether the
 * last step may also run unattended. It is deliberately conservative: anything
 * that is not an explicit, fully satisfied yes becomes REVIEW (a human tap),
 * and only a structurally broken proposal becomes HOLD.
 */

import { env } from '../config/env';
import type {
  Decision,
  ProposalSubmitter,
  RedFlag,
  RedFlagSeverity,
  SubmitProfileView,
  SubmitResult,
} from '../types';
import type { QuotaDecision } from './quotas';

export type SubmissionAction = 'AUTO_SUBMIT' | 'REVIEW' | 'HOLD';

/** Profile fields the policy needs on top of what the submitters need. */
export interface PolicyProfileView extends SubmitProfileView {
  autoBidThreshold: number;
}

export interface PolicyMatchView {
  decision: Decision | string;
  score: number;
  redFlags: RedFlag[];
}

export interface PolicyProposalView {
  id: string;
  status: string;
  coverLetter: string;
  bidAmount: number | null;
  hourlyRate: number | null;
  warnings: string[];
}

export interface PolicyInput {
  profile: PolicyProfileView;
  match: PolicyMatchView;
  proposal: PolicyProposalView;
  /** Submitter that would run. Omitted means "none available" -> REVIEW. */
  submitter?: ProposalSubmitter | null;
  quota?: QuotaDecision;
  /** Set by approveProposal: a human already said yes, so the auto gates are moot. */
  humanApproved?: boolean;
}

export interface PolicyDecision {
  action: SubmissionAction;
  reason: string;
  /** Every gate that failed, in evaluation order. Useful in the audit trail. */
  blockers: string[];
  guardrailErrors: string[];
}

/** A cover letter shorter than this is a drafting failure, not a short pitch. */
export const MIN_COVER_LETTER_CHARS = 80;

/** Warnings that read like these mean the draft is unusable, not merely imperfect. */
const ERROR_WARNING_PATTERN = /^\s*(error|failed|invalid|blocked|guardrail)\b|guardrail/i;

const TERMINAL_PROPOSAL_STATUSES = new Set(['REJECTED', 'SUBMITTED', 'EXPIRED']);

/* -------------------------------------------------------------- json inputs */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toSeverity(value: unknown): RedFlagSeverity {
  const text = typeof value === 'string' ? value.toUpperCase() : '';
  if (text === 'HIGH' || text === 'MEDIUM' || text === 'LOW') return text;
  return 'LOW';
}

/** Parses the JSON column on JobProfileMatch back into RedFlag objects. */
export function parseRedFlags(value: unknown): RedFlag[] {
  if (!Array.isArray(value)) return [];
  const flags: RedFlag[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const code = typeof entry.code === 'string' ? entry.code : 'UNKNOWN';
    const message = typeof entry.message === 'string' ? entry.message : code;
    flags.push({ code, severity: toSeverity(entry.severity), message });
  }
  return flags;
}

export function highRedFlags(flags: RedFlag[]): RedFlag[] {
  return flags.filter((flag) => flag.severity === 'HIGH');
}

/* --------------------------------------------------------------- guardrails */

/**
 * Structural problems with the draft itself. Non-empty means HOLD: no submitter
 * and no human tap should be offered a proposal in this state.
 */
export function proposalGuardrailErrors(proposal: PolicyProposalView): string[] {
  const errors: string[] = [];

  const letter = (proposal.coverLetter ?? '').trim();
  if (letter.length === 0) {
    errors.push('cover letter is empty');
  } else if (letter.length < MIN_COVER_LETTER_CHARS) {
    errors.push(
      `cover letter is only ${letter.length} chars (minimum ${MIN_COVER_LETTER_CHARS})`,
    );
  }

  const { bidAmount, hourlyRate } = proposal;
  if (bidAmount !== null && (!Number.isFinite(bidAmount) || bidAmount <= 0)) {
    errors.push(`bid amount ${bidAmount} is not a positive number`);
  }
  if (hourlyRate !== null && (!Number.isFinite(hourlyRate) || hourlyRate <= 0)) {
    errors.push(`hourly rate ${hourlyRate} is not a positive number`);
  }
  if (bidAmount === null && hourlyRate === null) {
    errors.push('proposal carries neither a bid amount nor an hourly rate');
  }

  if (TERMINAL_PROPOSAL_STATUSES.has(proposal.status)) {
    errors.push(`proposal is in terminal status ${proposal.status}`);
  }

  for (const warning of proposal.warnings ?? []) {
    if (typeof warning === 'string' && ERROR_WARNING_PATTERN.test(warning)) {
      errors.push(`drafting guardrail: ${warning}`);
    }
  }

  return errors;
}

/* ------------------------------------------------------------------ decision */

function describeSubmitter(submitter: ProposalSubmitter | null | undefined): string {
  return submitter ? submitter.name : 'none';
}

/**
 * The single source of truth for "may this be sent without a human".
 * Every branch below that is not the final one falls closed into REVIEW.
 */
export function decideSubmission(input: PolicyInput): PolicyDecision {
  const { profile, match, proposal, submitter, quota } = input;

  const guardrailErrors = proposalGuardrailErrors(proposal);
  if (guardrailErrors.length > 0) {
    return {
      action: 'HOLD',
      reason: `proposal is not submittable: ${guardrailErrors.join('; ')}`,
      blockers: guardrailErrors,
      guardrailErrors,
    };
  }

  const blockers: string[] = [];
  const review = (reason: string): PolicyDecision => ({
    action: 'REVIEW',
    reason,
    blockers: [...blockers, reason],
    guardrailErrors,
  });

  const capable = Boolean(submitter && submitter.canAutoSubmit && submitter.isConfigured());

  // A human tap already answered the "should this be sent" question. The only
  // remaining gates are the ones that protect the account: a submitter that can
  // actually send, and the spend budget.
  if (input.humanApproved) {
    if (!capable) {
      return review(
        `approved by a human but the "${describeSubmitter(submitter)}" submitter cannot send ` +
          '(not configured, or it is the review queue): submit this one from the job page',
      );
    }
    if (quota && !quota.allowed) {
      return review(`approved by a human but ${quota.reason}`);
    }
    return {
      action: 'AUTO_SUBMIT',
      reason: `approved by a human; dispatching through "${describeSubmitter(submitter)}"`,
      blockers,
      guardrailErrors,
    };
  }

  if (!env.AUTO_SUBMIT) {
    return review('AUTO_SUBMIT is off, so every proposal goes to the approval queue');
  }
  if (!profile.autoSubmit) {
    return review(`profile "${profile.name}" has autoSubmit disabled`);
  }
  if (match.decision !== 'BID') {
    return review(`scoring decision is ${String(match.decision)}, not BID`);
  }
  if (!Number.isFinite(match.score) || match.score < profile.autoBidThreshold) {
    return review(
      `score ${match.score} is below the profile autoBidThreshold ${profile.autoBidThreshold}`,
    );
  }

  const high = highRedFlags(match.redFlags);
  if (high.length > 0) {
    return review(
      `HIGH red flag${high.length > 1 ? 's' : ''}: ${high.map((flag) => flag.code).join(', ')}`,
    );
  }

  if (!submitter) {
    return review('no submitter is available, so the review queue is the only route');
  }
  if (!submitter.canAutoSubmit) {
    return review(`submitter "${submitter.name}" never submits without a human tap`);
  }
  if (!submitter.isConfigured()) {
    return review(`submitter "${submitter.name}" is not fully configured`);
  }

  if (!quota) {
    return review('quota state is unknown, so auto-submission is not allowed');
  }
  if (!quota.allowed) {
    return review(quota.reason);
  }

  return {
    action: 'AUTO_SUBMIT',
    reason:
      `score ${match.score} >= threshold ${profile.autoBidThreshold}, no HIGH red flags, ` +
      `quota ok, submitting via "${submitter.name}"`,
    blockers,
    guardrailErrors,
  };
}

/* --------------------------------------------- shared submitter result shape */

/**
 * SubmitResult plus the extras the dispatcher persists. Submitters return this;
 * anything typed as plain SubmitResult still works.
 */
export interface SubmitAttemptResult extends SubmitResult {
  /** Exactly what was (or would have been) sent; stored in Submission.payload. */
  payload?: unknown;
  attempt?: number;
  /**
   * True when the failure is permanent for this submitter (missing scope, bad
   * config) and the dispatcher should hand the proposal to the review queue.
   */
  fallbackToReview?: boolean;
}

/** Submitters that write their own Submission row (the review queue does). */
export interface SelfPersistingSubmitter {
  readonly persistsOwnSubmission: boolean;
}

export function persistsOwnSubmission(submitter: ProposalSubmitter): boolean {
  return (submitter as Partial<SelfPersistingSubmitter>).persistsOwnSubmission === true;
}

/** Submitters that need an async check (a stored OAuth token) before isConfigured() is meaningful. */
export interface PreparableSubmitter {
  prepare(): Promise<void>;
}

export function isPreparable(
  submitter: ProposalSubmitter,
): submitter is ProposalSubmitter & PreparableSubmitter {
  return typeof (submitter as Partial<PreparableSubmitter>).prepare === 'function';
}
