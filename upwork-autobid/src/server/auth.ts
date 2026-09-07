import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env, isProd } from '../config/env';
import { safeEqual, sha256 } from '../lib/hash';
import { child } from '../lib/logger';

const log = child('api:auth');

export const SESSION_COOKIE = 'upbid_session';

/** Thirty days: the dashboard is a long-lived operator tool, not a public site. */
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

/** Failed logins tolerated per client address inside LOGIN_WINDOW_MS. */
const LOGIN_MAX_FAILURES = 10;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;

/** Paths served without an API key. Everything else under /api needs one. */
const EXEMPT_EXACT = new Set<string>([
  '/api/health',
  '/api/health/live',
  '/api/login',
  '/api/logout',
  '/api/session',
  '/api/oauth/upwork/callback',
  '/oauth/upwork/callback',
]);

const EXEMPT_PREFIXES = ['/api/health/', '/api/actions/'];

/**
 * The one-tap links built by the review queue point at
 * /api/proposals/:id/approve?token=... and are opened from a mail client or
 * Telegram, where no header and no cookie is available. They carry their own
 * HMAC token, verified inside the handler, so the API key gate is skipped.
 */
const SIGNED_PROPOSAL_ACTION = /^\/api\/proposals\/[^/]+\/(?:approve|reject)\/?$/;

export interface AuthFailure {
  code: 'UNAUTHORIZED';
  message: string;
}

/** True when this instance enforces an API key at all (dev may run open). */
export function authRequired(): boolean {
  return Boolean(env.API_KEY);
}

/**
 * Opaque cookie value derived from the API key. It is not the key itself, so a
 * stolen cookie cannot be replayed as an Authorization header against another
 * deployment, and it changes the moment the operator rotates API_KEY.
 */
export function sessionToken(): string {
  return sha256(`upbid:dashboard-session:v1:${env.API_KEY ?? ''}`);
}

export function pathOf(url: string): string {
  const queryAt = url.indexOf('?');
  const path = queryAt === -1 ? url : url.slice(0, queryAt);
  const hashAt = path.indexOf('#');
  return hashAt === -1 ? path : path.slice(0, hashAt);
}

/** Static assets and self-authenticating endpoints bypass the key check. */
export function isExempt(method: string, url: string): boolean {
  const path = pathOf(url);
  if (EXEMPT_EXACT.has(path)) return true;
  if (EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
  if (method === 'GET' && SIGNED_PROPOSAL_ACTION.test(path)) return true;
  // The root-prefixed OAuth aliases are the same endpoints as their /api twins
  // and must not become an anonymous way to start a flow.
  if (path.startsWith('/oauth/')) return false;
  if (!path.startsWith('/api')) return true;
  return false;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const jar: Record<string, string> = {};
  if (!header) return jar;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    if (name === '') continue;
    const value = part.slice(index + 1).trim();
    try {
      jar[name] = decodeURIComponent(value);
    } catch {
      jar[name] = value;
    }
  }
  return jar;
}

function headerValue(value: string | string[] | undefined): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'string') return value[0];
  return null;
}

interface PresentedCredentials {
  apiKey: string | null;
  cookie: string | null;
}

export function readCredentials(request: FastifyRequest): PresentedCredentials {
  const authorization = headerValue(request.headers.authorization);
  const bearer =
    authorization && /^bearer\s+/i.test(authorization)
      ? authorization.replace(/^bearer\s+/i, '').trim()
      : null;
  const direct = headerValue(request.headers['x-api-key']);
  const cookies = parseCookies(headerValue(request.headers.cookie) ?? undefined);
  const cookie = cookies[SESSION_COOKIE] ?? null;

  return {
    apiKey: bearer && bearer !== '' ? bearer : direct && direct.trim() !== '' ? direct.trim() : null,
    cookie: cookie && cookie !== '' ? cookie : null,
  };
}

/** Constant-time credential check. Returns null when the request may proceed. */
export function checkCredentials(request: FastifyRequest): AuthFailure | null {
  const expected = env.API_KEY;
  if (!expected) return null;

  const { apiKey, cookie } = readCredentials(request);

  if (apiKey && safeEqual(apiKey, expected)) return null;
  if (cookie && safeEqual(cookie, sessionToken())) return null;

  return {
    code: 'UNAUTHORIZED',
    message:
      apiKey || cookie
        ? 'invalid credentials'
        : 'missing credentials: send Authorization: Bearer <API_KEY>, x-api-key, or sign in at /api/login',
  };
}

