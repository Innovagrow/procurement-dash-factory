/**
 * IMAP source: parses Upwork job-alert emails.
 *
 * Two paths share one parser. The watcher keeps a connection open and reacts to
 * untagged EXISTS notifications (imapflow puts an idle connection into IMAP
 * IDLE automatically, which is what delivers them within seconds of delivery),
 * buffering what it finds. The BullMQ poll then drains that buffer and also runs
 * its own short-lived search, so a dropped IDLE connection can never stall
 * detection for longer than one poll interval.
 *
 * A third path is diagnostic and never ingests anything: testImapConnection()
 * answers "is my mail wired up, and if not, what exactly is wrong", and
 * previewLatestAlert() answers "what does a job-alert email actually contain",
 * which no Upwork documentation states. Both run through the same parser as the
 * pipeline, so what they report is what ingestion would see.
 */

import { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import { hasImap } from '../config/env';
import { getRuntimeConfig, peekRuntimeConfig } from '../config/runtime';
import { ConfigError, toErrorMessage, UpstreamError } from '../lib/errors';
import { backoffDelay, sleep } from '../lib/http';
import { child } from '../lib/logger';
import { isMasked } from '../lib/secrets';
import { daysAgo, toIso } from '../lib/time';
import type { RawJob, SourceContext, SourceResult } from '../types';
import { BaseSource, isSourceSelected } from './base';
import { parseUpworkFieldBlock } from './rss';
import {
  collapseWhitespace,
  decodeEntities,
  extractCiphertext,
  parseHourlyRange,
  parseMoney,
  safeNormalizeJob,
  stripHtml,
} from './normalize';

export const SOURCE_NAME = 'imap';
const SOURCE_ALIASES = ['email', 'imap_email', 'mail'];

const log = child('source:imap');

const MAX_MESSAGES_PER_RUN = 60;
const MAX_BUFFERED_JOBS = 500;
const WATCHER_SWEEP_MS = 5 * 60_000;
const HARVEST_DEBOUNCE_MS = 1500;
const CONNECT_TIMEOUT_MS = 20_000;
/** Cap on how long a teardown may block the caller before the socket is cut. */
const LOGOUT_TIMEOUT_MS = 3_000;

/* ------------------------------------------------------------- settings */

/** The connection parameters, after the runtime/env layers have been merged. */
export interface ImapSettings {
  host: string;
  port: number;
  user: string;
  password: string;
  mailbox: string;
  searchFrom: string;
  secure: boolean;
}

/**
 * One-off values that win over the stored configuration, so the operator can
 * try credentials from the dashboard before committing them.
 */
export interface ImapSettingsOverrides {
  host?: string | null;
  port?: number | null;
  user?: string | null;
  password?: string | null;
  mailbox?: string | null;
  searchFrom?: string | null;
  tls?: boolean | null;
}

function overrideString(value: string | null | undefined, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function overrideInt(value: number | null | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback;
  return value < 1 || value > 65535 ? fallback : value;
}

/**
 * Effective settings: database override, then env, then the supplied overrides
 * on top. getRuntimeConfig() never rejects, so this degrades to env alone when
 * the database is unreachable.
 */
export async function resolveImapSettings(
  overrides: ImapSettingsOverrides = {},
): Promise<ImapSettings> {
  const stored = (await getRuntimeConfig()).imap;

  // A masked password is the dashboard's own render coming back unedited, not a
  // credential, so the stored one stays in force.
  const password =
    isMasked(overrides.password) ? stored.password : overrideString(overrides.password, stored.password);

  return {
    host: overrideString(overrides.host, stored.host),
    port: overrideInt(overrides.port, stored.port),
    user: overrideString(overrides.user, stored.user),
    password,
    mailbox: overrideString(overrides.mailbox, stored.mailbox) || 'INBOX',
    searchFrom: overrideString(overrides.searchFrom, stored.searchFrom),
    secure: typeof overrides.tls === 'boolean' ? overrides.tls : stored.tls,
  };
}

/** Names of the credential fields that are still blank. */
function missingImapFields(settings: ImapSettings): string[] {
  const missing: string[] = [];
  if (settings.host === '') missing.push('host');
  if (settings.user === '') missing.push('user');
  if (settings.password === '') missing.push('password');
  return missing;
}

function notConfiguredMessage(missing: string[]): string {
  const single = missing.length === 1;
  return `IMAP is not configured: ${missing.join(', ')} ${single ? 'is' : 'are'} empty. Fill ${single ? 'it' : 'them'} in on the settings screen, or set IMAP_HOST, IMAP_USER and IMAP_PASSWORD.`;
}

/* --------------------------------------------------------- client plumbing */

interface MailboxLock {
  release(): void;
}

interface EnvelopeAddress {
  name?: string;
  address?: string;
}

interface MessageEnvelope {
  subject?: string;
  date?: Date;
  from?: EnvelopeAddress[];
}

interface FetchedMessage {
  uid: number;
  source?: Buffer;
  envelope?: MessageEnvelope;
}

interface MailboxInfo {
  path: string;
  exists: number;
}

interface MailboxStatus {
  unseen?: number;
  messages?: number;
}

/**
 * Structural view of the imapflow surface we depend on. Keeping it local means
 * a typings change upstream cannot break the build, and every call site stays
 * typed on our side.
 */
interface ImapClientLike {
  usable: boolean;
  connect(): Promise<void>;
  logout(): Promise<void>;
  close(): void;
  getMailboxLock(path: string, options?: { readOnly?: boolean }): Promise<MailboxLock>;
  mailboxOpen(path: string, options?: { readOnly?: boolean }): Promise<MailboxInfo>;
  status(path: string, query: Record<string, boolean>): Promise<MailboxStatus>;
  search(query: Record<string, unknown>, options?: { uid?: boolean }): Promise<number[] | false>;
  fetch(
    range: string | number[],
    query: Record<string, unknown>,
    options?: { uid?: boolean },
  ): AsyncIterable<FetchedMessage>;
  messageFlagsAdd(
    range: string | number[],
    flags: string[],
    options?: { uid?: boolean },
  ): Promise<boolean>;
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeAllListeners(): void;
}

function createImapClient(settings: ImapSettings): ImapClientLike {
  const missing = missingImapFields(settings);
  if (missing.length > 0) {
    throw new ConfigError(notConfiguredMessage(missing));
  }

  const options = {
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    auth: { user: settings.user, pass: settings.password },
    logger: false,
    emitLogs: false,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: 5 * 60_000,
    clientInfo: { name: 'UpBid', version: '1.0.0' },
  };

  const client = new ImapFlow(options as unknown as ConstructorParameters<typeof ImapFlow>[0]);
  return client as unknown as ImapClientLike;
}

/** Best-effort teardown that can never outlive LOGOUT_TIMEOUT_MS. */
async function closeQuietly(client: ImapClientLike): Promise<void> {
  try {
    await withTimeout(client.logout(), LOGOUT_TIMEOUT_MS);
  } catch {
    try {
      client.close();
    } catch {
      // Socket already gone.
    }
  }
}

/** Rejects with ImapTimeoutError when `work` has not settled in time. */
class ImapTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.name = 'ImapTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ImapTimeoutError(timeoutMs)), timeoutMs);
    timer.unref?.();
  });

  // Promise.race subscribes to both, so a late rejection from `work` is still
  // handled and cannot surface as an unhandled rejection.
  return Promise.race([work, expiry]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/* ------------------------------------------------------------- extraction */

const ANCHOR_RE = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
const SENTINEL_RE = /@@UPBIDLINK\|([^|]*)\|([^@]*)@@/g;
const BARE_URL_RE = /https?:\/\/[^\s<>"')\]]+/g;
const BARE_URL_TEST_RE = /https?:\/\/[^\s<>"')\]]+/;

const JUNK_LINK_TEXT = [
  'view job',
  'view the job',
  'apply now',
  'submit a proposal',
  'unsubscribe',
  'settings',
  'privacy policy',
  'terms of service',
  'help center',
  'see more jobs',
  'view all',
  'upwork',
];

function isJunkTitle(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  if (normalized.length < 8) return true;
  return JUNK_LINK_TEXT.some((junk) => normalized === junk || normalized.startsWith(junk));
}

interface LinkHit {
  url: string;
  title: string | null;
  block: string;
}

/** Rewrites anchors to sentinels so link text and the following copy stay paired. */
function markupToText(html: string): string {
  const marked = html.replace(ANCHOR_RE, (_match, href: string, inner: string) => {
    const safeHref = String(href).replace(/[|@]/g, '');
    const label = stripHtml(String(inner)).replace(/[|@\n]/g, ' ').trim();
    return `\n@@UPBIDLINK|${safeHref}|${label}@@\n`;
  });
  return stripHtml(marked);
}

function hitsFromHtml(html: string): LinkHit[] {
  const text = markupToText(html);
  const hits: LinkHit[] = [];
  const matches: { url: string; title: string; start: number; end: number }[] = [];

  SENTINEL_RE.lastIndex = 0;
  for (;;) {
    const match = SENTINEL_RE.exec(text);
    if (!match) break;
    matches.push({
      url: decodeEntities(match[1] ?? ''),
      title: collapseWhitespace(decodeEntities(match[2] ?? '')),
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    const next = matches[index + 1];
    const blockEnd = next ? next.start : Math.min(text.length, current.end + 2000);
    hits.push({
      url: current.url,
      title: current.title === '' ? null : current.title,
      block: text.slice(current.end, blockEnd),
    });
  }

  return hits;
}

function hitsFromText(text: string): LinkHit[] {
  const normalized = collapseWhitespace(decodeEntities(text));
  const lines = normalized.split('\n');
  const hits: LinkHit[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    BARE_URL_RE.lastIndex = 0;
    const urls = line.match(BARE_URL_RE);
    if (!urls) continue;

    for (const url of urls) {
      // Prefer the previous non-empty line as the title; fall back to the line itself.
      let title: string | null = null;
      for (let back = index - 1; back >= 0 && back >= index - 3; back -= 1) {
        const candidate = (lines[back] ?? '').trim();
        if (candidate !== '' && !BARE_URL_TEST_RE.test(candidate)) {
          title = candidate;
          break;
        }
      }
      const inline = line.replace(url, '').trim();
      if (title === null && inline !== '') title = inline;

      hits.push({
        url,
        title,
        block: lines.slice(index, index + 15).join('\n'),
      });
    }
  }

  return hits;
}

export interface EmailPayload {
  html: string | null;
  text: string | null;
  subject: string | null;
  receivedAt: Date | null;
}

/** Extracts every distinct Upwork job posting referenced by one alert email. */
export function extractJobsFromEmail(payload: EmailPayload): RawJob[] {
  const hits = payload.html ? hitsFromHtml(payload.html) : [];
  if (hits.length === 0 && payload.text) hits.push(...hitsFromText(payload.text));

  const byCiphertext = new Map<string, RawJob>();

  for (const hit of hits) {
    const ciphertext = extractCiphertext(hit.url);
    if (ciphertext === null) continue;
    if (byCiphertext.has(ciphertext)) continue;

    const fields = parseUpworkFieldBlock(hit.block);
    const hourly = parseHourlyRange(fields.hourlyRangeText);
    const budget = parseMoney(fields.budgetText);

    const candidateTitle =
      hit.title !== null && !isJunkTitle(hit.title)
        ? hit.title
        : firstMeaningfulLine(hit.block) ?? payload.subject;

    const description = fields.lead !== '' ? fields.lead : collapseWhitespace(hit.block);

    const job = safeNormalizeJob({
      source: SOURCE_NAME,
      url: hit.url,
      ciphertext,
      externalId: ciphertext,
      title: candidateTitle,
      description,
      postedAt: fields.postedOnText ?? payload.receivedAt,
      skills: fields.skillsText,
      category: fields.category,
      jobType: hourly.min !== null || hourly.max !== null ? 'HOURLY' : budget !== null ? 'FIXED' : null,
      budgetAmount: budget,
      hourlyMin: hourly.min,
      hourlyMax: hourly.max,
      experienceLevel: fields.experienceLevel,
      client: { country: fields.country },
      raw: { subject: payload.subject, block: hit.block.slice(0, 4000), url: hit.url },
    });

    if (job) byCiphertext.set(ciphertext, job);
  }

  return Array.from(byCiphertext.values());
}

/** What one alert message yielded, before anything is ingested or displayed. */
export interface ParsedAlertMessage {
  payload: EmailPayload;
  /** Display form of the From header, e.g. `Upwork <no-reply@upwork.com>`. */
  from: string | null;
  jobs: RawJob[];
}

function addressText(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const text = (value as { text?: unknown }).text;
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The one place raw RFC822 bytes become jobs. The poll path, the IDLE watcher
 * and the diagnostics all go through it, so a preview shows exactly what
 * ingestion would have produced from the same message.
 */
export async function parseAlertMessage(source: Buffer): Promise<ParsedAlertMessage> {
  const parsed: ParsedMail = await simpleParser(source);

  const payload: EmailPayload = {
    html: typeof parsed.html === 'string' ? parsed.html : null,
    text: typeof parsed.text === 'string' ? parsed.text : null,
    subject: typeof parsed.subject === 'string' ? parsed.subject : null,
    receivedAt: parsed.date instanceof Date ? parsed.date : null,
  };

  return { payload, from: addressText(parsed.from), jobs: extractJobsFromEmail(payload) };
}

function firstMeaningfulLine(block: string): string | null {
  for (const line of block.split('\n')) {
    const candidate = line.trim();
    if (candidate.length >= 8 && !/^https?:\/\//i.test(candidate) && !isJunkTitle(candidate)) {
      return candidate.slice(0, 200);
    }
  }
  return null;
}

/* --------------------------------------------------------------- harvesting */

export interface HarvestOptions {
  since?: Date | null;
  maxMessages?: number;
  markSeen?: boolean;
}

export interface HarvestResult {
  jobs: RawJob[];
  messages: number;
  uids: number[];
}

async function harvestWithClient(
  client: ImapClientLike,
  settings: ImapSettings,
  options: HarvestOptions,
): Promise<HarvestResult> {
  const maxMessages = Math.max(1, options.maxMessages ?? MAX_MESSAGES_PER_RUN);
  const query: Record<string, unknown> = { seen: false };
  if (settings.searchFrom) query.from = settings.searchFrom;
  if (options.since) query.since = options.since;

  const lock = await client.getMailboxLock(settings.mailbox);
  const jobs: RawJob[] = [];
  const handled: number[] = [];

  try {
    const found = await client.search(query, { uid: true });
    const uids = (Array.isArray(found) ? found : []).slice(-maxMessages);
    if (uids.length === 0) return { jobs: [], messages: 0, uids: [] };

    for await (const message of client.fetch(uids.join(','), { uid: true, source: true }, { uid: true })) {
      const body = message.source;
      if (!body) continue;
      try {
        const parsed = await parseAlertMessage(body);
        jobs.push(...parsed.jobs);
        handled.push(message.uid);
      } catch (err) {
        // One unparsable message must not block the batch. It stays unseen, so
        // the next run retries it rather than losing a job silently.
        log.warn({ err, uid: message.uid }, 'failed to parse imap message');
      }
    }

    if (options.markSeen !== false && handled.length > 0) {
      await client.messageFlagsAdd(handled.join(','), ['\\Seen'], { uid: true });
    }

    return { jobs, messages: handled.length, uids: handled };
  } finally {
    try {
      lock.release();
    } catch {
      // Releasing a lock on a dead connection is not actionable.
    }
  }
}

/** One-shot poll on a short-lived connection. Always tears the socket down. */
export async function harvestOnce(options: HarvestOptions = {}): Promise<HarvestResult> {
  const settings = await resolveImapSettings();
  const client = createImapClient(settings);
  try {
    await client.connect();
    return await harvestWithClient(client, settings, options);
  } finally {
    await closeQuietly(client);
  }
}

/* ------------------------------------------------------------- diagnostics */

/** How far the connection got before it succeeded or failed. */
export type ImapTestStage = 'connect' | 'auth' | 'mailbox' | 'search' | 'parse' | 'done';

export interface ImapMessageSummary {
  subject: string | null;
  from: string | null;
  /** ISO-8601, so the value survives JSON on the way to the dashboard. */
  date: string | null;
}

export interface ImapMailboxSummary {
  name: string;
  exists: number;
  unseen: number;
}

export interface ImapTestResult {
  ok: boolean;
  stage: ImapTestStage;
  /** Absent on success. Written for a human who has to go and fix something. */
  error?: string;
  mailbox?: ImapMailboxSummary;
  /** Messages from the configured sender within the last DIAGNOSTIC_WINDOW_DAYS. */
  matchedMessages?: number;
  newest?: ImapMessageSummary;
}

/** Hard ceiling on a diagnostic run, so a dashboard request cannot hang. */
const DIAGNOSTIC_TIMEOUT_MS = 25_000;
const DIAGNOSTIC_WINDOW_DAYS = 30;
const MAX_PREVIEW_MESSAGES = 10;
const RAW_EXCERPT_CHARS = 1500;

const STAGE_LABELS: Record<ImapTestStage, string> = {
  connect: 'opening the connection',
  auth: 'signing in',
  mailbox: 'opening the mailbox',
  search: 'searching for alert messages',
  parse: 'reading the newest message',
  done: 'finishing up',
};

/** Mutable cursor so a failure can be reported against the step it happened in. */
interface StageCursor {
  stage: ImapTestStage;
}

/* ------------------------------------------------------- failure mapping */

interface ErrorFacts {
  code: string;
  message: string;
  responseText: string;
  serverResponseCode: string;
  authenticationFailed: boolean;
  /** Everything the server and the client said, for one-pass pattern matching. */
  haystack: string;
}

function errorFacts(err: unknown): ErrorFacts {
  const record = (err && typeof err === 'object' ? err : {}) as Record<string, unknown>;
  const code = typeof record.code === 'string' ? record.code : '';
  const message = toErrorMessage(err);
  const responseText = typeof record.responseText === 'string' ? record.responseText.trim() : '';
  const serverResponseCode =
    typeof record.serverResponseCode === 'string' ? record.serverResponseCode.toUpperCase() : '';

  return {
    code,
    message,
    responseText,
    serverResponseCode,
    authenticationFailed: record.authenticationFailed === true,
    haystack: `${code} ${message} ${responseText} ${serverResponseCode}`,
  };
}

const CERTIFICATE_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_PACKET_LENGTH_TOO_LONG',
  'CERT_NOT_YET_VALID',
  'HOSTNAME_MISMATCH',
]);

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN']);
/** The socket never came up: nothing was reached, so nothing was misconfigured. */
const UNREACHABLE_CODES = new Set([
  'CONNECT_TIMEOUT',
  'ETIMEDOUT',
  'ETIMEOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
]);
/** TCP connected but the IMAP conversation never started - almost always TLS. */
const HANDSHAKE_CODES = new Set([
  'GREETING_TIMEOUT',
  'UPGRADE_TIMEOUT',
  'ECONNRESET',
  'EPIPE',
  'ClosedAfterConnectTLS',
  'ClosedAfterConnectText',
]);

const AUTH_RESPONSE_CODES = ['AUTHENTICATIONFAILED', 'AUTHORIZATIONFAILED', 'INVALIDCREDENTIALS'];

/**
 * Provider-specific advice. Every one of these rejects the account password
 * outright, so "wrong password" is almost always "not an app password".
 */
const PROVIDER_HINTS: { pattern: RegExp; hint: string }[] = [
  {
    pattern: /(^|\.)(gmail|googlemail|google)\.com$/i,
    hint: 'Gmail requires an app password, not your account password: turn on 2-Step Verification, create one at https://myaccount.google.com/apppasswords and paste that 16-character value here.',
  },
  {
    pattern: /(^|\.)(outlook|office365|hotmail|live|msn)\.com$/i,
    hint: 'Outlook and Microsoft 365 reject the account password over IMAP: create an app password in the account security settings, and check that IMAP is enabled for this mailbox.',
  },
  {
    pattern: /(^|\.)(yahoo|ymail|rocketmail|aol)\.[a-z.]+$/i,
    hint: 'Yahoo and AOL require an app password, not your account password: generate one under Account Security and paste that value here.',
  },
  {
    pattern: /(^|\.)(icloud|me|mac)\.com$/i,
    hint: 'iCloud Mail requires an app-specific password, not your Apple ID password: create one at https://account.apple.com under Sign-In and Security.',
  },
];

function providerHint(host: string): string | null {
  for (const entry of PROVIDER_HINTS) {
    if (entry.pattern.test(host)) return entry.hint;
  }
  return null;
}

/** Removes the password should any upstream message ever echo it back. */
function scrubSecrets(text: string, settings: ImapSettings): string {
  if (settings.password === '') return text;
  return text.split(settings.password).join('***');
}

interface ImapFailure {
  stage: ImapTestStage;
  error: string;
}

function authFailureMessage(facts: ErrorFacts, settings: ImapSettings): string {
  const parts = [
    `The server rejected the credentials for ${settings.user || '(no user set)'} on ${settings.host}.`,
  ];

  const detail = facts.responseText || facts.message;
  if (detail !== '') parts.push(`Server said: ${detail}.`);

  const hint = providerHint(settings.host);
  if (hint !== null) {
    parts.push(hint);
  } else if (/application[- ]specific password/i.test(facts.haystack)) {
    parts.push(
      'This account needs an application-specific password rather than the account password.',
    );
  } else {
    parts.push(
      'Check the user and password, and that IMAP access is switched on for the account.',
    );
  }

  if (/web ?login|log ?in via your web browser|unusual sign|account has been locked/i.test(facts.haystack)) {
    parts.push(
      'The provider also wants a browser sign-in from this account first, to clear a security block.',
    );
  }

  return parts.join(' ');
}

/**
 * Turns whatever the socket or the server threw into a stage plus a sentence
 * the operator can act on. Everything unrecognised still names the step and
 * quotes the original text rather than swallowing it.
 */
function classifyImapFailure(
  err: unknown,
  settings: ImapSettings,
  stage: ImapTestStage,
): ImapFailure {
  const facts = errorFacts(err);
  const where = STAGE_LABELS[stage];
  const target = `${settings.host || '(no host set)'}:${settings.port}`;

  const failure = ((): ImapFailure => {
    if (err instanceof ImapTimeoutError) {
      return {
        stage,
        error: `Timed out after ${Math.round(err.timeoutMs / 1000)}s while ${where}. ${target} did not answer in time - check the host and port, and whether outbound IMAP is blocked from this network.`,
      };
    }

    if (err instanceof ConfigError) {
      return { stage, error: facts.message };
    }

    if (CERTIFICATE_CODES.has(facts.code) || /certificate|self.signed|ssl/i.test(facts.haystack)) {
      return {
        stage,
        error: `The TLS certificate of ${settings.host} could not be verified (${facts.code || 'certificate error'}). Confirm the host name matches the certificate, and that TLS is ${settings.secure ? 'right for' : 'needed on'} port ${settings.port} - 993 expects implicit TLS, 143 does not.`,
      };
    }

    if (DNS_CODES.has(facts.code)) {
      return {
        stage,
        error: `The host "${settings.host}" could not be resolved (${facts.code}). Check it for a typo - Gmail is imap.gmail.com, Outlook is outlook.office365.com, Yahoo is imap.mail.yahoo.com.`,
      };
    }

    if (facts.code === 'ECONNREFUSED') {
      return {
        stage,
        error: `${target} refused the connection. The port is the usual cause: use 993 with TLS on (almost always right), or 143 with TLS off for STARTTLS.`,
      };
    }

    if (
      facts.authenticationFailed ||
      AUTH_RESPONSE_CODES.includes(facts.serverResponseCode) ||
      /\b535\b|authentication failed|invalid credentials|invalid login|login failed|password is incorrect/i.test(
        facts.haystack,
      )
    ) {
      return { stage: 'auth', error: authFailureMessage(facts, settings) };
    }

    if (
      /NONEXISTENT|TRYCREATE/.test(facts.serverResponseCode) ||
      // Deliberately anchored on the word mailbox/folder: a bare "does not
      // exist" also comes back for unknown *users*, which is an auth problem.
      /(?:mailbox|folder)[^.]{0,40}(?:does not exist|not found|doesn't exist)|unknown mailbox|no such (?:mailbox|folder)/i.test(
        facts.haystack,
      )
    ) {
      return {
        stage: 'mailbox',
        error: `The mailbox "${settings.mailbox}" does not exist on ${settings.host}. Use the exact folder name the server reports - Gmail nests its folders under "[Gmail]/", e.g. "[Gmail]/All Mail".`,
      };
    }

    if (UNREACHABLE_CODES.has(facts.code)) {
      return {
        stage,
        error: `${target} never accepted a connection (${facts.code}). The host resolves but stays silent: check the port, and whether outbound IMAP is blocked by a firewall on this network.`,
      };
    }

    if (HANDSHAKE_CODES.has(facts.code)) {
      return {
        stage,
        error: `${target} accepted the connection then dropped it while ${where} (${facts.code}). That almost always means the port and the TLS setting disagree: 993 needs TLS on, 143 needs it off. TLS is currently ${settings.secure ? 'on' : 'off'}.`,
      };
    }

    const detail = facts.responseText !== '' ? `${facts.message} (server said: ${facts.responseText})` : facts.message;
    return {
      stage,
      error: `Failed while ${where}: ${detail || 'the connection failed with no further detail'}.`,
    };
  })();

  return { stage: failure.stage, error: scrubSecrets(failure.error, settings) };
}

/* ------------------------------------------------------ connection test */

function summarizeEnvelope(envelope: MessageEnvelope | undefined): ImapMessageSummary {
  const addresses = Array.isArray(envelope?.from) ? envelope.from : [];
  const from = addresses
    .map((entry) => {
      const name = typeof entry.name === 'string' ? entry.name.trim() : '';
      const address = typeof entry.address === 'string' ? entry.address.trim() : '';
      if (name !== '' && address !== '') return `${name} <${address}>`;
      return address !== '' ? address : name;
    })
    .filter((entry) => entry !== '')
    .join(', ');

  const subject = typeof envelope?.subject === 'string' ? envelope.subject.trim() : '';

  return {
    subject: subject === '' ? null : subject,
    from: from === '' ? null : from,
    date: envelope?.date instanceof Date ? toIso(envelope.date) : null,
  };
}

/** Builds the sender/recency filter both diagnostics use. */
function diagnosticSearchQuery(settings: ImapSettings): Record<string, unknown> {
  const query: Record<string, unknown> = { since: daysAgo(DIAGNOSTIC_WINDOW_DAYS) };
  if (settings.searchFrom) query.from = settings.searchFrom;
  return query;
}

async function runConnectionTest(
  client: ImapClientLike,
  settings: ImapSettings,
  cursor: StageCursor,
): Promise<ImapTestResult> {
  cursor.stage = 'connect';
  // imapflow authenticates as part of connect(); a rejection here is sorted
  // into 'connect' or 'auth' by classifyImapFailure.
  await client.connect();

  cursor.stage = 'mailbox';
  // Read-only: a connection test must never change flags the poller relies on.
  const mailbox = await client.mailboxOpen(settings.mailbox, { readOnly: true });

  let unseen = 0;
  try {
    const status = await client.status(settings.mailbox, { unseen: true });
    if (typeof status.unseen === 'number') unseen = status.unseen;
  } catch {
    // STATUS on the selected mailbox is optional and some servers refuse it.
    // The exists count is the part that matters, so a refusal is not a failure.
  }

  cursor.stage = 'search';
  const found = await client.search(diagnosticSearchQuery(settings), { uid: true });
  const uids = Array.isArray(found) ? found : [];

  cursor.stage = 'parse';
  let newest: ImapMessageSummary | null = null;
  const newestUid = uids[uids.length - 1];
  if (newestUid !== undefined) {
    for await (const message of client.fetch(
      String(newestUid),
      { uid: true, envelope: true },
      { uid: true },
    )) {
      newest = summarizeEnvelope(message.envelope);
    }
  }

  cursor.stage = 'done';
  return {
    ok: true,
    stage: 'done',
    mailbox: { name: mailbox.path, exists: mailbox.exists, unseen },
    matchedMessages: uids.length,
    ...(newest ? { newest } : {}),
  };
}

/**
 * Connects with the effective configuration (overrides win, then the database,
 * then env) and reports how far it got. Never throws and never returns a
 * credential: the result is meant to be handed straight to the dashboard.
 */
export async function testImapConnection(
  overrides: ImapSettingsOverrides = {},
): Promise<ImapTestResult> {
  let settings: ImapSettings;
  try {
    settings = await resolveImapSettings(overrides);
  } catch (err) {
    return { ok: false, stage: 'connect', error: toErrorMessage(err) };
  }

  const missing = missingImapFields(settings);
  if (missing.length > 0) {
    return { ok: false, stage: 'connect', error: notConfiguredMessage(missing) };
  }

  const cursor: StageCursor = { stage: 'connect' };
  let client: ImapClientLike;
  try {
    client = createImapClient(settings);
  } catch (err) {
    const failure = classifyImapFailure(err, settings, 'connect');
    return { ok: false, stage: failure.stage, error: failure.error };
  }

  try {
    return await withTimeout(runConnectionTest(client, settings, cursor), DIAGNOSTIC_TIMEOUT_MS);
  } catch (err) {
    const failure = classifyImapFailure(err, settings, cursor.stage);
    // Host and mailbox only - the credentials stay out of the log.
    log.warn(
      { host: settings.host, port: settings.port, mailbox: settings.mailbox, stage: failure.stage },
      'imap connection test failed',
    );
    return { ok: false, stage: failure.stage, error: failure.error };
  } finally {
    await closeQuietly(client);
  }
}

/* -------------------------------------------------------- alert preview */

/**
 * One alert email, as parsed and as *not* parsed. fieldsMissing is the useful
 * half: it says which parts of a RawJob a job-alert email simply does not
 * carry, which is documented nowhere else.
 */
export interface AlertPreview {
  subject: string | null;
  date: string | null;
  from: string | null;
  jobsFound: number;
  jobs: RawJob[];
  fieldsPresent: string[];
  fieldsMissing: string[];
  /** Start of the plain-text body, for working out why a parse came up empty. */
  rawTextExcerpt: string;
}

/** Every RawJob field a preview accounts for, in pipeline-relevance order. */
const PREVIEW_FIELDS: readonly string[] = [
  'title',
  'url',
  'externalId',
  'description',
  'postedAt',
  'skills',
  'category',
  'subcategory',
  'jobType',
  'budgetAmount',
  'hourlyMin',
  'hourlyMax',
  'currency',
  'durationLabel',
  'experienceLevel',
  'workload',
  'connectsRequired',
  'proposalsCount',
  'interviewingCount',
  'screeningQuestions',
  'client.country',
  'client.city',
  'client.paymentVerified',
  'client.totalSpent',
  'client.totalHires',
  'client.hireRate',
  'client.avgRating',
  'client.reviewsCount',
  'client.memberSince',
  'client.openJobs',
  'client.clientId',
  'client.companyName',
] as const;

const CLIENT_PREFIX = 'client.';

function fieldValue(job: RawJob, path: string): unknown {
  if (path.startsWith(CLIENT_PREFIX)) {
    return (job.client as unknown as Record<string, unknown>)[path.slice(CLIENT_PREFIX.length)];
  }
  return (job as unknown as Record<string, unknown>)[path];
}

function hasFieldValue(path: string, value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  // 'UNKNOWN' is the normaliser's explicit "the payload never said", so
  // counting it as present would answer the question the wrong way round.
  if (path === 'jobType' && value === 'UNKNOWN') return false;
  return true;
}

/**
 * A field counts as present when any job in the message carried it: one alert
 * bundles several postings and Upwork omits fields per posting.
 */
function summarizeFields(jobs: RawJob[]): { present: string[]; missing: string[] } {
  const present: string[] = [];
  const missing: string[] = [];

  for (const path of PREVIEW_FIELDS) {
    const found = jobs.some((job) => hasFieldValue(path, fieldValue(job, path)));
    if (found) present.push(path);
    else missing.push(path);
  }

  return { present, missing };
}

function excerptOf(payload: EmailPayload): string {
  // Alerts that carry only an HTML part still need a readable excerpt, so the
  // stripped markup stands in for the missing text/plain alternative.
  const body = payload.text ?? (payload.html === null ? '' : stripHtml(payload.html));
  return collapseWhitespace(body).slice(0, RAW_EXCERPT_CHARS);
}

async function previewFromSource(source: Buffer): Promise<AlertPreview> {
  const parsed = await parseAlertMessage(source);
  const fields = summarizeFields(parsed.jobs);

  return {
    subject: parsed.payload.subject,
    date: toIso(parsed.payload.receivedAt),
    from: parsed.from,
    jobsFound: parsed.jobs.length,
    jobs: parsed.jobs,
    fieldsPresent: fields.present,
    fieldsMissing: fields.missing,
    rawTextExcerpt: excerptOf(parsed.payload),
  };
}

/** A message that would not parse at all still has to report its excerpt. */
function unparsablePreview(err: unknown): AlertPreview {
  const fields = summarizeFields([]);
  return {
    subject: null,
    date: null,
    from: null,
    jobsFound: 0,
    jobs: [],
    fieldsPresent: fields.present,
    fieldsMissing: fields.missing,
    rawTextExcerpt: `(this message could not be decoded: ${toErrorMessage(err)})`,
  };
}

async function collectPreviews(
  client: ImapClientLike,
  settings: ImapSettings,
  limit: number,
  cursor: StageCursor,
): Promise<AlertPreview[]> {
  cursor.stage = 'connect';
  await client.connect();

  cursor.stage = 'mailbox';
  // Read-only, and imapflow always fetches with BODY.PEEK, so previewing can
  // never mark an alert \Seen and hide it from the poller's unseen search.
  const lock = await client.getMailboxLock(settings.mailbox, { readOnly: true });

  try {
    cursor.stage = 'search';
    const found = await client.search(diagnosticSearchQuery(settings), { uid: true });
    const uids = (Array.isArray(found) ? found : []).slice(-limit);
    if (uids.length === 0) return [];

    cursor.stage = 'parse';
    const previews: AlertPreview[] = [];
    for await (const message of client.fetch(
      uids.join(','),
      { uid: true, source: true },
      { uid: true },
    )) {
      const body = message.source;
      if (!body) continue;
      try {
        previews.push(await previewFromSource(body));
      } catch (err) {
        // The whole point of a preview is to survive a broken message.
        log.warn({ err, uid: message.uid }, 'failed to decode imap message for preview');
        previews.push(unparsablePreview(err));
      }
    }

    cursor.stage = 'done';
    // Newest first: the most recent alert is the one worth reading.
    previews.reverse();
    return previews;
  } finally {
    try {
      lock.release();
    } catch {
      // Releasing a lock on a dead connection is not actionable.
    }
  }
}

/**
 * Fetches the newest `limit` messages from the configured sender and reports,
 * for each, both what the parser got out of it and what it could not - the only
 * way to find out what an Upwork job-alert email actually contains.
 *
 * Marks nothing as read, so the poller still sees every alert. Throws a
 * ConfigError when IMAP is unconfigured and an UpstreamError carrying the same
 * actionable text as testImapConnection() when the connection fails; an empty
 * array therefore means "connected, nothing matched" rather than "broken".
 */
export async function previewLatestAlert(limit = 3): Promise<AlertPreview[]> {
  const count = Math.min(Math.max(1, Math.trunc(limit)), MAX_PREVIEW_MESSAGES);
  const settings = await resolveImapSettings();

  const missing = missingImapFields(settings);
  if (missing.length > 0) throw new ConfigError(notConfiguredMessage(missing));

  const cursor: StageCursor = { stage: 'connect' };
  const client = createImapClient(settings);

  try {
    return await withTimeout(
      collectPreviews(client, settings, count, cursor),
      DIAGNOSTIC_TIMEOUT_MS,
    );
  } catch (err) {
    const failure = classifyImapFailure(err, settings, cursor.stage);
    throw new UpstreamError(failure.error, {
      cause: err,
      details: { stage: failure.stage, mailbox: settings.mailbox },
    });
  } finally {
    await closeQuietly(client);
  }
}

/* ----------------------------------------------------------------- watcher */

type JobsListener = (jobs: RawJob[]) => void;

/**
 * Long-lived IDLE watcher. Reconnects with exponential backoff and never leaves
 * a socket dangling: every teardown path logs out or force-closes.
 */
export class ImapWatcher {
  private client: ImapClientLike | null = null;
  private settings: ImapSettings | null = null;
  private stopped = true;
  private connecting = false;
  private harvesting = false;
  private pending = false;
  private attempt = 0;
  private sweepTimer: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private readonly log = child('imap:watcher');

  constructor(private readonly onJobs: JobsListener) {}

  isRunning(): boolean {
    return !this.stopped;
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    void this.connectLoop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    await this.teardown();
  }

  private async teardown(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) return;
    try {
      client.removeAllListeners();
    } catch {
      // Nothing to clean up.
    }
    try {
      await client.logout();
    } catch {
      try {
        client.close();
      } catch {
        // Socket already gone.
      }
    }
  }

  private async connectLoop(): Promise<void> {
    // A dying connection emits both 'error' and 'close'; without this guard each
    // one would start its own reconnect loop and multiply the open sockets.
    if (this.connecting) return;
    this.connecting = true;
    try {
      while (!this.stopped) {
        try {
          await this.connectOnce();
          this.attempt = 0;
          return;
        } catch (err) {
          this.attempt += 1;
          const delay = Math.max(2000, backoffDelay(this.attempt, 2000, 120_000));
          this.log.warn(
            { err, attempt: this.attempt, delayMs: delay },
            'imap watcher connect failed; retrying',
          );
          await this.teardown();
          await sleep(delay);
        }
      }
    } finally {
      this.connecting = false;
    }
  }

  private async connectOnce(): Promise<void> {
    // Re-resolved per attempt so a credential fixed in the dashboard is picked
    // up by the next reconnect instead of needing a restart.
    const settings = await resolveImapSettings();
    this.settings = settings;

    const client = createImapClient(settings);
    this.client = client;

    client.on('error', (err: unknown) => {
      this.log.warn({ err }, 'imap connection error');
      this.scheduleReconnect();
    });
    client.on('close', () => {
      if (!this.stopped) {
        this.log.warn('imap connection closed; reconnecting');
        this.scheduleReconnect();
      }
    });
    client.on('exists', () => {
      this.scheduleHarvest();
    });

    await client.connect();
    this.log.info({ mailbox: settings.mailbox }, 'imap watcher connected');

    // Selecting the mailbox both primes the initial sweep and enables the
    // untagged EXISTS notifications the watcher reacts to.
    await this.harvest();

    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = setInterval(() => {
      this.scheduleHarvest();
    }, WATCHER_SWEEP_MS);
    this.sweepTimer.unref?.();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.connecting) return;
    const client = this.client;
    this.client = null;
    if (client) {
      try {
        client.removeAllListeners();
      } catch {
        // Nothing to clean up.
      }
      try {
        client.close();
      } catch {
        // Socket already gone.
      }
    }
    void this.connectLoop();
  }

  private scheduleHarvest(): void {
    if (this.stopped) return;
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.harvest();
    }, HARVEST_DEBOUNCE_MS);
    this.debounceTimer.unref?.();
  }

  private async harvest(): Promise<void> {
    if (this.stopped) return;
    if (this.harvesting) {
      this.pending = true;
      return;
    }
    const client = this.client;
    const settings = this.settings;
    if (!client || !settings) return;

    this.harvesting = true;
    try {
      const result = await harvestWithClient(client, settings, {});
      if (result.jobs.length > 0) {
        this.log.info({ count: result.jobs.length, messages: result.messages }, 'imap watcher found jobs');
        this.onJobs(result.jobs);
      }
    } catch (err) {
      this.log.warn({ err }, 'imap watcher harvest failed');
      this.scheduleReconnect();
    } finally {
      this.harvesting = false;
      if (this.pending) {
        this.pending = false;
        this.scheduleHarvest();
      }
    }
  }
}

