/**
 * Effective configuration, resolved from two layers.
 *
 * Environment variables are the floor: they are what the process boots with and
 * what keeps working when the database is unreachable. The Setting table is the
 * operator-editable override on top, written from the dashboard. A database
 * value wins whenever one exists for that field; env fills every gap. `source`
 * on each section records which layer supplied the credentials.
 *
 * Reads are cached for 30 seconds so the poll loop and the notifier do not
 * query Setting on every message. Any writer must call invalidateRuntimeConfig()
 * - setRuntimeImap and setRuntimeNotify already do.
 *
 * Secrets are stored encrypted (see lib/secrets). Rotating API_KEY makes them
 * unreadable, at which point the env layer takes over again for those fields
 * until the operator re-enters them.
 */

import type { Prisma } from '@prisma/client';
import { env } from './env';
import { child } from '../lib/logger';
import { prisma } from '../lib/prisma';
import {
  decryptIfEncrypted,
  encryptSecret,
  isMasked,
  maskSecret,
} from '../lib/secrets';

const log = child('config:runtime');

export const RUNTIME_IMAP_KEY = 'runtime.imap';
export const RUNTIME_NOTIFY_KEY = 'runtime.notify';

const CACHE_TTL_MS = 30_000;

/** Which layer supplied this section's credentials. */
export type ConfigSource = 'env' | 'db' | 'none';

export interface RuntimeImapConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  mailbox: string;
  searchFrom: string;
  tls: boolean;
  enabled: boolean;
  source: ConfigSource;
}

export interface RuntimeNotifyConfig {
  telegramBotToken: string;
  telegramChatId: string;
  slackWebhookUrl: string;
  source: ConfigSource;
}

export interface RuntimeConfig {
  imap: RuntimeImapConfig;
  notify: RuntimeNotifyConfig;
}

/**
 * Partial update from the dashboard. `undefined` leaves the field untouched;
 * `null` or '' clears the override so the env value becomes effective again.
 */
export interface RuntimeImapInput {
  host?: string | null;
  port?: number | null;
  user?: string | null;
  password?: string | null;
  mailbox?: string | null;
  searchFrom?: string | null;
  tls?: boolean | null;
  enabled?: boolean | null;
}

export interface RuntimeNotifyInput {
  telegramBotToken?: string | null;
  telegramChatId?: string | null;
  slackWebhookUrl?: string | null;
}

/* -------------------------------------------------------------- json access */

type StoredSection = Record<string, unknown>;

function asSection(value: unknown): StoredSection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as StoredSection;
}

