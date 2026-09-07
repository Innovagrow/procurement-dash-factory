/**
 * Telegram channel. This is the one that has to reach a phone in seconds, so the
 * message is short, the approve/reject links become inline keyboard buttons, and
 * a 429 is honoured with the retry_after the Bot API hands back.
 */

import type { AxiosInstance } from 'axios';
import { env } from '../config/env';
import { peekRuntimeConfig } from '../config/runtime';
import { ConfigError, UpstreamError, toErrorMessage } from '../lib/errors';
import { RateLimiter, backoffDelay, createHttpClient, sleep } from '../lib/http';
import { child } from '../lib/logger';
import type { NotificationChannel, NotificationMessage } from '../types';
import { truncate } from './format';

const log = child('notify:telegram');

export const CHANNEL_NAME = 'telegram';
const TELEGRAM_API_BASE = 'https://api.telegram.org';

/** Bot API hard limits. */
const MAX_TEXT_CHARS = 4096;
const MAX_BUTTON_LABEL = 60;
const MAX_BUTTONS = 8;
const MAX_RETRY_AFTER_MS = 60_000;

/** The Bot API allows ~1 message per second per chat; stay under it. */
const limiter = new RateLimiter(3, 1);

let client: AxiosInstance | null = null;

function httpClient(): AxiosInstance {
  if (!client) {
    // Every non-2xx is a normal response here: the Bot API puts the real error
    // in the JSON body and we need parameters.retry_after from it.
    client = createHttpClient({ validateStatus: () => true });
  }
  return client;
}

/* -------------------------------------------------------------- formatting */

