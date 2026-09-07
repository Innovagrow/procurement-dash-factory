import axios, {
  type AxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosResponse,
} from 'axios';
import { env } from '../config/env';
import { child } from './logger';
import { RateLimitError, UpstreamError, isRetryable } from './errors';

const log = child('http');

export const USER_AGENT = 'UpBid/1.0 (+https://github.com/upbid)';

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 522, 524]);

export interface HttpClientOptions {
  baseURL?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Treat these statuses as resolved responses instead of thrown errors. */
  validateStatus?: (status: number) => boolean;
}

/** Creates an axios instance with a hard timeout and a User-Agent already set. */
export function createHttpClient(options: HttpClientOptions = {}): AxiosInstance {
  const instance = axios.create({
    baseURL: options.baseURL,
    timeout: options.timeoutMs ?? env.HTTP_TIMEOUT_MS,
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json, text/plain, */*',
      ...options.headers,
    },
    ...(options.validateStatus ? { validateStatus: options.validateStatus } : {}),
  });
  return instance;
}

/** Shared default client - callers that need auth headers should make their own. */
export const http: AxiosInstance = createHttpClient();

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** Full jitter: random over the whole backoff window, which decorrelates retries. */
export function backoffDelay(attempt: number, baseMs = 500, maxMs = 30000): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.floor(Math.random() * exponential);
}

/** Parses Retry-After as either delta-seconds or an HTTP date. */
export function parseRetryAfter(value: string | undefined | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? seconds * 1000 : null;
  }
  const asDate = Date.parse(trimmed);
  if (Number.isNaN(asDate)) return null;
  return Math.max(0, asDate - Date.now());
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const record = headers as Record<string, unknown>;
  const direct = record[name] ?? record[name.toLowerCase()];
  if (typeof direct === 'string') return direct;
  if (Array.isArray(direct) && typeof direct[0] === 'string') return direct[0];
  return undefined;
}

function isAxiosErrorLike(err: unknown): err is AxiosError {
  return Boolean(err) && typeof err === 'object' && (err as AxiosError).isAxiosError === true;
}

/* ------------------------------------------------------------ rate limiting */

/**
 * Token bucket. capacity tokens, refilled at refillPerSecond. take() waits until
 * a token is available rather than rejecting, so callers just await it.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefill) / 1000;
    if (elapsedSeconds <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
    this.lastRefill = now;
  }

  /** Milliseconds until at least one token is available. */
  private waitTimeMs(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    const deficit = 1 - this.tokens;
    return Math.ceil((deficit / this.refillPerSecond) * 1000);
  }

  tryTake(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  async take(): Promise<void> {
    // Loop rather than sleeping once: concurrent callers may drain the refill.
    for (;;) {
      const wait = this.waitTimeMs();
      if (wait === 0) {
        this.tokens -= 1;
        return;
      }
      await sleep(wait);
    }
  }

  get available(): number {
    this.refill();
    return Math.floor(this.tokens);
  }
}

const hostLimiters = new Map<string, RateLimiter>();

/** Per-host limiter, created on first use. Default 5 req/s, burst 10. */
export function limiterForHost(host: string, capacity = 10, refillPerSecond = 5): RateLimiter {
  let limiter = hostLimiters.get(host);
  if (!limiter) {
    limiter = new RateLimiter(capacity, refillPerSecond);
    hostLimiters.set(host, limiter);
  }
  return limiter;
}

function hostOf(url: string | undefined, baseURL?: string): string {
  if (!url && !baseURL) return 'unknown';
  try {
    return new URL(url ?? '', baseURL).host || 'unknown';
  } catch {
    return baseURL ?? url ?? 'unknown';
  }
}

/* --------------------------------------------------------- circuit breaker */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  cooldownMs?: number;
  /** Consecutive successes in HALF_OPEN required to close the circuit again. */
  successThreshold?: number;
  name?: string;
}

/**
 * Stops hammering a dependency that is already failing. After failureThreshold
 * consecutive failures the circuit opens and calls fail fast until cooldownMs
 * elapses, then a single trial request decides whether to close it.
 */
