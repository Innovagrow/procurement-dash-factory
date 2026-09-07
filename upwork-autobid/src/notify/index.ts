/**
 * Notification fan-out.
 *
 * notify() sends to every configured channel concurrently and never throws:
 * a dead channel must not take down the pipeline that produced the alert.
 * Every attempt - sent, failed, skipped or batched - lands in NotificationLog,
 * which is the audit trail the dashboard reads.
 */

import { UpstreamError, toErrorMessage } from '../lib/errors';
import { child } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import type { NotificationChannel, NotificationMessage } from '../types';
import { consoleChannel } from './console';
import { emailChannel } from './email';
import { slackChannel } from './slack';
import { telegramChannel } from './telegram';
import {
  buildApprovalRequest,
  buildDailyDigest,
  buildHotJobAlert,
  buildSubmittedConfirmation,
  buildSystemAlert,
  oneLine,
  parseMessageFacts,
  truncate,
  type ApprovalRequestInput,
  type DigestInput,
  type HotJobInput,
  type SubmittedInput,
  type SystemAlertInput,
} from './format';

const log = child('notify');

/** A channel that can name its destination for the audit trail. */
export interface DescribableChannel extends NotificationChannel {
  describeTarget?(): string | null;
}

export type NotificationLogStatus = 'SENT' | 'FAILED' | 'SKIPPED' | 'BATCHED';

export interface NotifyChannelResult {
  channel: string;
  ok: boolean;
  skipped: boolean;
  durationMs: number;
  error?: string;
}

export interface NotifyResult {
  delivered: number;
  failed: number;
  skipped: number;
  batched: boolean;
  durationMs: number;
  results: NotifyChannelResult[];
}

/** One channel must never hold the fan-out open. */
const CHANNEL_TIMEOUT_MS = 20_000;
const MAX_LOGGED_BODY_CHARS = 8_000;
const MAX_LOGGED_ERROR_CHARS = 2_000;

const PHONE_CHANNELS: DescribableChannel[] = [telegramChannel, slackChannel, emailChannel];

/* --------------------------------------------------------------- channels */

function safeIsConfigured(channel: NotificationChannel): boolean {
  try {
    return channel.isConfigured();
  } catch (err) {
    log.error({ err, channel: channel.name }, 'channel isConfigured threw; treating as unconfigured');
    return false;
  }
}

function safeTarget(channel: DescribableChannel): string | null {
  try {
    return channel.describeTarget?.() ?? null;
  } catch {
    return null;
  }
}

/**
 * Channels with complete credentials. The console channel is the fallback used
 * only when nothing else is set up, so a fresh deployment still surfaces alerts.
 */
export function getChannels(): DescribableChannel[] {
  const configured = PHONE_CHANNELS.filter(safeIsConfigured);
  return configured.length > 0 ? configured : [consoleChannel];
}

/** Every known channel, configured or not - for /health and the dashboard. */
export function getAllChannels(): DescribableChannel[] {
  return [...PHONE_CHANNELS, consoleChannel];
}

export interface ChannelStatus {
  name: string;
  configured: boolean;
  target: string | null;
  active: boolean;
}

export function channelStatus(): ChannelStatus[] {
  const active = new Set(getChannels().map((channel) => channel.name));
  return getAllChannels().map((channel) => ({
    name: channel.name,
    configured: safeIsConfigured(channel),
    target: safeTarget(channel),
    active: active.has(channel.name),
  }));
}

/* ------------------------------------------------------------- audit trail */

async function recordAttempt(
  channel: string,
  target: string | null,
  msg: NotificationMessage,
  status: NotificationLogStatus,
  error?: string,
): Promise<void> {
  try {
    const subject = truncate(msg.subject ?? '', 500);
    const body = truncate(msg.body ?? '', MAX_LOGGED_BODY_CHARS);
    await prisma.notificationLog.create({
      data: {
        channel,
        target,
        subject: subject === '' ? null : subject,
        body: body === '' ? null : body,
        refType: msg.refType ?? null,
        refId: msg.refId ?? null,
        status,
        error: error ? truncate(error, MAX_LOGGED_ERROR_CHARS) : null,
      },
    });
  } catch (err) {
    // Losing the audit row must not lose the notification.
    log.error({ err, channel, status }, 'could not persist notification log');
  }
}