const MARKDOWN_V2_SPECIALS = /[_*[\]()~`>#+\-=|{}.!\\]/g;

/** Escapes every character MarkdownV2 reserves, backslash included. */
export function escapeMarkdownV2(text: string): string {
  return (text ?? '').replace(MARKDOWN_V2_SPECIALS, (character) => `\\${character}`);
}

export interface TelegramButton {
  text: string;
  url: string;
}

export interface TelegramPayload {
  chat_id: string;
  text: string;
  parse_mode?: 'MarkdownV2';
  disable_web_page_preview: boolean;
  reply_markup?: { inline_keyboard: TelegramButton[][] };
}

function isSupportedButtonUrl(url: string): boolean {
  return /^https?:\/\/\S+$/i.test(url.trim());
}

/**
 * Buttons from the message actions, plus a "View job" button for message.url
 * when that URL is not already covered by an action.
 */
export function buildInlineKeyboard(msg: NotificationMessage): TelegramButton[][] | null {
  const seen = new Set<string>();
  const buttons: TelegramButton[] = [];

  for (const action of msg.actions ?? []) {
    const url = (action?.url ?? '').trim();
    const label = (action?.label ?? '').trim();
    if (label === '' || !isSupportedButtonUrl(url) || seen.has(url)) continue;
    seen.add(url);
    buttons.push({ text: truncate(label, MAX_BUTTON_LABEL), url });
    if (buttons.length >= MAX_BUTTONS) break;
  }

  const jobUrl = (msg.url ?? '').trim();
  if (
    buttons.length < MAX_BUTTONS &&
    isSupportedButtonUrl(jobUrl) &&
    !seen.has(jobUrl)
  ) {
    buttons.push({ text: 'View job', url: jobUrl });
  }

  if (buttons.length === 0) return null;

  const rows: TelegramButton[][] = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }
  return rows;
}

function plainText(subject: string, body: string): string {
  const text = [subject.trim(), body.trim()].filter((part) => part.length > 0).join('\n');
  return truncate(text, MAX_TEXT_CHARS);
}

/**
 * Escaping inflates the text, so shrink the body until the escaped result fits
 * rather than cutting escaped output (which could strand a trailing backslash
 * and make the whole message unparseable).
 */
function markdownText(subject: string, body: string): string {
  const head = escapeMarkdownV2(truncate(subject, 200));
  let tail = body.trim();

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const text = tail === '' ? `*${head}*` : `*${head}*\n${escapeMarkdownV2(tail)}`;
    if (text.length <= MAX_TEXT_CHARS) return text;
    const overflow = text.length - MAX_TEXT_CHARS;
    const nextLength = Math.max(0, tail.length - overflow - 32);
    if (nextLength === 0) break;
    tail = `${tail.slice(0, nextLength).trimEnd()}\n...`;
  }

  return `*${head}*`;
}

export function buildTelegramPayload(
  msg: NotificationMessage,
  chatId: string,
  useMarkdown = true,
): TelegramPayload {
  const subject = (msg.subject ?? '').trim() || 'UpBid notification';
  const body = msg.body ?? '';
  const keyboard = buildInlineKeyboard(msg);

  const payload: TelegramPayload = {
    chat_id: chatId,
    text: useMarkdown ? markdownText(subject, body) : plainText(subject, body),
    disable_web_page_preview: true,
  };
  if (useMarkdown) payload.parse_mode = 'MarkdownV2';
  if (keyboard) payload.reply_markup = { inline_keyboard: keyboard };
  return payload;
}

/* ------------------------------------------------------------- transport */

interface TelegramResponse {
  ok?: boolean;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

function asTelegramResponse(data: unknown): TelegramResponse | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  const response: TelegramResponse = {};
  if (typeof record.ok === 'boolean') response.ok = record.ok;
  if (typeof record.description === 'string') response.description = record.description;
  if (typeof record.error_code === 'number') response.error_code = record.error_code;
  const parameters = record.parameters;
  if (parameters && typeof parameters === 'object') {
    const retryAfter = (parameters as Record<string, unknown>).retry_after;
    if (typeof retryAfter === 'number' && Number.isFinite(retryAfter)) {
      response.parameters = { retry_after: retryAfter };
    }
  }
  return response;
}

function retryAfterMs(response: TelegramResponse | null): number | null {
  const seconds = response?.parameters?.retry_after;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(1000, Math.ceil(seconds * 1000)));
}

interface TelegramCredentials {
  token: string;
  chatId: string;
}

/**
 * What the operator saved in the dashboard, falling back to the environment
 * until the runtime config has been read once. getRuntimeConfig already merges
 * env underneath the stored override, so the peeked values are the effective
 * ones; null only means "no load has completed in this process yet".
 */
function telegramCredentials(): TelegramCredentials {
  const notify = peekRuntimeConfig()?.notify;
  if (notify) return { token: notify.telegramBotToken, chatId: notify.telegramChatId };
  return { token: env.TELEGRAM_BOT_TOKEN ?? '', chatId: env.TELEGRAM_CHAT_ID ?? '' };
}

async function callSendMessage(
  payload: TelegramPayload,
  mode: string,
  token: string,
): Promise<void> {
  if (!token) throw new ConfigError('TELEGRAM_BOT_TOKEN is not set');

  // The token lives in the path, so the URL is never logged.
  const url = `${TELEGRAM_API_BASE}/bot${token}/sendMessage`;
  const maxRetries = env.HTTP_MAX_RETRIES;
  let lastDetail = 'no response';
  let lastStatus: number | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    await limiter.take();

    let status = 0;
    let body: TelegramResponse | null = null;

    try {
      const response = await httpClient().post<unknown>(url, payload);
      status = response.status;
      body = asTelegramResponse(response.data);
    } catch (err) {
      // validateStatus accepts every status, so this is a transport failure.
      lastDetail = toErrorMessage(err);
      if (attempt === maxRetries) break;
      const delay = backoffDelay(attempt, 500, 15_000);
      log.warn({ err, attempt, delayMs: delay, mode }, 'telegram request failed, retrying');
      await sleep(delay);
      continue;
    }

    if (status >= 200 && status < 300 && body?.ok === true) return;

    lastStatus = status;
    lastDetail = body?.description ?? `HTTP ${status}`;
    const errorCode = body?.error_code ?? status;

    if (errorCode === 429) {
      const wait = retryAfterMs(body) ?? backoffDelay(attempt, 1000, MAX_RETRY_AFTER_MS);
      if (attempt === maxRetries) break;
      log.warn({ attempt, waitMs: wait, mode }, 'telegram rate limited, honouring retry_after');
      await sleep(wait);
      continue;
    }

    if (errorCode >= 500) {
      if (attempt === maxRetries) break;
      const delay = backoffDelay(attempt, 500, 15_000);
      log.warn({ attempt, status, detail: lastDetail, delayMs: delay, mode }, 'telegram 5xx, retrying');
      await sleep(delay);
      continue;
    }

    // 400/401/403: bad chat id, revoked token, blocked bot. Retrying cannot help.
    throw new UpstreamError(`telegram sendMessage rejected: ${lastDetail}`, {
      upstreamStatus: status,
      retryable: false,
      details: { errorCode, mode },
    });
  }

  throw new UpstreamError(
    `telegram sendMessage failed after ${maxRetries + 1} attempts: ${lastDetail}`,
    { upstreamStatus: lastStatus, details: { mode } },
  );
}

function isParseError(err: unknown): boolean {
  if (!(err instanceof UpstreamError)) return false;
  return /can'?t parse entities|parse_mode/i.test(err.message);
}

/* --------------------------------------------------------------- channel */

export class TelegramChannel implements NotificationChannel {
  readonly name = CHANNEL_NAME;

  isConfigured(): boolean {
    const { token, chatId } = telegramCredentials();
    return Boolean(token && chatId);
  }

  /** Destination recorded on NotificationLog.target. */
  describeTarget(): string | null {
    const { chatId } = telegramCredentials();
    return chatId === '' ? null : chatId;
  }

  async send(msg: NotificationMessage): Promise<void> {
    const { token, chatId } = telegramCredentials();
    if (!chatId || !token) {
      throw new ConfigError('telegram channel is not configured (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID)');
    }

    try {
      await callSendMessage(buildTelegramPayload(msg, chatId, true), 'markdown', token);
    } catch (err) {
      if (!isParseError(err)) throw err;
      // An unescaped character slipped through; the operator still needs the alert.
      log.warn({ err, refId: msg.refId }, 'markdown rejected, resending as plain text');
      await callSendMessage(buildTelegramPayload(msg, chatId, false), 'plain', token);
    }

    log.debug({ refType: msg.refType, refId: msg.refId }, 'telegram notification sent');
  }
}

export const telegramChannel = new TelegramChannel();

export default telegramChannel;
