/**
 * Upwork OAuth2 client. Tokens live in the OAuthToken table (provider "upwork")
 * so every worker process shares one connection, and refreshes are serialised
 * through a Redis lock so a fleet of workers only spends one refresh token.
 */

import { z } from 'zod';
import { env, hasUpworkOAuth, publicUrl } from '../config/env';
import { ConfigError, UpstreamError, toErrorMessage } from '../lib/errors';
import { createHttpClient, requestWithRetry, sleep } from '../lib/http';
import { child } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { withLock } from '../lib/redis';

const log = child('upwork:oauth');

export const UPWORK_PROVIDER = 'upwork';

/** Refresh when the access token has less than this left on the clock. */
export const REFRESH_WINDOW_MS = 120_000;

const REFRESH_LOCK_KEY = 'upwork:oauth:refresh';
const REFRESH_LOCK_TTL_MS = 30_000;
const LOCK_WAIT_TOTAL_MS = 20_000;
const LOCK_POLL_MS = 500;
const MEMO_TTL_MS = 15_000;

export const DEFAULT_SCOPES = ['public'] as const;

export interface UpworkTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scope: string | null;
}

export interface UpworkConnectionStatus {
  connected: boolean;
  configured: boolean;
  expiresAt: string | null;
  expiresInSeconds: number | null;
  needsRefresh: boolean;
  scope: string | null;
  updatedAt: string | null;
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.union([z.number(), z.string()]).optional(),
  token_type: z.string().optional(),
  scope: z.string().optional(),
});

const tokenClient = createHttpClient({
  timeoutMs: Math.min(env.HTTP_TIMEOUT_MS, 20_000),
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  // 4xx bodies carry the real OAuth error; read them instead of throwing blind.
  validateStatus: (status: number) => status < 500 && status !== 429,
});

interface MemoisedToken {
  accessToken: string;
  expiresAt: Date | null;
  cachedAt: number;
}

let memo: MemoisedToken | null = null;

function trimBase(): string {
  return env.UPWORK_API_BASE.replace(/\/+$/, '');
}

export function authorizeEndpoint(): string {
  return `${trimBase()}/ab/account-security/oauth2/authorize`;
}

export function tokenEndpoint(): string {
  return `${trimBase()}/api/v3/oauth2/token`;
}

export function isOAuthConfigured(): boolean {
  return hasUpworkOAuth();
}

function requireConfig(): { clientId: string; clientSecret: string; redirectUri: string } {
  if (!env.UPWORK_CLIENT_ID || !env.UPWORK_CLIENT_SECRET || !env.UPWORK_REDIRECT_URI) {
    throw new ConfigError(
      'Upwork OAuth is not configured. Set UPWORK_CLIENT_ID, UPWORK_CLIENT_SECRET and ' +
        'UPWORK_REDIRECT_URI (create the app at https://www.upwork.com/developer/keys/), then restart.',
    );
  }
  return {
    clientId: env.UPWORK_CLIENT_ID,
    clientSecret: env.UPWORK_CLIENT_SECRET,
    redirectUri: env.UPWORK_REDIRECT_URI,
  };
}

/** Authorization-code URL the operator opens once to connect the account. */
export function buildAuthUrl(state: string, scopes: readonly string[] = DEFAULT_SCOPES): string {
  const config = requireConfig();
  const url = new URL(authorizeEndpoint());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  if (state) url.searchParams.set('state', state);
  if (scopes.length > 0) url.searchParams.set('scope', scopes.join(' '));
  return url.toString();
}