/* ------------------------------------------------------------------ source */

export class ImapSource extends BaseSource {
  private buffered: RawJob[] = [];
  private watcher: ImapWatcher | null = null;

  constructor() {
    super({
      name: SOURCE_NAME,
      rateCapacity: 4,
      rateRefillPerSecond: 1,
      breaker: { failureThreshold: 4, cooldownMs: 120_000 },
      cooldownBaseMs: 60_000,
      cooldownMaxMs: 30 * 60_000,
    });
  }

  /**
   * Credentials saved in the dashboard count as configured, not just the
   * environment ones. peekRuntimeConfig() is synchronous and returns null until
   * the first load lands, which is why hasImap() is still the answer at boot.
   */
  override isEnabled(): boolean {
    if (!isSourceSelected(SOURCE_NAME, SOURCE_ALIASES)) return false;
    const runtime = peekRuntimeConfig();
    return runtime ? runtime.imap.enabled : hasImap();
  }

  /** Starts the IDLE watcher. Safe to call twice; a no-op when IMAP is off. */
  async startWatching(): Promise<void> {
    if (!this.isEnabled() || this.watcher) return;
    this.watcher = new ImapWatcher((jobs) => this.buffer(jobs));
    await this.watcher.start();
  }

  async stopWatching(): Promise<void> {
    const watcher = this.watcher;
    this.watcher = null;
    if (watcher) await watcher.stop();
  }