/**
 * Returns the reply when it rejects: an async Fastify hook must hand the reply
 * back for the lifecycle to stop before the route handler runs.
 */
export async function apiKeyPreHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  if (isExempt(request.method, request.url)) return undefined;

  const failure = checkCredentials(request);
  if (!failure) return undefined;

  log.warn(
    { method: request.method, path: pathOf(request.url), ip: request.ip },
    'rejected unauthenticated request',
  );
  await reply.code(401).send({ error: failure });
  return reply;
}

function cookieAttributes(maxAgeSeconds: number): string {
  const parts = [
    `Path=/`,
    `HttpOnly`,
    `SameSite=Lax`,
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (isProd) parts.push('Secure');
  return parts.join('; ');
}

export function setSessionCookie(reply: FastifyReply): void {
  reply.header(
    'set-cookie',
    `${SESSION_COOKIE}=${sessionToken()}; ${cookieAttributes(SESSION_MAX_AGE_SECONDS)}`,
  );
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.header('set-cookie', `${SESSION_COOKIE}=; ${cookieAttributes(0)}`);
}

/* ------------------------------------------------------- login rate limiting */

interface FailureWindow {
  count: number;
  resetAt: number;
}

const loginFailures = new Map<string, FailureWindow>();

function pruneFailures(now: number): void {
  if (loginFailures.size < 512) return;
  for (const [key, window] of loginFailures) {
    if (window.resetAt <= now) loginFailures.delete(key);
  }
}

function isLoginBlocked(ip: string): boolean {
  const now = Date.now();
  const window = loginFailures.get(ip);
  if (!window) return false;
  if (window.resetAt <= now) {
    loginFailures.delete(ip);
    return false;
  }
  return window.count >= LOGIN_MAX_FAILURES;
}

function recordLoginFailure(ip: string): void {
  const now = Date.now();
  pruneFailures(now);
  const window = loginFailures.get(ip);
  if (!window || window.resetAt <= now) {
    loginFailures.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return;
  }
  window.count += 1;
}

function clearLoginFailures(ip: string): void {
  loginFailures.delete(ip);
}

/** Test seam so the limiter does not leak state between suites. */
export function resetLoginThrottle(): void {
  loginFailures.clear();
}

const loginBodySchema = z.object({
  apiKey: z.string().min(1, 'apiKey is required').max(512),
});

/* ---------------------------------------------------------------- plugin */

/**
 * Installs the credential gate and the three session endpoints. Must run before
 * any route is registered on the same instance: Fastify binds the hook chain of
 * a route when the route is added.
 */
export function registerAuth(app: FastifyInstance): void {
  if (!authRequired()) {
    log.warn(
      'API_KEY is not set: the dashboard and API are unauthenticated. Set API_KEY before exposing this instance.',
    );
  }

  app.addHook('preHandler', apiKeyPreHandler);

  app.post('/api/login', async (request, reply) => {
    const parsed = loginBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: 'BAD_REQUEST',
          message: 'apiKey is required',
          issues: parsed.error.issues.map((issue) => issue.message),
        },
      });
    }

    if (!authRequired()) {
      setSessionCookie(reply);
      return reply.send({ authenticated: true, authRequired: false });
    }

    if (isLoginBlocked(request.ip)) {
      return reply
        .code(429)
        .send({ error: { code: 'TOO_MANY_ATTEMPTS', message: 'too many failed logins, retry later' } });
    }

    const expected = env.API_KEY ?? '';
    if (!safeEqual(parsed.data.apiKey, expected)) {
      recordLoginFailure(request.ip);
      log.warn({ ip: request.ip }, 'failed dashboard login');
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'invalid api key' } });
    }

    clearLoginFailures(request.ip);
    setSessionCookie(reply);
    return reply.send({ authenticated: true, authRequired: true });
  });

  app.post('/api/logout', async (_request, reply) => {
    clearSessionCookie(reply);
    return reply.send({ authenticated: false });
  });

  app.get('/api/session', async (request, reply) => {
    const failure = checkCredentials(request);
    return reply.send({
      authenticated: failure === null,
      authRequired: authRequired(),
    });
  });
}

export default registerAuth;