function readString(source: StoredSection, key: string): string | null {
  const value = source[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Reads an encrypted field. An undecryptable value (rotated API_KEY, hand-edited
 * row) reads as absent, so the env layer transparently takes over.
 */
function readSecret(source: StoredSection, key: string): string | null {
  const value = source[key];
  if (typeof value !== 'string' || value.trim() === '') return null;
  const plain = decryptIfEncrypted(value).trim();
  return plain === '' ? null : plain;
}

function readInt(source: StoredSection, key: string, min: number, max: number): number | null {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value < min || value > max) return null;
  return value;
}

function readBool(source: StoredSection, key: string): boolean | null {
  const value = source[key];
  return typeof value === 'boolean' ? value : null;
}

/* ------------------------------------------------------------- layer merge */

interface LayerUse {
  db: boolean;
  env: boolean;
}

/** Database first, env second, hard default last - recording which layer won. */
function pick<T>(dbValue: T | null, envValue: T | null, fallback: T, used: LayerUse): T {
  if (dbValue !== null) {
    used.db = true;
    return dbValue;
  }
  if (envValue !== null) {
    used.env = true;
    return envValue;
  }
  return fallback;
}

function layerSource(used: LayerUse): ConfigSource {
  if (used.db) return 'db';
  if (used.env) return 'env';
  return 'none';
}

function resolveImap(stored: StoredSection): RuntimeImapConfig {
  // Only the connection credentials decide `source`. Tuning fields (port,
  // mailbox, searchFrom, tls) carry env schema defaults that are always
  // present, so counting them would make every config look env-configured.
  const credentials: LayerUse = { db: false, env: false };
  const tuning: LayerUse = { db: false, env: false };

  const host = pick(readString(stored, 'host'), env.IMAP_HOST ?? null, '', credentials);
  const user = pick(readString(stored, 'user'), env.IMAP_USER ?? null, '', credentials);
  const password = pick(readSecret(stored, 'password'), env.IMAP_PASSWORD ?? null, '', credentials);

  const port = pick(readInt(stored, 'port', 1, 65535), env.IMAP_PORT, 993, tuning);
  const mailbox = pick(readString(stored, 'mailbox'), env.IMAP_MAILBOX, 'INBOX', tuning);
  const searchFrom = pick(readString(stored, 'searchFrom'), env.IMAP_SEARCH_FROM, '', tuning);
  // Implicit TLS on the two submission ports, matching what the IMAP client does.
  const tls = pick(readBool(stored, 'tls'), null, port === 993 || port === 465, tuning);

  const complete = host !== '' && user !== '' && password !== '';
  // An explicit `enabled: true` cannot conjure missing credentials; the watcher
  // would only throw on connect.
  const enabled = pick(readBool(stored, 'enabled'), null, complete, tuning) && complete;

  return {
    host,
    port,
    user,
    password,
    mailbox,
    searchFrom,
    tls,
    enabled,
    source: layerSource(credentials),
  };
}

function resolveNotify(stored: StoredSection): RuntimeNotifyConfig {
  const used: LayerUse = { db: false, env: false };

  const telegramBotToken = pick(
    readSecret(stored, 'telegramBotToken'),
    env.TELEGRAM_BOT_TOKEN ?? null,
    '',
    used,
  );
  const telegramChatId = pick(
    readString(stored, 'telegramChatId'),
    env.TELEGRAM_CHAT_ID ?? null,
    '',
    used,
  );
  const slackWebhookUrl = pick(
    readSecret(stored, 'slackWebhookUrl'),
    env.SLACK_WEBHOOK_URL ?? null,
    '',
    used,
  );

  return {
    telegramBotToken,
    telegramChatId,
    slackWebhookUrl,
    source: layerSource(used),
  };
}

/* ------------------------------------------------------------------- cache */

interface CacheEntry {
  value: RuntimeConfig;
  expiresAt: number;
}

let cache: CacheEntry | null = null;
let inflight: Promise<RuntimeConfig> | null = null;

async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  let imapStored: StoredSection = {};
  let notifyStored: StoredSection = {};

  try {
    const rows = await prisma.setting.findMany({
      where: { key: { in: [RUNTIME_IMAP_KEY, RUNTIME_NOTIFY_KEY] } },
    });
    for (const row of rows) {
      if (row.key === RUNTIME_IMAP_KEY) imapStored = asSection(row.value);
      else if (row.key === RUNTIME_NOTIFY_KEY) notifyStored = asSection(row.value);
    }
  } catch (err) {
    // Env is the floor precisely so a database blip cannot take the IMAP
    // watcher and the notifiers down with it.
    log.warn({ err }, 'failed to read runtime settings; using env only');
  }

  return { imap: resolveImap(imapStored), notify: resolveNotify(notifyStored) };
}

/** Effective configuration, cached for 30 seconds. Never rejects. */
export async function getRuntimeConfig(): Promise<RuntimeConfig> {
  const cached = cache;
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (inflight) return inflight;

  const pending = loadRuntimeConfig()
    .then((value) => {
      cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
      return value;
    })
    .finally(() => {
      if (inflight === pending) inflight = null;
    });

  inflight = pending;
  return pending;
}

/** Drops the cache so the next read sees a write immediately. */
export function invalidateRuntimeConfig(): void {
  cache = null;
  inflight = null;
}

