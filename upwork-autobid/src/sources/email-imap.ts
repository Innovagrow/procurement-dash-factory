/**
 * IMAP source: parses Upwork job-alert emails.
 *
 * Two paths share one parser. The watcher keeps a connection open and reacts to
 * untagged EXISTS notifications (imapflow puts an idle connection into IMAP
 * IDLE automatically, which is what delivers them within seconds of delivery),
 * buffering what it finds. The BullMQ poll then drains that buffer and also runs
 * its own short-lived search, so a dropped IDLE connection can never stall
 * detection for longer than one poll interval.
 */

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { env, hasImap } from '../config/env';
import { toErrorMessage } from '../lib/errors';
import { backoffDelay, sleep } from '../lib/http';
import { child } from '../lib/logger';
import { toIso } from '../lib/time';
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

/* --------------------------------------------------------- client plumbing */

interface MailboxLock {
  release(): void;
}

interface FetchedMessage {
  uid: number;
  source?: Buffer;
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
  getMailboxLock(path: string): Promise<MailboxLock>;
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

function createImapClient(): ImapClientLike {
  if (!env.IMAP_HOST || !env.IMAP_USER || !env.IMAP_PASSWORD) {
    throw new Error('IMAP is not configured: set IMAP_HOST, IMAP_USER and IMAP_PASSWORD');
  }

  const options = {
    host: env.IMAP_HOST,
    port: env.IMAP_PORT,
    secure: env.IMAP_PORT === 993 || env.IMAP_PORT === 465,
    auth: { user: env.IMAP_USER, pass: env.IMAP_PASSWORD },
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
  options: HarvestOptions,
): Promise<HarvestResult> {
  const maxMessages = Math.max(1, options.maxMessages ?? MAX_MESSAGES_PER_RUN);
  const query: Record<string, unknown> = { seen: false };
  if (env.IMAP_SEARCH_FROM) query.from = env.IMAP_SEARCH_FROM;
  if (options.since) query.since = options.since;

  const lock = await client.getMailboxLock(env.IMAP_MAILBOX);
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
        const parsed = await simpleParser(body);
        const extracted = extractJobsFromEmail({
          html: typeof parsed.html === 'string' ? parsed.html : null,
          text: typeof parsed.text === 'string' ? parsed.text : null,
          subject: typeof parsed.subject === 'string' ? parsed.subject : null,
          receivedAt: parsed.date instanceof Date ? parsed.date : null,
        });
        jobs.push(...extracted);
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
  const client = createImapClient();
  try {
    await client.connect();
    return await harvestWithClient(client, options);
  } finally {
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
}

/* ----------------------------------------------------------------- watcher */

type JobsListener = (jobs: RawJob[]) => void;

/**
 * Long-lived IDLE watcher. Reconnects with exponential backoff and never leaves
 * a socket dangling: every teardown path logs out or force-closes.
 */
export class ImapWatcher {
  private client: ImapClientLike | null = null;
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
    const client = createImapClient();
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
    this.log.info({ mailbox: env.IMAP_MAILBOX }, 'imap watcher connected');

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
    if (!client) return;

    this.harvesting = true;
    try {
      const result = await harvestWithClient(client, {});
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

  override isEnabled(): boolean {
    return isSourceSelected(SOURCE_NAME, SOURCE_ALIASES) && hasImap();
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
