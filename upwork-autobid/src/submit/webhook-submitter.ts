/**
 * Hands the finished proposal to an endpoint the operator runs themselves.
 *
 * UpBid signs the exact bytes it sends with HMAC-SHA256 over SUBMIT_WEBHOOK_SECRET
 * so the receiver can prove the payload came from this instance, and repeats the
 * proposal id as an idempotency key so a retried delivery is recognisable.
 */

import type { AxiosResponse } from 'axios';
import { env } from '../config/env';
import { isRetryable, toErrorMessage } from '../lib/errors';
import { backoffDelay, createHttpClient, parseRetryAfter, requestWithRetry, sleep } from '../lib/http';
import { signPayload } from '../lib/hash';
import { child } from '../lib/logger';
import type { ProposalSubmitter, QuestionAnswer, SubmitContext } from '../types';
import type { SubmitAttemptResult } from './policy';
import { estimateConnects } from './quotas';

const log = child('submit:webhook');

export const SUBMITTER_NAME = 'webhook';

export const SIGNATURE_HEADER = 'X-Upbid-Signature';
export const IDEMPOTENCY_HEADER = 'X-Upbid-Idempotency-Key';
export const TIMESTAMP_HEADER = 'X-Upbid-Timestamp';
export const EVENT_HEADER = 'X-Upbid-Event';

export const WEBHOOK_EVENT = 'proposal.submit';
export const WEBHOOK_TIMEOUT_MS = 30_000;
export const WEBHOOK_MAX_ATTEMPTS = 4; // first try plus three retries

export interface WebhookPayload {
  event: typeof WEBHOOK_EVENT;
  idempotencyKey: string;
  sentAt: string;
  dryRun: boolean;
  proposal: {
    id: string;
    coverLetter: string;
    bidAmount: number | null;
    hourlyRate: number | null;
    questionAnswers: QuestionAnswer[];
  };
  job: {
    id: string;
    source: string;
    externalId: string;
    url: string;
    title: string;
    jobType: string;
    budgetAmount: number | null;
    connectsRequired: number | null;
  };
  profile: {
    id: string;
    name: string;
    hourlyRate: number | null;
  };
}

const webhookClient = createHttpClient({
  timeoutMs: WEBHOOK_TIMEOUT_MS,
  // Read 4xx bodies instead of throwing: they explain why the receiver refused.
  validateStatus: () => true,
});

let warnedAboutMissingSecret = false;

export function buildWebhookPayload(ctx: SubmitContext, at: Date = new Date()): WebhookPayload {
  return {
    event: WEBHOOK_EVENT,
    idempotencyKey: ctx.proposalId,
    sentAt: at.toISOString(),
    dryRun: ctx.dryRun,
    proposal: {
      id: ctx.proposalId,
      coverLetter: ctx.coverLetter,
      bidAmount: ctx.bidAmount,
      hourlyRate: ctx.hourlyRate,
      questionAnswers: ctx.questionAnswers,
    },
    job: {
      id: ctx.job.id,
      source: ctx.job.source,
      externalId: ctx.job.externalId,
      url: ctx.job.url,
      title: ctx.job.title,
      jobType: String(ctx.job.jobType),
      budgetAmount: ctx.job.budgetAmount,
      connectsRequired: ctx.job.connectsRequired,
    },
    profile: {
      id: ctx.profile.id,
      name: ctx.profile.name,
      hourlyRate: ctx.profile.hourlyRate,
    },
  };
}

export function buildHeaders(rawBody: string, proposalId: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [IDEMPOTENCY_HEADER]: proposalId,
    [TIMESTAMP_HEADER]: String(Date.now()),
    [EVENT_HEADER]: WEBHOOK_EVENT,
  };

  if (env.SUBMIT_WEBHOOK_SECRET) {
    headers[SIGNATURE_HEADER] = signPayload(rawBody, env.SUBMIT_WEBHOOK_SECRET);
  } else if (!warnedAboutMissingSecret) {
    warnedAboutMissingSecret = true;
    log.warn(
      'SUBMIT_WEBHOOK_SECRET is not set: payloads are delivered unsigned and the receiver ' +
        'cannot verify they came from UpBid',
    );
  }

  return headers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Pulls a reference id out of whatever shape the receiver answered with. */
function externalRefFrom(body: unknown): string | null {
  if (typeof body === 'string' && body.trim().length > 0 && body.length <= 200) {
    return body.trim();
  }
  if (!isRecord(body)) return null;
  for (const key of ['externalRef', 'id', 'ref', 'reference', 'proposalId', 'submissionId']) {
    const value = body[key];
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number') return String(value);
  }
  return null;
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!isRecord(headers)) return undefined;
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function describeBody(body: unknown): string {
  if (body === undefined || body === null) return '';
  const text = typeof body === 'string' ? body : safeStringify(body);
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '[unserializable]';
  }
}

