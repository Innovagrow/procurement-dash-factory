/**
 * SMTP channel. One transporter is created on first use and reused; verification
 * happens lazily and only counts as fatal when the server rejects the
 * credentials, in which case the channel reports itself unconfigured instead of
 * throwing on every later send.
 */

import { createTransport, type Transporter } from 'nodemailer';
import { env, hasSmtp } from '../config/env';
import { ConfigError, UpstreamError, isRetryable, toErrorMessage } from '../lib/errors';
import { backoffDelay, sleep } from '../lib/http';
import { child } from '../lib/logger';
import type { NotificationChannel, NotificationMessage } from '../types';
import { escapeHtml, truncate } from './format';

const log = child('notify:email');

export const CHANNEL_NAME = 'email';

/** Re-verify at most this often; a transient SMTP hiccup must not stick. */
const VERIFY_TTL_MS = 10 * 60 * 1000;
const MAX_SEND_ATTEMPTS = 3;
const MAX_TEXT_CHARS = 40_000;

const RETRYABLE_SMTP_CODES = new Set([
  'ECONNECTION',
  'ECONNRESET',
  'ETIMEDOUT',
  'ESOCKET',
  'EDNS',
  'EAI_AGAIN',
  'EENVELOPE',
  'ESTREAM',
]);

let transporter: Transporter | null = null;
/** Set when the SMTP config itself is wrong; the channel then reports unconfigured. */
let configBroken = false;
let verifiedAt = 0;
let verifyInFlight: Promise<void> | null = null;

/** Test seam and recovery hook after the operator fixes the credentials. */
export function resetEmailTransport(): void {
  transporter = null;
  configBroken = false;
  verifiedAt = 0;
  verifyInFlight = null;
}

function readProp(err: unknown, key: string): unknown {
  if (!err || typeof err !== 'object') return undefined;
  return (err as Record<string, unknown>)[key];
}

function isAuthFailure(err: unknown): boolean {
  const code = readProp(err, 'code');
  if (code === 'EAUTH') return true;
  const responseCode = readProp(err, 'responseCode');
  return typeof responseCode === 'number' && [530, 534, 535, 538].includes(responseCode);
}

function isRetryableSmtpError(err: unknown): boolean {
  const responseCode = readProp(err, 'responseCode');
  // SMTP 4xx is "try later", 5xx is a permanent rejection.
  if (typeof responseCode === 'number') return responseCode >= 400 && responseCode < 500;
  const code = readProp(err, 'code');
  if (typeof code === 'string' && RETRYABLE_SMTP_CODES.has(code)) return true;
  return isRetryable(err);
}

function getTransporter(): Transporter | null {
  if (configBroken) return null;
  if (transporter) return transporter;
  if (!hasSmtp() || !env.SMTP_HOST) return null;

  try {
    const port = env.SMTP_PORT;
    transporter = createTransport({
      host: env.SMTP_HOST,
      port,
      secure: port === 465,
      connectionTimeout: env.HTTP_TIMEOUT_MS,
      greetingTimeout: env.HTTP_TIMEOUT_MS,
      socketTimeout: env.HTTP_TIMEOUT_MS,
      ...(env.SMTP_USER && env.SMTP_PASS
        ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } }
        : {}),
    });
    return transporter;
  } catch (err) {
    configBroken = true;
    log.error({ err }, 'smtp transport could not be created; email channel disabled');
    return null;
  }
}

async function ensureVerified(client: Transporter): Promise<void> {
  if (Date.now() - verifiedAt < VERIFY_TTL_MS) return;
  if (verifyInFlight) return verifyInFlight;

  verifyInFlight = (async () => {
    try {
      await client.verify();
      verifiedAt = Date.now();
      log.debug({ host: env.SMTP_HOST }, 'smtp connection verified');
    } catch (err) {
      if (isAuthFailure(err)) {
        configBroken = true;
        log.error({ err, host: env.SMTP_HOST }, 'smtp rejected the credentials; email channel disabled');
        throw new ConfigError(`smtp authentication failed: ${toErrorMessage(err)}`, {
          details: { host: env.SMTP_HOST },
        });
      }
      // Not fatal: some servers refuse a bare verify but accept real mail.
      log.warn({ err, host: env.SMTP_HOST }, 'smtp verify failed; sending anyway');
    } finally {
      verifyInFlight = null;
    }
  })();

  return verifyInFlight;
}

/* -------------------------------------------------------------- rendering */