function basicAuthHeader(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`;
}

function expiresAtFrom(expiresIn: unknown): Date | null {
  const seconds = typeof expiresIn === 'string' ? Number(expiresIn) : expiresIn;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(Date.now() + seconds * 1000);
}

interface TokenErrorBody {
  error?: unknown;
  error_description?: unknown;
  message?: unknown;
}

function describeTokenError(status: number, body: unknown): string {
  const record = (body && typeof body === 'object' ? body : {}) as TokenErrorBody;
  const parts = [
    typeof record.error === 'string' ? record.error : null,
    typeof record.error_description === 'string' ? record.error_description : null,
    typeof record.message === 'string' ? record.message : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? `${status}: ${parts.join(' - ')}` : `${status}`;
}

async function postTokenRequest(form: Record<string, string>, label: string): Promise<UpworkTokens> {
  const config = requireConfig();
  const body = new URLSearchParams(form).toString();

  const response = await requestWithRetry<unknown>(
    {
      url: tokenEndpoint(),
      method: 'POST',
      data: body,
      headers: {
        Authorization: basicAuthHeader(config.clientId, config.clientSecret),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
    },
    { client: tokenClient, label, maxRetries: 2 },
  );

  if (response.status >= 400) {
    throw new UpstreamError(`Upwork token request failed (${describeTokenError(response.status, response.data)})`, {
      upstreamStatus: response.status,
      details: { label },
    });
  }

  const parsed = tokenResponseSchema.safeParse(response.data);
  if (!parsed.success) {
    throw new UpstreamError('Upwork token response did not contain an access_token', {
      upstreamStatus: response.status,
      details: { label, issues: parsed.error.issues.map((issue) => issue.message) },
    });
  }

  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token ?? null,
    expiresAt: expiresAtFrom(parsed.data.expires_in),
    scope: parsed.data.scope ?? null,
  };
}

async function persistTokens(tokens: UpworkTokens, previousRefreshToken: string | null): Promise<UpworkTokens> {
  // Upwork does not always return a new refresh token; keep the previous one.
  const refreshToken = tokens.refreshToken ?? previousRefreshToken;
  const stored: UpworkTokens = { ...tokens, refreshToken };

  await prisma.oAuthToken.upsert({
    where: { provider: UPWORK_PROVIDER },
    create: {
      provider: UPWORK_PROVIDER,
      accessToken: stored.accessToken,
      refreshToken: stored.refreshToken,
      expiresAt: stored.expiresAt,
      scope: stored.scope,
    },
    update: {
      accessToken: stored.accessToken,
      refreshToken: stored.refreshToken,
      expiresAt: stored.expiresAt,
      scope: stored.scope,
    },
  });

  memo = { accessToken: stored.accessToken, expiresAt: stored.expiresAt, cachedAt: Date.now() };
  return stored;
}

interface StoredToken {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scope: string | null;
  updatedAt: Date;
}

async function readStoredToken(): Promise<StoredToken | null> {
  const row = await prisma.oAuthToken.findUnique({ where: { provider: UPWORK_PROVIDER } });
  if (!row) return null;
  return {
    accessToken: row.accessToken,
    refreshToken: row.refreshToken,
    expiresAt: row.expiresAt,
    scope: row.scope,
    updatedAt: row.updatedAt,
  };
}

function isExpiring(expiresAt: Date | null, windowMs = REFRESH_WINDOW_MS): boolean {
  if (!expiresAt) return false;
  return expiresAt.getTime() - Date.now() <= windowMs;
}

function notConnectedError(): ConfigError {
  return new ConfigError(
    'Upwork account is not connected yet. Open ' +
      `${publicUrl('/oauth/upwork/start')} in a browser, approve the app, and the ` +
      'callback will store the tokens. Detection from RSS/IMAP/webhook sources works without this.',
    { details: { provider: UPWORK_PROVIDER, authorizeEndpoint: authorizeEndpoint() } },
  );
}

/** Exchanges the callback code for tokens and stores them. */
export async function exchangeCode(code: string): Promise<UpworkTokens> {
  const config = requireConfig();
  if (!code.trim()) throw new ConfigError('Upwork OAuth callback did not include a code');

  const previous = await readStoredToken().catch(() => null);
  const tokens = await postTokenRequest(
    {
      grant_type: 'authorization_code',
      code: code.trim(),
      redirect_uri: config.redirectUri,
    },
    'POST upwork/oauth2/token(authorization_code)',
  );

  const stored = await persistTokens(tokens, previous?.refreshToken ?? null);
  log.info({ expiresAt: stored.expiresAt?.toISOString() ?? null }, 'upwork oauth connected');
  return stored;
}

async function performRefresh(refreshToken: string, previous: StoredToken | null): Promise<UpworkTokens> {
  const tokens = await postTokenRequest(
    { grant_type: 'refresh_token', refresh_token: refreshToken },
    'POST upwork/oauth2/token(refresh_token)',
  );
  const stored = await persistTokens(tokens, previous?.refreshToken ?? null);
  log.info({ expiresAt: stored.expiresAt?.toISOString() ?? null }, 'upwork access token refreshed');
  return stored;
}

/**
 * Refreshes the access token. Concurrent callers across workers coordinate on a
 * Redis lock: the loser waits for the winner's write instead of burning the
 * refresh token a second time.
 */
export async function refreshTokens(force = false): Promise<UpworkTokens> {
  requireConfig();

  const current = await readStoredToken();
  if (!current) throw notConnectedError();
  if (!current.refreshToken) {
    throw new ConfigError(
      'Upwork access token cannot be refreshed: no refresh_token was stored. Reconnect at ' +
        publicUrl('/oauth/upwork/start'),
    );
  }

  if (!force && !isExpiring(current.expiresAt)) {
    return {
      accessToken: current.accessToken,
      refreshToken: current.refreshToken,
      expiresAt: current.expiresAt,
      scope: current.scope,
    };
  }

  const refreshed = await withLock(REFRESH_LOCK_KEY, REFRESH_LOCK_TTL_MS, async () => {
    // Re-read inside the lock: another worker may have refreshed while we waited.
    const inside = await readStoredToken();
    if (inside && !force && !isExpiring(inside.expiresAt)) {
      return {
        accessToken: inside.accessToken,
        refreshToken: inside.refreshToken,
        expiresAt: inside.expiresAt,
        scope: inside.scope,
      } satisfies UpworkTokens;
    }
    const token = inside?.refreshToken ?? current.refreshToken;
    if (!token) throw notConnectedError();
    return performRefresh(token, inside ?? current);
  });

  if (refreshed) return refreshed;

  // Lock held elsewhere: poll for the other worker's fresh token.
  const deadline = Date.now() + LOCK_WAIT_TOTAL_MS;
  while (Date.now() < deadline) {
    await sleep(LOCK_POLL_MS);
    const latest = await readStoredToken();
    if (latest && latest.accessToken !== current.accessToken && !isExpiring(latest.expiresAt)) {
      memo = { accessToken: latest.accessToken, expiresAt: latest.expiresAt, cachedAt: Date.now() };
      return {
        accessToken: latest.accessToken,
        refreshToken: latest.refreshToken,
        expiresAt: latest.expiresAt,
        scope: latest.scope,
      };
    }
  }

  throw new UpstreamError('Timed out waiting for another worker to refresh the Upwork token', {
    details: { lock: REFRESH_LOCK_KEY, waitedMs: LOCK_WAIT_TOTAL_MS },
  });
}

/**
 * Current access token, refreshed transparently when it is about to expire.
 * Throws ConfigError with an actionable message when the app is not connected.
 */
export async function getAccessToken(): Promise<string> {
  if (!isOAuthConfigured()) {
    throw new ConfigError(
      'Upwork OAuth is not configured. Set UPWORK_CLIENT_ID, UPWORK_CLIENT_SECRET and ' +
        'UPWORK_REDIRECT_URI, then connect the account at ' +
        publicUrl('/oauth/upwork/start'),
    );
  }

  if (memo && Date.now() - memo.cachedAt < MEMO_TTL_MS && !isExpiring(memo.expiresAt)) {
    return memo.accessToken;
  }

  const stored = await readStoredToken();
  if (!stored) {
    memo = null;
    throw notConnectedError();
  }

  if (isExpiring(stored.expiresAt)) {
    const refreshed = await refreshTokens(false);
    return refreshed.accessToken;
  }

  memo = { accessToken: stored.accessToken, expiresAt: stored.expiresAt, cachedAt: Date.now() };
  return stored.accessToken;
}

/** Forces a refresh - used when the API answers 401 despite a valid-looking token. */
export async function forceRefreshAccessToken(): Promise<string> {
  memo = null;
  const refreshed = await refreshTokens(true);
  return refreshed.accessToken;
}

/** Authorization (and tenant) headers for every Upwork API call. */
export async function authorizedHeaders(extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const accessToken = await getAccessToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
    ...extra,
  };
  if (env.UPWORK_TENANT_ID) headers['X-Upwork-API-TenantId'] = env.UPWORK_TENANT_ID;
  return headers;
}

export async function getConnectionStatus(): Promise<UpworkConnectionStatus> {
  const configured = isOAuthConfigured();
  try {
    const stored = configured ? await readStoredToken() : null;
    if (!stored) {
      return {
        connected: false,
        configured,
        expiresAt: null,
        expiresInSeconds: null,
        needsRefresh: false,
        scope: null,
        updatedAt: null,
      };
    }
    const expiresInSeconds = stored.expiresAt
      ? Math.round((stored.expiresAt.getTime() - Date.now()) / 1000)
      : null;
    return {
      connected: true,
      configured,
      expiresAt: stored.expiresAt ? stored.expiresAt.toISOString() : null,
      expiresInSeconds,
      needsRefresh: isExpiring(stored.expiresAt),
      scope: stored.scope,
      updatedAt: stored.updatedAt.toISOString(),
    };
  } catch (err) {
    log.warn({ err }, 'failed to read upwork oauth status');
    return {
      connected: false,
      configured,
      expiresAt: null,
      expiresInSeconds: null,
      needsRefresh: false,
      scope: null,
      updatedAt: null,
    };
  }
}

/** Drops the stored tokens (operator "disconnect" action). */
export async function disconnect(): Promise<boolean> {
  memo = null;
  try {
    await prisma.oAuthToken.delete({ where: { provider: UPWORK_PROVIDER } });
    return true;
  } catch (err) {
    log.debug({ err: toErrorMessage(err) }, 'no upwork oauth token to delete');
    return false;
  }
}

/** Test seam: clears the in-process access-token memo. */
export function clearTokenCache(): void {
  memo = null;
}
