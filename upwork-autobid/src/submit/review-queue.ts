/**
 * The default submitter: a human approval queue.
 *
 * It never sends anything to Upwork. It parks the proposal in PENDING_APPROVAL,
 * records the attempt, and pushes a notification carrying one-tap Approve and
 * Reject links. The links are signed with an HMAC over (proposalId, action) so
 * the API can accept a tap from a phone without a session cookie.
 */

import { env, publicUrl } from '../config/env';
import { sha256, safeEqual, signPayload } from '../lib/hash';
import { child } from '../lib/logger';
import { prisma } from '../lib/prisma';
import type { NotificationMessage, ProposalSubmitter, SubmitContext } from '../types';
import type { SelfPersistingSubmitter, SubmitAttemptResult } from './policy';

const log = child('submit:review-queue');

export const SUBMITTER_NAME = 'review_queue';

export type ReviewAction = 'approve' | 'reject';

export const REVIEW_ACTIONS: readonly ReviewAction[] = ['approve', 'reject'] as const;

/** Routes the HTTP API is expected to expose for one-tap actions. */
export const APPROVE_ROUTE = '/api/proposals/:id/approve';
export const REJECT_ROUTE = '/api/proposals/:id/reject';

/** Characters of the cover letter included in the notification preview. */
export const PREVIEW_CHARS = 400;

export function isReviewAction(value: string): value is ReviewAction {
  return (REVIEW_ACTIONS as readonly string[]).includes(value);
}

/* ------------------------------------------------------------ signed links */

let warnedAboutMissingApiKey = false;

/**
 * API_KEY is mandatory in production; in development it may be unset, and a
 * hard-coded fallback would make every dev deployment share one signing key.
 * Deriving it from DATABASE_URL keeps the links deterministic across the API
 * and worker processes of one deployment without inventing a secret.
 */
function actionSecret(): string {
  if (env.API_KEY) return env.API_KEY;
  if (!warnedAboutMissingApiKey) {
    warnedAboutMissingApiKey = true;
    log.warn(
      'API_KEY is not set: approve/reject links are signed with a key derived from DATABASE_URL. ' +
        'Set API_KEY before exposing this instance.',
    );
  }
  return sha256(`upbid:action-signing:${env.DATABASE_URL}`);
}

function actionPayload(proposalId: string, action: ReviewAction): string {
  return `${proposalId}:${action}`;
}

/** HMAC-SHA256 token embedded in the one-tap approve/reject URLs. */
export function signAction(proposalId: string, action: ReviewAction): string {
  return signPayload(actionPayload(proposalId, action), actionSecret());
}

/** Constant-time verification of a token produced by signAction. */
export function verifyAction(proposalId: string, action: string, token: string): boolean {
  if (!isReviewAction(action)) return false;
  if (typeof token !== 'string' || token.length === 0) return false;
  return safeEqual(signAction(proposalId, action), token.trim().toLowerCase());
}

export function buildActionUrl(proposalId: string, action: ReviewAction): string {
  const token = signAction(proposalId, action);
  return publicUrl(
    `/api/proposals/${encodeURIComponent(proposalId)}/${action}?token=${encodeURIComponent(token)}`,
  );
}

export function buildProposalUrl(proposalId: string): string {
  return publicUrl(`/#/proposals/${encodeURIComponent(proposalId)}`);
}

/* ------------------------------------------------------------ notification */