export class CircuitBreaker {
  private failures = 0;
  private successes = 0;
  private openedAt = 0;
  private state: CircuitState = 'CLOSED';

  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly successThreshold: number;
  readonly name: string;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 30000;
    this.successThreshold = options.successThreshold ?? 1;
    this.name = options.name ?? 'default';
  }

  get currentState(): CircuitState {
    if (this.state === 'OPEN' && Date.now() - this.openedAt >= this.cooldownMs) {
      this.state = 'HALF_OPEN';
      this.successes = 0;
    }
    return this.state;
  }

  canRequest(): boolean {
    return this.currentState !== 'OPEN';
  }

  // Both readers go through currentState so the OPEN -> HALF_OPEN transition
  // happens even when the caller never polled canRequest() first.
  recordSuccess(): void {
    if (this.currentState === 'HALF_OPEN') {
      this.successes += 1;
      if (this.successes >= this.successThreshold) {
        this.reset();
      }
      return;
    }
    this.failures = 0;
  }

  recordFailure(): void {
    const state = this.currentState;
    if (state === 'HALF_OPEN') {
      this.trip();
      return;
    }
    if (state === 'OPEN') return;
    this.failures += 1;
    if (this.failures >= this.failureThreshold) {
      this.trip();
    }
  }

  private trip(): void {
    this.state = 'OPEN';
    this.openedAt = Date.now();
    this.successes = 0;
    log.warn({ breaker: this.name, cooldownMs: this.cooldownMs }, 'circuit breaker opened');
  }

  reset(): void {
    this.state = 'CLOSED';
    this.failures = 0;
    this.successes = 0;
    this.openedAt = 0;
  }

  /** Milliseconds until the circuit will allow a trial request. */
  retryAfterMs(): number {
    if (this.currentState !== 'OPEN') return 0;
    return Math.max(0, this.cooldownMs - (Date.now() - this.openedAt));
  }

  snapshot(): { name: string; state: CircuitState; failures: number; retryAfterMs: number } {
    return {
      name: this.name,
      state: this.currentState,
      failures: this.failures,
      retryAfterMs: this.retryAfterMs(),
    };
  }
}

const hostBreakers = new Map<string, CircuitBreaker>();

export function breakerForHost(host: string, options: CircuitBreakerOptions = {}): CircuitBreaker {
  let breaker = hostBreakers.get(host);
  if (!breaker) {
    breaker = new CircuitBreaker({ name: host, ...options });
    hostBreakers.set(host, breaker);
  }
  return breaker;
}

/** Snapshot of every known breaker, for /health and the dashboard. */
export function breakerSnapshots(): ReturnType<CircuitBreaker['snapshot']>[] {
  return Array.from(hostBreakers.values()).map((breaker) => breaker.snapshot());
}

/* ------------------------------------------------------------ request layer */

export interface RequestWithRetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Set false to bypass the shared per-host token bucket. */
  rateLimit?: boolean;
  limiter?: RateLimiter;
  breaker?: CircuitBreaker;
  /** Label used in logs; defaults to "METHOD /path". */
  label?: string;
  client?: AxiosInstance;
  /** Extra predicate to force a retry on a resolved response. */
  shouldRetryResponse?: (response: AxiosResponse) => boolean;
}

/**
 * Performs an HTTP request with a token bucket, a circuit breaker, and bounded
 * exponential backoff with full jitter. Retries only 429/5xx/network errors and
 * honours Retry-After. Throws RateLimitError or UpstreamError on final failure.
 */
