/** Error taxonomy. Workers use isRetryable() to decide between retry and fail-fast. */

export interface AppErrorOptions {
  code?: string;
  status?: number;
  retryable?: boolean;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;
  readonly cause?: unknown;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message);
    this.name = new.target.name;
    this.code = options.code ?? 'APP_ERROR';
    this.status = options.status ?? 500;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? {};
    if (options.cause !== undefined) this.cause = options.cause;
    Error.captureStackTrace?.(this, new.target);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      status: this.status,
      retryable: this.retryable,
      message: this.message,
      details: this.details,
    };
  }
}

/** Transient failure; the caller should back off and try again. */
export class RetryableError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, { code: 'RETRYABLE', status: 503, ...options, retryable: true });
  }
}

/** Missing or invalid configuration. Never retryable - retrying cannot fix it. */
export class ConfigError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, { code: 'CONFIG_ERROR', status: 500, ...options, retryable: false });
  }
}

export class RateLimitError extends AppError {
  /** Seconds to wait before retrying, when the upstream told us. */
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    retryAfterSeconds?: number,
    options: AppErrorOptions = {},
  ) {
    super(message, { code: 'RATE_LIMITED', status: 429, ...options, retryable: true });
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** A dependency (Upwork, Anthropic, SMTP, ...) failed. Retryable for 5xx/network. */
export class UpstreamError extends AppError {
  readonly upstreamStatus?: number;

  constructor(message: string, options: AppErrorOptions & { upstreamStatus?: number } = {}) {
    const upstreamStatus = options.upstreamStatus;
    const retryable =
      options.retryable ??
      (upstreamStatus === undefined || upstreamStatus >= 500 || upstreamStatus === 408 || upstreamStatus === 429);
    super(message, { code: 'UPSTREAM_ERROR', status: 502, ...options, retryable });
    if (upstreamStatus !== undefined) this.upstreamStatus = upstreamStatus;
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, { code: 'NOT_FOUND', status: 404, ...options, retryable: false });
  }
}

export class ValidationError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, { code: 'VALIDATION_ERROR', status: 400, ...options, retryable: false });
  }
}

/** A guard (quota, kill switch, ToS gate) intentionally stopped the action. */
export class GuardError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, { code: 'GUARD_BLOCKED', status: 409, ...options, retryable: false });
  }
}

const RETRYABLE_NODE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'ECONNABORTED',
  'ERR_STREAM_PREMATURE_CLOSE',
]);

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 522, 524]);

function readNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** True when retrying the same operation could plausibly succeed. */
export function isRetryable(err: unknown): boolean {
  if (err instanceof AppError) return err.retryable;
  if (!err || typeof err !== 'object') return false;

  const candidate = err as Record<string, unknown>;

  const code = candidate.code;
  if (typeof code === 'string' && RETRYABLE_NODE_CODES.has(code)) return true;

  const status =
    readNumber(candidate, 'status') ??
    readNumber(candidate, 'statusCode') ??
    (typeof candidate.response === 'object' && candidate.response !== null
      ? readNumber(candidate.response as Record<string, unknown>, 'status')
      : undefined);
  if (status !== undefined) return RETRYABLE_STATUS.has(status);

  // Axios network failures carry no response at all.
  if (candidate.isAxiosError === true && candidate.response === undefined) return true;

  return false;
}

/** Best-effort HTTP status extraction for logging and API responses. */
export function statusOf(err: unknown): number | undefined {
  if (err instanceof AppError) return err.status;
  if (!err || typeof err !== 'object') return undefined;
  const candidate = err as Record<string, unknown>;
  return (
    readNumber(candidate, 'status') ??
    readNumber(candidate, 'statusCode') ??
    (typeof candidate.response === 'object' && candidate.response !== null
      ? readNumber(candidate.response as Record<string, unknown>, 'status')
      : undefined)
  );
}

export function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Shape suited to pino structured logging; never throws. */
export function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof AppError) {
    return { ...err.toJSON(), stack: err.stack };
  }
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      code: (err as NodeJS.ErrnoException).code,
      status: statusOf(err),
    };
  }
  return { message: toErrorMessage(err) };
}

/** Narrows unknown catch values to Error without losing the original value. */
export function asError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(toErrorMessage(err));
}