/* ---------------------------------------------------------------- dispatch */

async function withTimeout<T>(task: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new UpstreamError(`${label} timed out after ${ms}ms`, { retryable: true })),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function sendVia(
  channel: DescribableChannel,
  msg: NotificationMessage,
): Promise<NotifyChannelResult> {
  const started = Date.now();
  const target = safeTarget(channel);

  if (!safeIsConfigured(channel)) {
    await recordAttempt(channel.name, target, msg, 'SKIPPED', 'channel is not configured');
    return {
      channel: channel.name,
      ok: false,
      skipped: true,
      durationMs: Date.now() - started,
      error: 'channel is not configured',
    };
  }

  try {
    await withTimeout(channel.send(msg), CHANNEL_TIMEOUT_MS, `${channel.name} send`);
    await recordAttempt(channel.name, target, msg, 'SENT');
    return { channel: channel.name, ok: true, skipped: false, durationMs: Date.now() - started };
  } catch (err) {
    const message = toErrorMessage(err);
    log.error(
      { err, channel: channel.name, refType: msg.refType, refId: msg.refId },
      'notification channel failed',
    );
    await recordAttempt(channel.name, target, msg, 'FAILED', message);
    return {
      channel: channel.name,
      ok: false,
      skipped: false,
      durationMs: Date.now() - started,
      error: message,
    };
  }
}

async function dispatch(
  msg: NotificationMessage,
  channels: DescribableChannel[],
): Promise<NotifyResult> {
  const started = Date.now();

  if (channels.length === 0) {
    log.warn({ refType: msg.refType, refId: msg.refId }, 'no notification channel available');
    return { delivered: 0, failed: 0, skipped: 0, batched: false, durationMs: 0, results: [] };
  }

  const settled = await Promise.allSettled(channels.map((channel) => sendVia(channel, msg)));

  const results: NotifyChannelResult[] = settled.map((entry, index) => {
    if (entry.status === 'fulfilled') return entry.value;
    // sendVia catches everything; this branch only guards against a future change.
    const name = channels[index]?.name ?? 'unknown';
    log.error({ err: entry.reason, channel: name }, 'notification dispatch rejected unexpectedly');
    return {
      channel: name,
      ok: false,
      skipped: false,
      durationMs: Date.now() - started,
      error: toErrorMessage(entry.reason),
    };
  });

  const result: NotifyResult = {
    delivered: results.filter((entry) => entry.ok).length,
    failed: results.filter((entry) => !entry.ok && !entry.skipped).length,
    skipped: results.filter((entry) => entry.skipped).length,
    batched: false,
    durationMs: Date.now() - started,
    results,
  };

  log.info(
    {
      refType: msg.refType,
      refId: msg.refId,
      urgent: msg.urgent === true,
      delivered: result.delivered,
      failed: result.failed,
      durationMs: result.durationMs,
    },
    'notification dispatched',
  );

  return result;
}

/* ------------------------------------------------------------ digest mode */

export interface DigestConfig {
  /** When on, non-urgent job alerts are buffered instead of sent one by one. */
  enabled: boolean;
  windowMinutes: number;
  maxBuffered: number;
}

const DIGEST_KEY = 'upbid:notify:digest';
const BATCHABLE_REF_TYPES = new Set(['job']);

let digestConfig: DigestConfig = { enabled: false, windowMinutes: 60, maxBuffered: 200 };

export function getDigestConfig(): DigestConfig {
  return { ...digestConfig };
}

export function configureDigest(patch: Partial<DigestConfig>): DigestConfig {
  digestConfig = {
    enabled: patch.enabled ?? digestConfig.enabled,
    windowMinutes: Math.max(1, Math.floor(patch.windowMinutes ?? digestConfig.windowMinutes)),
    maxBuffered: Math.max(1, Math.floor(patch.maxBuffered ?? digestConfig.maxBuffered)),
  };
  log.info(digestConfig, 'digest configuration updated');
  return getDigestConfig();
}