export class WebhookSubmitter implements ProposalSubmitter {
  readonly name = SUBMITTER_NAME;

  readonly canAutoSubmit: boolean;

  constructor() {
    this.canAutoSubmit = Boolean(env.SUBMIT_WEBHOOK_URL);
  }

  isConfigured(): boolean {
    return Boolean(env.SUBMIT_WEBHOOK_URL);
  }

  configurationHint(): string {
    return this.isConfigured() ? 'configured' : 'SUBMIT_WEBHOOK_URL is not set';
  }

  async submit(ctx: SubmitContext): Promise<SubmitAttemptResult> {
    const url = env.SUBMIT_WEBHOOK_URL;
    const payload = buildWebhookPayload(ctx);
    const connects = estimateConnects(ctx.job);

    if (!url) {
      return {
        status: 'FAILED',
        message: 'webhook submitter is not usable: SUBMIT_WEBHOOK_URL is not set',
        payload,
        attempt: 0,
        fallbackToReview: true,
      };
    }

    if (ctx.dryRun || env.DRY_RUN) {
      log.info({ proposalId: ctx.proposalId, url }, 'dry run: webhook delivery skipped');
      return {
        status: 'DRY_RUN',
        message: `DRY_RUN: would POST the proposal payload to ${url}`,
        payload,
        attempt: 0,
        connectsSpent: 0,
      };
    }

    const rawBody = JSON.stringify(payload);
    const headers = buildHeaders(rawBody, ctx.proposalId);
    const label = `POST submit-webhook proposal=${ctx.proposalId}`;

    let attempt = 0;
    let lastMessage = 'no attempt was made';

    while (attempt < WEBHOOK_MAX_ATTEMPTS) {
      attempt += 1;

      let response: AxiosResponse<unknown>;
      try {
        response = await requestWithRetry<unknown>(
          {
            url,
            method: 'POST',
            // Send the exact bytes that were signed; axios must not re-serialise.
            data: rawBody,
            headers,
            timeout: WEBHOOK_TIMEOUT_MS,
          },
          { client: webhookClient, label, maxRetries: 0 },
        );
      } catch (err) {
        lastMessage = toErrorMessage(err);
        log.warn({ err, proposalId: ctx.proposalId, attempt, url }, 'webhook delivery failed');
        if (attempt < WEBHOOK_MAX_ATTEMPTS && isRetryable(err)) {
          await sleep(backoffDelay(attempt));
          continue;
        }
        return {
          status: 'FAILED',
          message: `webhook delivery failed after ${attempt} attempt(s): ${lastMessage}`,
          payload,
          attempt,
        };
      }

      const status = response.status;

      if (status >= 200 && status < 300) {
        const externalRef = externalRefFrom(response.data) ?? ctx.proposalId;
        log.info({ proposalId: ctx.proposalId, status, externalRef, attempt }, 'webhook accepted the proposal');
        return {
          status: 'SUBMITTED',
          externalRef,
          message: `accepted by ${url} with HTTP ${status}`,
          connectsSpent: connects,
          payload,
          attempt,
        };
      }

      if (status === 429 || status >= 500) {
        lastMessage = `webhook answered HTTP ${status}${describeBody(response.data) ? `: ${describeBody(response.data)}` : ''}`;
        log.warn({ proposalId: ctx.proposalId, status, attempt }, lastMessage);
        if (attempt < WEBHOOK_MAX_ATTEMPTS) {
          const retryAfterMs = parseRetryAfter(headerValue(response.headers, 'retry-after'));
          await sleep(Math.min(retryAfterMs ?? backoffDelay(attempt), 30_000));
          continue;
        }
        return {
          status: 'FAILED',
          message: `${lastMessage} (gave up after ${attempt} attempts)`,
          payload,
          attempt,
        };
      }

      // Any other 4xx is the receiver refusing this specific payload; retrying
      // it unchanged would only repeat the refusal.
      const detail = describeBody(response.data);
      log.error({ proposalId: ctx.proposalId, status, attempt }, 'webhook rejected the proposal');
      return {
        status: 'FAILED',
        message: `webhook rejected the proposal with HTTP ${status}${detail ? `: ${detail}` : ''}`,
        payload,
        attempt,
      };
    }

    return {
      status: 'FAILED',
      message: `webhook delivery exhausted ${WEBHOOK_MAX_ATTEMPTS} attempts: ${lastMessage}`,
      payload,
      attempt,
    };
  }
}

export const webhookSubmitter = new WebhookSubmitter();

export default webhookSubmitter;