export async function requestWithRetry<T = unknown>(
  config: AxiosRequestConfig,
  options: RequestWithRetryOptions = {},
): Promise<AxiosResponse<T>> {
  const client = options.client ?? http;
  const maxRetries = options.maxRetries ?? env.HTTP_MAX_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 30000;
  const host = hostOf(config.url, config.baseURL ?? client.defaults.baseURL);
  const limiter = options.limiter ?? (options.rateLimit === false ? null : limiterForHost(host));
  const breaker = options.breaker ?? breakerForHost(host);
  const label = options.label ?? `${(config.method ?? 'GET').toUpperCase()} ${config.url ?? ''}`;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (!breaker.canRequest()) {
      const retryAfterMs = breaker.retryAfterMs();
      throw new UpstreamError(`circuit open for ${host}; skipping ${label}`, {
        details: { host, label, retryAfterMs },
      });
    }

    if (limiter) await limiter.take();

    try {
      const response = await client.request<T>({
        timeout: env.HTTP_TIMEOUT_MS,
        ...config,
      });

      if (options.shouldRetryResponse?.(response)) {
        breaker.recordFailure();
        lastError = new UpstreamError(`${label} returned a retryable response`, {
          upstreamStatus: response.status,
          details: { host, label, status: response.status },
        });
      } else {
        breaker.recordSuccess();
        return response;
      }
    } catch (err) {
      lastError = err;

      const status = isAxiosErrorLike(err) ? err.response?.status : undefined;
      const retryable = status !== undefined ? RETRYABLE_STATUS.has(status) : isRetryable(err);

      if (!retryable) {
        // A 4xx is a real answer from a healthy service - don't trip the breaker.
        if (status === undefined) breaker.recordFailure();
        log.warn(
          { err, host, label, status, attempt },
          'request failed with a non-retryable error',
        );
        throw toUpstreamError(err, label, host);
      }

      breaker.recordFailure();
    }

    if (attempt === maxRetries) break;

    const retryAfterMs = isAxiosErrorLike(lastError)
      ? parseRetryAfter(headerValue(lastError.response?.headers, 'retry-after'))
      : null;
    const delay = retryAfterMs ?? backoffDelay(attempt, baseDelayMs, maxDelayMs);

    log.warn(
      {
        host,
        label,
        attempt: attempt + 1,
        maxRetries,
        delayMs: delay,
        status: isAxiosErrorLike(lastError) ? lastError.response?.status : undefined,
      },
      'retrying request after failure',
    );

    await sleep(Math.min(delay, maxDelayMs));
  }

  throw toUpstreamError(lastError, label, host, maxRetries);
}

function toUpstreamError(err: unknown, label: string, host: string, attempts?: number): Error {
  if (err instanceof RateLimitError || err instanceof UpstreamError) return err;

  if (isAxiosErrorLike(err)) {
    const status = err.response?.status;
    const retryAfterMs = parseRetryAfter(headerValue(err.response?.headers, 'retry-after'));

    if (status === 429) {
      return new RateLimitError(
        `${label} rate limited by ${host}`,
        retryAfterMs === null ? undefined : Math.ceil(retryAfterMs / 1000),
        { details: { host, label, attempts }, cause: err },
      );
    }

    return new UpstreamError(`${label} failed: ${err.message}`, {
      upstreamStatus: status,
      details: {
        host,
        label,
        attempts,
        status,
        code: err.code,
        body: truncateBody(err.response?.data),
      },
      cause: err,
    });
  }

  return new UpstreamError(
    `${label} failed: ${err instanceof Error ? err.message : String(err)}`,
    { details: { host, label, attempts }, cause: err },
  );
}

/** Keeps error logs bounded - upstream HTML error pages can be enormous. */
function truncateBody(body: unknown, maxLength = 500): string | undefined {
  if (body === undefined || body === null) return undefined;
  let text: string;
  if (typeof body === 'string') {
    text = body;
  } else {
    try {
      text = JSON.stringify(body);
    } catch {
      text = String(body);
    }
  }
  return text.length > maxLength ? `${text.slice(0, maxLength)}...[truncated]` : text;
}

/** Convenience wrapper for JSON GETs. */
export async function getJson<T = unknown>(
  url: string,
  config: AxiosRequestConfig = {},
  options: RequestWithRetryOptions = {},
): Promise<T> {
  const response = await requestWithRetry<T>({ ...config, url, method: 'GET' }, options);
  return response.data;
}

/** Convenience wrapper for JSON POSTs. */
export async function postJson<T = unknown>(
  url: string,
  data: unknown,
  config: AxiosRequestConfig = {},
  options: RequestWithRetryOptions = {},
): Promise<T> {
  const response = await requestWithRetry<T>({ ...config, url, method: 'POST', data }, options);
  return response.data;
}

export default http;