  isWatching(): boolean {
    return this.watcher !== null && this.watcher.isRunning();
  }

  private buffer(jobs: RawJob[]): void {
    for (const job of jobs) {
      this.buffered.push(job);
    }
    if (this.buffered.length > MAX_BUFFERED_JOBS) {
      this.buffered = this.buffered.slice(-MAX_BUFFERED_JOBS);
    }
  }

  private drainBuffer(): RawJob[] {
    const drained = this.buffered;
    this.buffered = [];
    return drained;
  }

  protected override async run(ctx: SourceContext): Promise<SourceResult> {
    const fromWatcher = this.drainBuffer();

    let polled: HarvestResult = { jobs: [], messages: 0, uids: [] };
    let pollError: string | null = null;

    try {
      polled = await harvestOnce({
        since: ctx.since,
        maxMessages: Math.min(ctx.limit, MAX_MESSAGES_PER_RUN),
      });
    } catch (err) {
      // The watcher may still be healthy; only fail the run when both paths are
      // empty, otherwise the buffered jobs would be thrown away.
      pollError = toErrorMessage(err);
      if (fromWatcher.length === 0) throw err;
      this.log.warn({ err }, 'imap poll failed but watcher jobs are available');
    }

    const byId = new Map<string, RawJob>();
    for (const job of [...fromWatcher, ...polled.jobs]) {
      byId.set(job.externalId, job);
    }

    const jobs = Array.from(byId.values()).slice(0, ctx.limit);
    let newest: Date | null = null;
    for (const job of jobs) {
      if (job.postedAt && (newest === null || job.postedAt.getTime() > newest.getTime())) {
        newest = job.postedAt;
      }
    }

    return {
      jobs,
      cursor: newest ? toIso(newest) : ctx.cursor,
      meta: {
        watcherJobs: fromWatcher.length,
        polledMessages: polled.messages,
        watching: this.isWatching(),
        ...(pollError ? { pollError } : {}),
      },
    };
  }
}

export const imapSource = new ImapSource();
