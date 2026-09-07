import * as dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

/** Accepts "true"/"1"/"yes"/"on" (case-insensitive) as true, "false"/"0"/"no"/"off" as false. */
const boolFromString = (defaultValue: boolean) =>
  z
    .union([z.string(), z.boolean()])
    .optional()
    .transform((value) => {
      if (value === undefined || value === '') return defaultValue;
      if (typeof value === 'boolean') return value;
      const normalized = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
      if (['false', '0', 'no', 'off'].includes(normalized)) return false;
      return defaultValue;
    });

const intFromString = (defaultValue: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value.trim() === '') return defaultValue;
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `must be an integer, got "${value}"` });
        return z.NEVER;
      }
      if (parsed < min || parsed > max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `must be between ${min} and ${max}, got ${parsed}`,
        });
        return z.NEVER;
      }
      return parsed;
    });

/** Comma-separated list -> trimmed, de-duplicated, non-empty entries. */
const csv = (defaultValue: string[] = []) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value.trim() === '') return [...defaultValue];
      const items = value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      return Array.from(new Set(items));
    });

const optionalString = z
  .string()
  .optional()
  .transform((value) => (value === undefined || value.trim() === '' ? undefined : value.trim()));

const stringWithDefault = (defaultValue: string) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === '' ? defaultValue : value.trim()));

const nodeEnvSchema = z
  .enum(['development', 'test', 'production'])
  .default('development');

const schema = z
  .object({
    NODE_ENV: nodeEnvSchema,
    PORT: intFromString(3000, 1, 65535),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    DATABASE_URL: z
      .string({ required_error: 'DATABASE_URL is required (postgresql://user:pass@host:5432/db)' })
      .min(1, 'DATABASE_URL must not be empty'),
    REDIS_URL: stringWithDefault('redis://localhost:6379'),

    API_KEY: optionalString,
    PUBLIC_BASE_URL: stringWithDefault('http://localhost:3000'),

    ANTHROPIC_API_KEY: optionalString,
    ANTHROPIC_MODEL: stringWithDefault('claude-opus-5'),
    ANTHROPIC_MAX_TOKENS: intFromString(2000, 256, 200000),

    UPWORK_CLIENT_ID: optionalString,
    UPWORK_CLIENT_SECRET: optionalString,
    UPWORK_REDIRECT_URI: optionalString,
    UPWORK_TENANT_ID: optionalString,
    UPWORK_API_BASE: stringWithDefault('https://api.upwork.com'),
    UPWORK_GRAPHQL_URL: stringWithDefault('https://api.upwork.com/graphql'),

    SOURCES: csv(['upwork_api']),
    RSS_FEED_URLS: csv([]),

    IMAP_HOST: optionalString,
    IMAP_PORT: intFromString(993, 1, 65535),
    IMAP_USER: optionalString,
    IMAP_PASSWORD: optionalString,
    IMAP_MAILBOX: stringWithDefault('INBOX'),
    IMAP_SEARCH_FROM: stringWithDefault('no-reply@upwork.com'),

    POLL_INTERVAL_SECONDS: intFromString(60, 5, 86400),
    FAST_POLL_INTERVAL_SECONDS: intFromString(20, 5, 86400),
    MAX_JOBS_PER_POLL: intFromString(100, 1, 1000),

    AUTO_SUBMIT: boolFromString(false),
    DRY_RUN: boolFromString(true),
    SUBMITTER: z.enum(['api', 'webhook', 'review_queue']).default('review_queue'),
    SUBMIT_WEBHOOK_URL: optionalString,
    SUBMIT_WEBHOOK_SECRET: optionalString,

    TELEGRAM_BOT_TOKEN: optionalString,
    TELEGRAM_CHAT_ID: optionalString,
    SLACK_WEBHOOK_URL: optionalString,

    SMTP_HOST: optionalString,
    SMTP_PORT: intFromString(587, 1, 65535),
    SMTP_USER: optionalString,
    SMTP_PASS: optionalString,
    SMTP_FROM: optionalString,
    NOTIFY_EMAIL_TO: optionalString,

    WORKER_CONCURRENCY: intFromString(5, 1, 100),
    HTTP_TIMEOUT_MS: intFromString(30000, 1000, 600000),
    HTTP_MAX_RETRIES: intFromString(3, 0, 10),
    METRICS_ENABLED: boolFromString(true),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV === 'production' && !value.API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['API_KEY'],
        message: 'API_KEY is required when NODE_ENV=production (it guards the dashboard and API)',
      });
    }
    if (value.API_KEY && value.API_KEY.length < 16) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['API_KEY'],
        message: 'API_KEY must be at least 16 characters',
      });
    }
    if (value.SUBMITTER === 'webhook' && !value.SUBMIT_WEBHOOK_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SUBMIT_WEBHOOK_URL'],
        message: 'SUBMIT_WEBHOOK_URL is required when SUBMITTER=webhook',
      });
    }
  });

export type Env = z.infer<typeof schema>;

function formatIssues(error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const key = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `  - ${key}: ${issue.message}`;
  });
  const unique = Array.from(new Set(lines));
  return [
    'Invalid environment configuration. Fix the following and restart:',
    ...unique,
    '',
    'See .env.example for the full list of supported variables.',
  ].join('\n');
}

function loadEnv(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(formatIssues(parsed.error));
  }
  return parsed.data;
}

export const env: Env = loadEnv();

export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
export const isDev = env.NODE_ENV === 'development';

/** Source ids the operator turned on, e.g. ["upwork_api", "rss"]. */
export const sourcesEnabled: string[] = env.SOURCES;

export function isSourceEnabled(name: string): boolean {
  return sourcesEnabled.includes(name);
}

export function hasAnthropic(): boolean {
  return Boolean(env.ANTHROPIC_API_KEY);
}

export function hasUpworkOAuth(): boolean {
  return Boolean(env.UPWORK_CLIENT_ID && env.UPWORK_CLIENT_SECRET && env.UPWORK_REDIRECT_URI);
}

export function hasImap(): boolean {
  return Boolean(env.IMAP_HOST && env.IMAP_USER && env.IMAP_PASSWORD);
}

export function hasSmtp(): boolean {
  return Boolean(env.SMTP_HOST && env.SMTP_FROM && env.NOTIFY_EMAIL_TO);
}

/** Names of notification channels that have complete credentials. */
export function notifyChannelsConfigured(): string[] {
  const channels: string[] = [];
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) channels.push('telegram');
  if (env.SLACK_WEBHOOK_URL) channels.push('slack');
  if (hasSmtp()) channels.push('email');
  return channels;
}

/** Absolute dashboard/API URL used in notifications and OAuth callbacks. */
export function publicUrl(path = '/'): string {
  const base = env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}

/** Config summary safe to log or expose on /health - never contains secrets. */
export function safeConfigSummary(): Record<string, unknown> {
  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    sources: sourcesEnabled,
    submitter: env.SUBMITTER,
    autoSubmit: env.AUTO_SUBMIT,
    dryRun: env.DRY_RUN,
    model: env.ANTHROPIC_MODEL,
    pollIntervalSeconds: env.POLL_INTERVAL_SECONDS,
    fastPollIntervalSeconds: env.FAST_POLL_INTERVAL_SECONDS,
    workerConcurrency: env.WORKER_CONCURRENCY,
    metricsEnabled: env.METRICS_ENABLED,
    anthropicConfigured: hasAnthropic(),
    upworkOAuthConfigured: hasUpworkOAuth(),
    imapConfigured: hasImap(),
    notifyChannels: notifyChannelsConfigured(),
    apiKeySet: Boolean(env.API_KEY),
  };
}