/* ------------------------------------------------------------------ writes */

async function readStored(key: string): Promise<StoredSection> {
  const row = await prisma.setting.findUnique({ where: { key } });
  return asSection(row?.value);
}

async function writeStored(key: string, section: StoredSection): Promise<void> {
  const value = section as Prisma.InputJsonObject;
  await prisma.setting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}

function applyString(target: StoredSection, key: string, value: string | null | undefined): void {
  if (value === undefined) return;
  const trimmed = (value ?? '').trim();
  if (trimmed === '') {
    delete target[key];
    return;
  }
  target[key] = trimmed;
}

function applySecret(target: StoredSection, key: string, value: string | null | undefined): void {
  if (value === undefined) return;
  const trimmed = (value ?? '').trim();
  if (trimmed === '') {
    delete target[key];
    return;
  }
  // The dashboard renders stored credentials masked. Re-submitting an untouched
  // form would otherwise overwrite the real secret with its own bullets.
  if (isMasked(trimmed)) return;
  target[key] = encryptSecret(trimmed);
}

function applyInt(
  target: StoredSection,
  key: string,
  value: number | null | undefined,
  min: number,
  max: number,
): void {
  if (value === undefined) return;
  if (value === null || !Number.isInteger(value) || value < min || value > max) {
    delete target[key];
    return;
  }
  target[key] = value;
}

function applyBool(target: StoredSection, key: string, value: boolean | null | undefined): void {
  if (value === undefined) return;
  if (value === null) {
    delete target[key];
    return;
  }
  target[key] = value;
}

/**
 * Persists the IMAP override, encrypting the password, and returns the freshly
 * resolved configuration. Fields left `undefined` keep their stored value.
 */
export async function setRuntimeImap(values: RuntimeImapInput): Promise<RuntimeConfig> {
  const section = await readStored(RUNTIME_IMAP_KEY);

  applyString(section, 'host', values.host);
  applyInt(section, 'port', values.port, 1, 65535);
  applyString(section, 'user', values.user);
  applySecret(section, 'password', values.password);
  applyString(section, 'mailbox', values.mailbox);
  applyString(section, 'searchFrom', values.searchFrom);
  applyBool(section, 'tls', values.tls);
  applyBool(section, 'enabled', values.enabled);

  await writeStored(RUNTIME_IMAP_KEY, section);
  invalidateRuntimeConfig();
  // Field names only - the values are credentials.
  log.info({ fields: Object.keys(section) }, 'runtime imap settings updated');

  return getRuntimeConfig();
}

/**
 * Persists the notification override, encrypting the bot token and the Slack
 * webhook URL, and returns the freshly resolved configuration.
 */
export async function setRuntimeNotify(values: RuntimeNotifyInput): Promise<RuntimeConfig> {
  const section = await readStored(RUNTIME_NOTIFY_KEY);

  applySecret(section, 'telegramBotToken', values.telegramBotToken);
  applyString(section, 'telegramChatId', values.telegramChatId);
  applySecret(section, 'slackWebhookUrl', values.slackWebhookUrl);

  await writeStored(RUNTIME_NOTIFY_KEY, section);
  invalidateRuntimeConfig();
  log.info({ fields: Object.keys(section) }, 'runtime notify settings updated');

  return getRuntimeConfig();
}

/* ---------------------------------------------------------------- describe */

/** Same shape with every credential replaced by its masked display form. */
export function maskRuntimeConfig(config: RuntimeConfig): RuntimeConfig {
  return {
    imap: { ...config.imap, password: maskSecret(config.imap.password) },
    notify: {
      ...config.notify,
      telegramBotToken: maskSecret(config.notify.telegramBotToken),
      slackWebhookUrl: maskSecret(config.notify.slackWebhookUrl),
    },
  };
}

/** The browser-safe view of the effective configuration. */
export async function describeRuntimeConfig(): Promise<RuntimeConfig> {
  return maskRuntimeConfig(await getRuntimeConfig());
}