interface DigestEntry {
  at: string;
  subject: string;
  url: string | null;
  refType: string | null;
  refId: string | null;
  score: number | null;
}

function extractScore(msg: NotificationMessage): number | null {
  const { facts } = parseMessageFacts(msg.body ?? '');
  const scoreFact = facts.find((fact) => fact.label.toLowerCase() === 'score');
  if (!scoreFact) return null;
  const digits = scoreFact.value.match(/\d{1,3}/);
  if (!digits) return null;
  const parsed = Number(digits[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function shouldBatch(msg: NotificationMessage): boolean {
  if (!digestConfig.enabled) return false;
  if (msg.urgent === true) return false;
  return BATCHABLE_REF_TYPES.has(msg.refType ?? '');
}

async function bufferForDigest(msg: NotificationMessage): Promise<boolean> {
  const entry: DigestEntry = {
    at: new Date().toISOString(),
    subject: oneLine(msg.subject ?? ''),
    url: msg.url ?? null,
    refType: msg.refType ?? null,
    refId: msg.refId ?? null,
    score: extractScore(msg),
  };

  try {
    await redis.rpush(DIGEST_KEY, JSON.stringify(entry));
    await redis.ltrim(DIGEST_KEY, -digestConfig.maxBuffered, -1);
    await redis.expire(DIGEST_KEY, Math.max(300, digestConfig.windowMinutes * 60 * 4));
    return true;
  } catch (err) {
    // Fail open: a broken buffer must not swallow the alert.
    log.warn({ err, refId: msg.refId }, 'digest buffering failed; sending immediately');
    return false;
  }
}

async function drainDigest(): Promise<DigestEntry[]> {
  let raw: unknown;
  try {
    const replies = await redis.multi().lrange(DIGEST_KEY, 0, -1).del(DIGEST_KEY).exec();
    if (!replies || replies.length === 0) return [];
    const first = replies[0];
    if (!first || first[0]) return [];
    raw = first[1];
  } catch (err) {
    log.error({ err }, 'could not drain the digest buffer');
    return [];
  }

  if (!Array.isArray(raw)) return [];

  const entries: DigestEntry[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    try {
      const parsed: unknown = JSON.parse(item);
      if (!parsed || typeof parsed !== 'object') continue;
      const record = parsed as Record<string, unknown>;
      entries.push({
        at: typeof record.at === 'string' ? record.at : new Date().toISOString(),
        subject: typeof record.subject === 'string' ? record.subject : 'job alert',
        url: typeof record.url === 'string' ? record.url : null,
        refType: typeof record.refType === 'string' ? record.refType : null,
        refId: typeof record.refId === 'string' ? record.refId : null,
        score: typeof record.score === 'number' && Number.isFinite(record.score) ? record.score : null,
      });
    } catch {
      // A corrupt buffer entry is dropped rather than failing the whole digest.
      log.warn('dropping unparseable digest entry');
    }
  }
  return entries;
}

export async function pendingDigestCount(): Promise<number> {
  try {
    return await redis.llen(DIGEST_KEY);
  } catch (err) {
    log.warn({ err }, 'could not read the digest buffer length');
    return 0;
  }
}

/** Sends everything buffered as one digest. Returns null when nothing was queued. */
export async function flushDigest(): Promise<NotifyResult | null> {
  const entries = await drainDigest();
  if (entries.length === 0) return null;

  const message = buildDailyDigest({
    periodLabel: `last ${digestConfig.windowMinutes} min`,
    highlights: entries.map((entry) => ({
      title: entry.subject,
      score: entry.score,
      url: entry.url,
    })),
    notes: [`${entries.length} alert${entries.length === 1 ? '' : 's'} batched by digest mode`],
    maxHighlights: 20,
  });

  return dispatch(message, getChannels());
}

let flushTimer: NodeJS.Timeout | null = null;

/** Starts the periodic digest flush. Returns the stop function. */
export function startDigestFlusher(): () => void {
  stopDigestFlusher();
  const periodMs = Math.max(60_000, digestConfig.windowMinutes * 60_000);
  flushTimer = setInterval(() => {
    void flushDigest().catch((err: unknown) => log.error({ err }, 'digest flush failed'));
  }, periodMs);
  flushTimer.unref();
  log.info({ periodMs }, 'digest flusher started');
  return stopDigestFlusher;
}

export function stopDigestFlusher(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}

/* ----------------------------------------------------------------- public */

/**
 * Fans the message out to every configured channel. Never throws. Non-urgent
 * job alerts are buffered when digest mode is on.
 */
export async function notify(msg: NotificationMessage): Promise<NotifyResult> {
  try {
    if (shouldBatch(msg)) {
      const buffered = await bufferForDigest(msg);
      if (buffered) {
        await recordAttempt('digest', null, msg, 'BATCHED');
        log.debug({ refType: msg.refType, refId: msg.refId }, 'notification batched for the digest');
        return {
          delivered: 0,
          failed: 0,
          skipped: 0,
          batched: true,
          durationMs: 0,
          results: [],
        };
      }
    }
    return await dispatch(msg, getChannels());
  } catch (err) {
    // dispatch already swallows channel errors; this is the last-resort guard.
    log.error({ err, refType: msg.refType, refId: msg.refId }, 'notify failed unexpectedly');
    return { delivered: 0, failed: 1, skipped: 0, batched: false, durationMs: 0, results: [] };
  }
}

/** Sends now, bypassing digest batching. Use for approvals and critical alerts. */
export async function notifyUrgent(msg: NotificationMessage): Promise<NotifyResult> {
  const urgentMessage: NotificationMessage = { ...msg, urgent: true };
  try {
    return await dispatch(urgentMessage, getChannels());
  } catch (err) {
    log.error({ err, refId: msg.refId }, 'urgent notification failed unexpectedly');
    return { delivered: 0, failed: 1, skipped: 0, batched: false, durationMs: 0, results: [] };
  }
}

/** Aliases kept so callers that resolve this module by shape find a sender. */
export const sendNotification = notify;
export const notifyAll = notify;

/* --------------------------------------------------------- typed helpers */

export async function notifyHotJob(input: HotJobInput): Promise<NotifyResult> {
  return notify(buildHotJobAlert(input));
}

/** Approval requests always bypass batching: they are the one-tap path. */
export async function notifyApprovalRequest(input: ApprovalRequestInput): Promise<NotifyResult> {
  return notifyUrgent(buildApprovalRequest(input));
}

export async function notifySubmitted(input: SubmittedInput): Promise<NotifyResult> {
  return notify(buildSubmittedConfirmation(input));
}

export async function notifyDailyDigest(input: DigestInput): Promise<NotifyResult> {
  return notify(buildDailyDigest(input));
}

export async function notifySystemAlert(input: SystemAlertInput): Promise<NotifyResult> {
  const message = buildSystemAlert(input);
  return message.urgent === true ? notifyUrgent(message) : notify(message);
}

/* ---------------------------------------------------------------- re-exports */

export {
  buildApprovalRequest,
  buildDailyDigest,
  buildHotJobAlert,
  buildSubmittedConfirmation,
  buildSystemAlert,
  formatBudget,
  formatClient,
  formatCompetition,
  formatPosted,
  parseMessageFacts,
  renderBody,
  scoreBar,
  toRedFlags,
} from './format';

export type {
  ApprovalRequestInput,
  DigestHighlight,
  DigestInput,
  HotJobInput,
  MessageFact,
  NotifyJobView,
  NotifyMatchView,
  NotifyProfileView,
  NotifyProposalView,
  SubmittedInput,
  SystemAlertInput,
  SystemAlertKind,
  SystemAlertSeverity,
} from './format';

export { ConsoleChannel, consoleChannel } from './console';
export { EmailChannel, emailChannel, resetEmailTransport } from './email';
export { SlackChannel, slackChannel } from './slack';
export { TelegramChannel, escapeMarkdownV2, telegramChannel } from './telegram';

export default notify;