function preview(text: string, max = PREVIEW_CHARS): string {
  const normalized = (text ?? '').replace(/\r\n/g, '\n').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max).trimEnd()}...`;
}

function formatMoney(amount: number | null): string {
  if (amount === null || !Number.isFinite(amount)) return 'n/a';
  return `$${amount.toFixed(2)}`;
}

function describeBid(ctx: SubmitContext): string {
  const hourly = String(ctx.job.jobType).toUpperCase() === 'HOURLY';
  if (hourly) {
    const rate = ctx.hourlyRate ?? ctx.profile.hourlyRate;
    return `${formatMoney(rate ?? null)}/hr`;
  }
  return formatMoney(ctx.bidAmount);
}

async function lookupScore(jobId: string, profileId: string): Promise<number | null> {
  try {
    const match = await prisma.jobProfileMatch.findUnique({
      where: { jobId_profileId: { jobId, profileId } },
      select: { score: true },
    });
    return match ? match.score : null;
  } catch (err) {
    log.warn({ err, jobId, profileId }, 'could not read match score for the notification');
    return null;
  }
}

export function buildReviewNotification(
  ctx: SubmitContext,
  score: number | null,
): NotificationMessage {
  const scoreLabel = score === null ? 'unscored' : `${score}/100`;
  const bid = describeBid(ctx);
  const approveUrl = buildActionUrl(ctx.proposalId, 'approve');
  const rejectUrl = buildActionUrl(ctx.proposalId, 'reject');

  const lines = [
    `${ctx.job.title}`,
    '',
    `Score: ${scoreLabel}   Bid: ${bid}   Profile: ${ctx.profile.name}`,
    `Job: ${ctx.job.url}`,
    '',
    preview(ctx.coverLetter),
    '',
    `Approve: ${approveUrl}`,
    `Reject: ${rejectUrl}`,
  ];

  const html = [
    `<p><strong>${escapeHtml(ctx.job.title)}</strong></p>`,
    `<p>Score: ${escapeHtml(scoreLabel)} &middot; Bid: ${escapeHtml(bid)} &middot; Profile: ${escapeHtml(ctx.profile.name)}</p>`,
    `<p><a href="${escapeHtml(ctx.job.url)}">Open the job on Upwork</a></p>`,
    `<pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(preview(ctx.coverLetter))}</pre>`,
    `<p><a href="${escapeHtml(approveUrl)}">Approve</a> &nbsp; <a href="${escapeHtml(rejectUrl)}">Reject</a></p>`,
  ].join('\n');

  return {
    subject: `Proposal ready (${scoreLabel}): ${ctx.job.title}`,
    body: lines.join('\n'),
    html,
    url: buildProposalUrl(ctx.proposalId),
    actions: [
      { label: 'Approve', url: approveUrl },
      { label: 'Reject', url: rejectUrl },
      { label: 'Open job', url: ctx.job.url },
    ],
    refType: 'proposal',
    refId: ctx.proposalId,
    urgent: true,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The notify package is a sibling module owned by the notification layer; it is
 * resolved lazily and by shape so a missing or renamed fan-out helper degrades
 * to a logged warning instead of taking the submission path down with it.
 */
type NotifyFn = (message: NotificationMessage) => unknown;

const NOTIFY_EXPORTS = [
  'notify',
  'sendNotification',
  'notifyAll',
  'dispatchNotification',
  'broadcast',
  'send',
] as const;

let cachedNotifier: NotifyFn | null | undefined;

function resolveNotifier(): NotifyFn | null {
  if (cachedNotifier !== undefined) return cachedNotifier;
  cachedNotifier = null;

  try {
    const loaded: unknown = require('../notify');
    const containers: Record<string, unknown>[] = [];
    if (loaded !== null && typeof loaded === 'object') {
      const record = loaded as Record<string, unknown>;
      containers.push(record);
      const fallback = record.default;
      if (fallback !== null && typeof fallback === 'object') {
        containers.push(fallback as Record<string, unknown>);
      }
    }

    for (const container of containers) {
      for (const name of NOTIFY_EXPORTS) {
        const candidate = container[name];
        if (typeof candidate === 'function') {
          cachedNotifier = (candidate as NotifyFn).bind(container) as NotifyFn;
          return cachedNotifier;
        }
      }
    }
    log.warn(
      { tried: NOTIFY_EXPORTS },
      'notify module exposes no recognised send function; approval links will only be visible in the dashboard',
    );
  } catch (err) {
    log.warn({ err }, 'notify module could not be loaded; approval links are dashboard-only');
  }

  return cachedNotifier;
}

/** Sends the review notification. Never throws: queueing must survive a dead channel. */
export async function fireReviewNotification(message: NotificationMessage): Promise<boolean> {
  const notifier = resolveNotifier();
  if (!notifier) return false;
  try {
    await notifier(message);
    return true;
  } catch (err) {
    log.error({ err, refId: message.refId }, 'review notification failed to send');
    return false;
  }
}

/** Test seam: forget the resolved notify function. */
export function resetNotifierCache(): void {
  cachedNotifier = undefined;
}

/* -------------------------------------------------------------- the queue */

export class ReviewQueueSubmitter implements ProposalSubmitter, SelfPersistingSubmitter {
  readonly name = SUBMITTER_NAME;

  /** The whole point of this submitter: a person taps before anything is sent. */
  readonly canAutoSubmit = false;

  readonly persistsOwnSubmission = true;

  isConfigured(): boolean {
    return true;
  }

  async submit(ctx: SubmitContext): Promise<SubmitAttemptResult> {
    const existing = await prisma.submission.findFirst({
      where: { proposalId: ctx.proposalId, status: 'QUEUED_FOR_REVIEW' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, attempt: true },
    });

    const proposal = await prisma.proposal.findUnique({
      where: { id: ctx.proposalId },
      select: { status: true },
    });

    // Re-running the same job must not enqueue a second review or re-ping the phone.
    if (existing && proposal?.status === 'PENDING_APPROVAL') {
      log.debug({ proposalId: ctx.proposalId }, 'proposal already awaiting approval');
      return {
        status: 'QUEUED_FOR_REVIEW',
        externalRef: existing.id,
        message: 'already waiting for human approval',
        attempt: existing.attempt,
      };
    }

    await prisma.proposal.update({
      where: { id: ctx.proposalId },
      data: { status: 'PENDING_APPROVAL' },
    });

    const score = await lookupScore(ctx.job.id, ctx.profile.id);
    const attempt = (existing?.attempt ?? 0) + 1;

    const row = await prisma.submission.create({
      data: {
        proposalId: ctx.proposalId,
        submitter: SUBMITTER_NAME,
        status: 'QUEUED_FOR_REVIEW',
        message: `awaiting human approval (score ${score ?? 'n/a'})`,
        attempt,
        connectsSpent: 0,
      },
      select: { id: true },
    });

    const message = buildReviewNotification(ctx, score);
    const notified = await fireReviewNotification(message);

    log.info(
      { proposalId: ctx.proposalId, jobId: ctx.job.id, score, notified, attempt },
      'proposal queued for human approval',
    );

    return {
      status: 'QUEUED_FOR_REVIEW',
      externalRef: row.id,
      message: notified
        ? 'queued for human approval; approve/reject links sent'
        : 'queued for human approval; no notification channel accepted the message',
      connectsSpent: 0,
      attempt,
    };
  }
}

export const reviewQueueSubmitter = new ReviewQueueSubmitter();

export default reviewQueueSubmitter;
