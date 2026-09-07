import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { publicUrl } from '../../config/env';
import { toErrorMessage } from '../../lib/errors';
import { child } from '../../lib/logger';
import { redis } from '../../lib/redis';
import {
  buildAuthUrl,
  disconnect,
  exchangeCode,
  getConnectionStatus,
  isOAuthConfigured,
} from '../../sources/upwork-oauth';
import { emit } from '../sse';

const log = child('api:oauth');

const STATE_PREFIX = 'upbid:oauth:state:';
const STATE_TTL_SECONDS = 600;

const callbackQuerySchema = z.object({
  code: z.string().trim().min(1).max(2048).optional(),
  state: z.string().trim().min(8).max(128).optional(),
  error: z.string().trim().max(200).optional(),
  error_description: z.string().trim().max(500).optional(),
});

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderPage(title: string, heading: string, lines: string[], ok: boolean): string {
  const accent = ok ? '#16a34a' : '#dc2626';
  const items = lines.map((line) => `<p>${escapeHtml(line)}</p>`).join('\n      ');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
        font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        background: #0f172a; color: #e2e8f0; padding: 24px;
      }
      .card {
        max-width: 460px; width: 100%; background: #1e293b; border-radius: 14px; padding: 28px;
        border: 1px solid #334155; box-shadow: 0 18px 40px rgba(0,0,0,.35);
      }
      h1 { margin: 0 0 12px; font-size: 19px; color: ${accent}; }
      p { margin: 0 0 10px; color: #cbd5e1; }
      a.button {
        display: inline-block; margin-top: 14px; padding: 9px 16px; border-radius: 8px;
        background: #2563eb; color: #fff; text-decoration: none; font-weight: 600;
      }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${escapeHtml(heading)}</h1>
      ${items}
      <a class="button" href="${escapeHtml(publicUrl('/'))}">Open the dashboard</a>
    </div>
  </body>
</html>`;
}

function sendPage(
  reply: FastifyReply,
  status: number,
  title: string,
  heading: string,
  lines: string[],
  ok: boolean,
): FastifyReply {
  return reply
    .code(status)
    .header('Content-Type', 'text/html; charset=utf-8')
    .header('Cache-Control', 'no-store')
    .send(renderPage(title, heading, lines, ok));
}

async function consumeState(state: string): Promise<boolean> {
  const key = `${STATE_PREFIX}${state}`;
  try {
    const stored = await redis.get(key);
    if (stored === null) return false;
    await redis.del(key);
    return true;
  } catch (err) {
    log.error({ err: toErrorMessage(err) }, 'failed to verify the oauth state');
    return false;
  }
}

export default async function oauthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/oauth/upwork/start', async (request, reply) => {
    if (!isOAuthConfigured()) {
      return sendPage(
        reply,
        400,
        'UpBid - Upwork OAuth',
        'Upwork OAuth is not configured',
        [
          'Set UPWORK_CLIENT_ID, UPWORK_CLIENT_SECRET and UPWORK_REDIRECT_URI, then restart the service.',
          'Detection through the RSS, email and webhook sources works without this step.',
        ],
        false,
      );
    }

    const state = randomBytes(24).toString('base64url');

    try {
      await redis.set(
        `${STATE_PREFIX}${state}`,
        JSON.stringify({ createdAt: new Date().toISOString(), ip: request.ip }),
        'EX',
        STATE_TTL_SECONDS,
      );
    } catch (err) {
      log.error({ err: toErrorMessage(err) }, 'failed to store the oauth state');
      return sendPage(
        reply,
        503,
        'UpBid - Upwork OAuth',
        'Cannot start the OAuth flow',
        ['Redis is unreachable, so the CSRF state could not be stored. Try again once Redis is back.'],
        false,
      );
    }

    let target: string;
    try {
      target = buildAuthUrl(state);
    } catch (err) {
      log.error({ err: toErrorMessage(err) }, 'failed to build the upwork authorize url');
      return sendPage(
        reply,
        400,
        'UpBid - Upwork OAuth',
        'Cannot start the OAuth flow',
        [toErrorMessage(err)],
        false,
      );
    }

    log.info({ ip: request.ip }, 'upwork oauth flow started');
    return reply.code(302).header('Cache-Control', 'no-store').redirect(target);
  });

  app.get('/oauth/upwork/callback', async (request, reply) => {
    const parsed = callbackQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return sendPage(
        reply,
        400,
        'UpBid - Upwork OAuth',
        'Invalid callback',
        ['The callback query string could not be parsed.'],
        false,
      );
    }

    const query = parsed.data;

    if (query.error) {
      log.warn({ error: query.error }, 'upwork denied the oauth request');
      return sendPage(
        reply,
        400,
        'UpBid - Upwork OAuth',
        'Upwork rejected the authorization',
        [query.error_description ?? query.error],
        false,
      );
    }

    if (!query.code || !query.state) {
      return sendPage(
        reply,
        400,
        'UpBid - Upwork OAuth',
        'Incomplete callback',
        ['The callback arrived without a code or a state parameter.'],
        false,
      );
    }

    // Single use: a replayed callback must not be able to mint a second token.
    const stateOk = await consumeState(query.state);
    if (!stateOk) {
      log.warn({ ip: request.ip }, 'upwork oauth callback with an unknown state');
      return sendPage(
        reply,
        400,
        'UpBid - Upwork OAuth',
        'The authorization state expired',
        [
          'This link was already used or is older than ten minutes.',
          'Start the flow again from the dashboard.',
        ],
        false,
      );
    }

    try {
      const tokens = await exchangeCode(query.code);
      log.info({ expiresAt: tokens.expiresAt?.toISOString() ?? null }, 'upwork oauth connected');
      emit('oauth.connected', {
        provider: 'upwork',
        expiresAt: tokens.expiresAt ? tokens.expiresAt.toISOString() : null,
      });

      return sendPage(
        reply,
        200,
        'UpBid - Upwork connected',
        'Upwork account connected',
        [
          tokens.expiresAt
            ? `The access token is valid until ${tokens.expiresAt.toISOString()} and refreshes itself.`
            : 'The access token was stored and refreshes itself.',
          'Detection through the Upwork API is now active on the next poll.',
        ],
        true,
      );
    } catch (err) {
      log.error({ err: toErrorMessage(err) }, 'upwork token exchange failed');
      return sendPage(
        reply,
        502,
        'UpBid - Upwork OAuth',
        'Token exchange failed',
        [toErrorMessage(err), 'Check the client credentials and the registered redirect URI.'],
        false,
      );
    }
  });

  app.get('/oauth/upwork/status', async (_request, reply) => {
    const status = await getConnectionStatus();
    return reply.send({
      provider: 'upwork',
      startUrl: publicUrl('/api/oauth/upwork/start'),
      ...status,
    });
  });

  app.post('/oauth/upwork/disconnect', async (_request, reply) => {
    const removed = await disconnect();
    if (removed) {
      log.warn('upwork oauth tokens deleted');
      emit('oauth.disconnected', { provider: 'upwork' });
    }
    return reply.send({ disconnected: removed });
  });
}
