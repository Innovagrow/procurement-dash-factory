import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { publicUrl } from '../../config/env';
import {
  describeRuntimeConfig,
  getRuntimeConfig,
  maskRuntimeConfig,
  setRuntimeImap,
  setRuntimeNotify,
} from '../../config/runtime';
import type { RuntimeImapInput, RuntimeNotifyInput } from '../../config/runtime';
import { toErrorMessage } from '../../lib/errors';
import { child } from '../../lib/logger';
import { isMasked, maskSecret } from '../../lib/secrets';
import { channelStatus, notifyUrgent } from '../../notify';
import { previewLatestAlert, testImapConnection } from '../../sources/email-imap';
import type { ImapSettingsOverrides } from '../../sources/email-imap';
import type { NotificationMessage } from '../../types';
import { emit } from '../sse';

const log = child('api:settings');

/**
 * Both test endpoints open a real connection to a third-party service, so they
 * are throttled per process. One operator with one dashboard is the entire user
 * base, which is why a timestamp map is enough and no Redis round trip is worth
 * paying for.
 */
const TEST_COOLDOWN_MS = 10_000;
const lastTestAt = new Map<string, number>();

/** Milliseconds still to wait, or 0 when the call may proceed (and is recorded). */
function claimTestSlot(key: string): number {
  const now = Date.now();
  const waitMs = (lastTestAt.get(key) ?? 0) + TEST_COOLDOWN_MS - now;
  if (waitMs > 0) return waitMs;
  lastTestAt.set(key, now);
  return 0;
}

function throttled(reply: FastifyReply, waitMs: number): FastifyReply {
  const seconds = Math.max(1, Math.ceil(waitMs / 1000));
  return reply
    .code(429)
    .header('retry-after', String(seconds))
    .send({
      error: {
        code: 'TOO_MANY_REQUESTS',
        message: `this test runs at most once every ${TEST_COOLDOWN_MS / 1000} seconds; retry in ${seconds}s`,
        retryAfterMs: waitMs,
      },
    });
}

/* ---------------------------------------------------------------- schemas */

/**
 * Every field is optional so the dashboard can save one row at a time. Within
 * that: `undefined` leaves the stored override alone, `''` clears it so the
 * environment variable becomes effective again, and for credentials an explicit
 * `null` is the only way to drop a stored secret.
 */
const imapSettingsSchema = z
  .object({
    host: z.string().trim().max(255).nullable().optional(),
    port: z.number().int().min(1).max(65535).nullable().optional(),
    user: z.string().trim().max(320).nullable().optional(),
    password: z.string().max(512).nullable().optional(),
    mailbox: z.string().trim().max(255).nullable().optional(),
    searchFrom: z.string().trim().max(320).nullable().optional(),
    tls: z.boolean().nullable().optional(),
    enabled: z.boolean().nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'provide at least one field to update',
  });

/** The same fields, but a test changes nothing, so none of them are required. */
const imapTestSchema = z
  .object({
    host: z.string().trim().max(255).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    user: z.string().trim().max(320).optional(),
    password: z.string().max(512).optional(),
    mailbox: z.string().trim().max(255).optional(),
    searchFrom: z.string().trim().max(320).optional(),
    tls: z.boolean().optional(),
  })
  .default({});

const imapPreviewSchema = z
  .object({ limit: z.number().int().min(1).max(10).optional() })
  .default({});

const notifySettingsSchema = z
  .object({
    telegramBotToken: z.string().trim().max(512).nullable().optional(),
    telegramChatId: z.string().trim().max(128).nullable().optional(),
    slackWebhookUrl: z.string().trim().max(512).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'provide at least one field to update',
  });

const notifyTestSchema = z.object({ message: z.string().trim().max(500).optional() }).default({});

function invalidBody(reply: FastifyReply, message: string, error: z.ZodError): FastifyReply {
  return reply.code(400).send({
    error: {
      code: 'BAD_REQUEST',
      message,
      issues: error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    },
  });
}

/**
 * True when a submitted credential is a real new value. An absent field, a blank
 * one, or the masked string the dashboard rendered all mean "keep the stored
 * credential" - a form posted without retyping the password must never wipe a
 * working one.
 */
function isNewSecret(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '' && !isMasked(value);
}

/* ------------------------------------------------------------------ routes */