export function renderTextBody(msg: NotificationMessage): string {
  const parts = [(msg.subject ?? '').trim(), (msg.body ?? '').trim()].filter(
    (part) => part.length > 0,
  );

  const actions = (msg.actions ?? []).filter((action) => action?.url && action?.label);
  if (actions.length > 0) {
    parts.push(actions.map((action) => `${action.label}: ${action.url}`).join('\n'));
  }
  if (msg.url) parts.push(`Open: ${msg.url}`);
  parts.push('-- \nUpBid');

  return truncate(parts.join('\n\n'), MAX_TEXT_CHARS);
}

export function renderHtmlBody(msg: NotificationMessage): string {
  const subject = escapeHtml((msg.subject ?? '').trim() || 'UpBid notification');
  const content =
    msg.html && msg.html.trim() !== ''
      ? msg.html
      : `<pre style="margin:0;white-space:pre-wrap;word-break:break-word;font:inherit">${escapeHtml(
          msg.body ?? '',
        )}</pre>`;

  const buttons = (msg.actions ?? [])
    .filter((action) => action?.url && action?.label)
    .map((action) => {
      const primary = action.label.trim().toLowerCase().startsWith('approve');
      const background = primary ? '#1f7a3f' : '#2b3440';
      return `<a href="${escapeHtml(action.url)}" style="display:inline-block;margin:0 8px 8px 0;padding:12px 20px;background:${background};color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600;font-size:15px">${escapeHtml(
        action.label,
      )}</a>`;
    })
    .join('');

  const footer = msg.url
    ? `<p style="margin:16px 0 0"><a href="${escapeHtml(msg.url)}" style="color:#3b6fd4">Open in UpBid</a></p>`
    : '';

  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${subject}</title>`,
    '<style>',
    'body{margin:0;padding:0;background:#f4f5f7;color:#1c2430;',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}',
    '.wrap{max-width:640px;margin:0 auto;padding:24px 16px}',
    '.card{background:#ffffff;border-radius:10px;padding:24px;border:1px solid #e2e5ea}',
    'h1{font-size:19px;line-height:1.35;margin:0 0 16px}',
    '.meta{color:#6b7684;font-size:12px;margin-top:20px}',
    '@media (max-width:480px){.wrap{padding:12px 8px}.card{padding:16px}h1{font-size:17px}}',
    '</style></head>',
    '<body><div class="wrap"><div class="card">',
    `<h1>${subject}</h1>`,
    `<div style="font-size:14px;line-height:1.55">${content}</div>`,
    buttons === '' ? '' : `<div style="margin-top:20px">${buttons}</div>`,
    footer,
    `<p class="meta">UpBid${msg.refType ? ` &middot; ${escapeHtml(msg.refType)}` : ''}${
      msg.refId ? ` ${escapeHtml(msg.refId)}` : ''
    }</p>`,
    '</div></div></body></html>',
  ].join('\n');
}

/* ---------------------------------------------------------------- channel */

export class EmailChannel implements NotificationChannel {
  readonly name = CHANNEL_NAME;

  isConfigured(): boolean {
    return hasSmtp() && !configBroken;
  }

  describeTarget(): string | null {
    return env.NOTIFY_EMAIL_TO ?? null;
  }

  async send(msg: NotificationMessage): Promise<void> {
    const to = env.NOTIFY_EMAIL_TO;
    const from = env.SMTP_FROM;
    const client = getTransporter();

    if (!client || !to || !from) {
      throw new ConfigError('email channel is not configured (SMTP_HOST/SMTP_FROM/NOTIFY_EMAIL_TO)');
    }

    await ensureVerified(client);

    const subject = truncate((msg.subject ?? '').trim() || 'UpBid notification', 200);
    const text = renderTextBody(msg);
    const html = renderHtmlBody(msg);

    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_SEND_ATTEMPTS; attempt += 1) {
      try {
        const info = await client.sendMail({ from, to, subject, text, html });
        log.debug(
          { messageId: info.messageId, accepted: info.accepted.length, refId: msg.refId },
          'email notification sent',
        );
        return;
      } catch (err) {
        lastError = err;
        if (isAuthFailure(err)) {
          configBroken = true;
          throw new ConfigError(`smtp authentication failed: ${toErrorMessage(err)}`, {
            details: { host: env.SMTP_HOST },
          });
        }
        if (!isRetryableSmtpError(err) || attempt === MAX_SEND_ATTEMPTS - 1) break;
        const delay = backoffDelay(attempt, 1000, 15_000);
        log.warn({ err, attempt, delayMs: delay }, 'smtp send failed, retrying');
        await sleep(delay);
      }
    }

    // A failed send invalidates the cached verification.
    verifiedAt = 0;
    throw new UpstreamError(`smtp send failed: ${toErrorMessage(lastError)}`, {
      details: { host: env.SMTP_HOST, to },
      cause: lastError,
    });
  }
}

export const emailChannel = new EmailChannel();

export default emailChannel;