export default async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/settings', async (_request, reply) => {
    // describeRuntimeConfig masks every credential; `source` on each section
    // says whether the database override or the environment is in effect.
    const settings = await describeRuntimeConfig();
    return reply.send({ settings, channels: channelStatus() });
  });

  app.put('/settings/imap', async (request, reply) => {
    const body = imapSettingsSchema.safeParse(request.body ?? {});
    if (!body.success) return invalidBody(reply, 'invalid imap settings', body.error);

    const input: RuntimeImapInput = {};
    if (body.data.host !== undefined) input.host = body.data.host;
    if (body.data.port !== undefined) input.port = body.data.port;
    if (body.data.user !== undefined) input.user = body.data.user;
    if (body.data.mailbox !== undefined) input.mailbox = body.data.mailbox;
    if (body.data.searchFrom !== undefined) input.searchFrom = body.data.searchFrom;
    if (body.data.tls !== undefined) input.tls = body.data.tls;
    if (body.data.enabled !== undefined) input.enabled = body.data.enabled;
    if (body.data.password === null) input.password = null;
    else if (isNewSecret(body.data.password)) input.password = body.data.password;

    const config = await setRuntimeImap(input);

    // Field names only: the values are credentials.
    log.info({ fields: Object.keys(input) }, 'imap settings saved');
    emit('settings.updated', { section: 'imap', source: config.imap.source });

    return reply.send({ settings: maskRuntimeConfig(config) });
  });

  /**
   * Tests what the operator has on screen rather than what is stored, so a
   * credential can be proved before it is committed. Nothing here writes.
   */
  app.post('/settings/imap/test', async (request, reply) => {
    const body = imapTestSchema.safeParse(request.body ?? {});
    if (!body.success) return invalidBody(reply, 'invalid imap test request', body.error);

    const saved = await getRuntimeConfig();
    const submitted = body.data;
    const pick = (value: string | undefined, fallback: string): string =>
      typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;

    const effective = {
      host: pick(submitted.host, saved.imap.host),
      port: submitted.port ?? saved.imap.port,
      user: pick(submitted.user, saved.imap.user),
      // The form renders the stored password masked, so an untouched field
      // tests the saved credential instead of an empty one.
      password: isNewSecret(submitted.password) ? submitted.password.trim() : saved.imap.password,
      mailbox: pick(submitted.mailbox, saved.imap.mailbox),
      searchFrom: pick(submitted.searchFrom, saved.imap.searchFrom),
      tls: submitted.tls ?? saved.imap.tls,
    } satisfies ImapSettingsOverrides;

    const missing = (['host', 'user', 'password'] as const).filter(
      (field) => effective[field] === '',
    );
    if (missing.length > 0) {
      return reply.code(400).send({
        error: {
          code: 'BAD_REQUEST',
          message: `imap is not configured: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} empty`,
        },
      });
    }

    const waitMs = claimTestSlot('imap');
    if (waitMs > 0) return throttled(reply, waitMs);

    const tested = { ...effective, password: maskSecret(effective.password) };

    try {
      const result = await testImapConnection(effective);
      log.info(
        { ok: result.ok, stage: result.stage, host: effective.host, port: effective.port },
        'imap connection tested',
      );
      return reply.send({ ok: result.ok, result, tested });
    } catch (err) {
      // A refused connection is the answer the operator asked for, not a server
      // fault, so it comes back as a readable result rather than a 5xx.
      const message = toErrorMessage(err);
      log.warn({ err: message, host: effective.host }, 'imap connection test failed');
      return reply.send({ ok: false, error: message, tested });
    }
  });

  /** Reads the newest alerts with the SAVED credentials and stores nothing. */
  app.post('/settings/imap/preview', async (request, reply) => {
    const body = imapPreviewSchema.safeParse(request.body ?? {});
    if (!body.success) return invalidBody(reply, 'invalid imap preview request', body.error);

    const saved = await getRuntimeConfig();
    if (saved.imap.host === '' || saved.imap.user === '' || saved.imap.password === '') {
      return reply.code(400).send({
        error: {
          code: 'BAD_REQUEST',
          message: 'imap is not configured; save a host, user and password first',
        },
      });
    }

    try {
      const previews =
        body.data.limit === undefined
          ? await previewLatestAlert()
          : await previewLatestAlert(body.data.limit);
      const jobsFound = previews.reduce((sum, preview) => sum + preview.jobsFound, 0);
      log.info({ messages: previews.length, jobsFound }, 'imap alert preview served');
      return reply.send({ ok: true, count: previews.length, jobsFound, previews });
    } catch (err) {
      const message = toErrorMessage(err);
      log.warn({ err: message }, 'imap alert preview failed');
      return reply.send({ ok: false, error: message, count: 0, jobsFound: 0, previews: [] });
    }
  });

  app.put('/settings/notify', async (request, reply) => {
    const body = notifySettingsSchema.safeParse(request.body ?? {});
    if (!body.success) return invalidBody(reply, 'invalid notification settings', body.error);

    const input: RuntimeNotifyInput = {};
    if (body.data.telegramChatId !== undefined) input.telegramChatId = body.data.telegramChatId;
    if (body.data.telegramBotToken === null) input.telegramBotToken = null;
    else if (isNewSecret(body.data.telegramBotToken)) {
      input.telegramBotToken = body.data.telegramBotToken;
    }
    if (body.data.slackWebhookUrl === null) input.slackWebhookUrl = null;
    else if (isNewSecret(body.data.slackWebhookUrl)) {
      input.slackWebhookUrl = body.data.slackWebhookUrl;
    }

    const config = await setRuntimeNotify(input);

    log.info({ fields: Object.keys(input) }, 'notification settings saved');
    emit('settings.updated', { section: 'notify', source: config.notify.source });

    return reply.send({ settings: maskRuntimeConfig(config) });
  });

  /** Sends a real message through every configured channel and reports each one. */
  app.post('/settings/notify/test', async (request, reply) => {
    const body = notifyTestSchema.safeParse(request.body ?? {});
    if (!body.success) return invalidBody(reply, 'invalid notification test request', body.error);

    const waitMs = claimTestSlot('notify');
    if (waitMs > 0) return throttled(reply, waitMs);

    const message: NotificationMessage = {
      subject: 'UpBid test notification',
      body: [
        body.data.message ?? 'This is a test from the UpBid settings page.',
        `Sent: ${new Date().toISOString()}`,
        'If you can read this, the channel is wired up correctly.',
      ].join('\n'),
      url: publicUrl('/'),
      refType: 'settings',
      refId: 'notify-test',
    };

    // notifyUrgent never throws and never batches, and it reports per channel.
    const result = await notifyUrgent(message);
    log.info(
      { delivered: result.delivered, failed: result.failed, skipped: result.skipped },
      'test notification dispatched',
    );

    return reply.send({
      ok: result.delivered > 0,
      delivered: result.delivered,
      failed: result.failed,
      skipped: result.skipped,
      durationMs: result.durationMs,
      results: result.results,
      channels: channelStatus(),
    });
  });
}
