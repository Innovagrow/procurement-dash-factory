import { randomUUID } from 'node:crypto';
import IORedis, { type Redis, type RedisOptions } from 'ioredis';
import { env } from '../config/env';
import { child } from './logger';

const log = child('redis');

function parseRedisUrl(url: string): RedisOptions {
  const parsed = new URL(url);
  const isTls = parsed.protocol === 'rediss:';
  const dbFromPath = parsed.pathname.replace(/^\//, '');

  const options: RedisOptions = {
    host: parsed.hostname || 'localhost',
    port: parsed.port ? Number(parsed.port) : 6379,
  };

  if (parsed.username) options.username = decodeURIComponent(parsed.username);
  if (parsed.password) options.password = decodeURIComponent(parsed.password);
  if (dbFromPath && /^\d+$/.test(dbFromPath)) options.db = Number(dbFromPath);
  if (isTls) options.tls = { servername: parsed.hostname };

  return options;
}

/**
 * BullMQ owns its own connections (it needs blocking commands on dedicated
 * sockets), so it takes options rather than a shared client. maxRetriesPerRequest
 * must be null or BullMQ refuses to start.
 */
export const redisConnectionOptions: RedisOptions = {
  ...parseRedisUrl(env.REDIS_URL),
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  retryStrategy: (times: number) => Math.min(times * 200, 5000),
};

/** Fresh connection for a BullMQ Queue/Worker/QueueEvents instance. */
export function createRedisConnection(name = 'bullmq'): Redis {
  const connection = new IORedis(redisConnectionOptions);
  connection.on('error', (err: Error) => log.error({ err, name }, 'redis connection error'));
  return connection;
}

function createGeneralClient(): Redis {
  const client = new IORedis({
    ...parseRedisUrl(env.REDIS_URL),
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
    retryStrategy: (times: number) => Math.min(times * 200, 5000),
  });
  client.on('error', (err: Error) => log.error({ err }, 'redis client error'));
  client.on('reconnecting', () => log.warn('redis reconnecting'));
  return client;
}

const globalForRedis = globalThis as unknown as { __upbidRedis?: Redis };

/** General-purpose client for locks, counters and rate-limit buckets. */
export const redis: Redis = globalForRedis.__upbidRedis ?? createGeneralClient();
globalForRedis.__upbidRedis = redis;

export async function pingRedis(): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
  const started = Date.now();
  try {
    const pong = await redis.ping();
    return { ok: pong === 'PONG', latencyMs: Date.now() - started };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function disconnectRedis(): Promise<void> {
  try {
    await redis.quit();
  } catch {
    redis.disconnect();
  } finally {
    if (globalForRedis.__upbidRedis) delete globalForRedis.__upbidRedis;
  }
}

// Only delete the key if we still own it - a lock that expired and was re-taken
// by another worker must not be released by the previous holder.
const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

const EXTEND_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
else
  return 0
end
`;

export interface Lock {
  key: string;
  token: string;
  release(): Promise<boolean>;
  extend(ttlMs: number): Promise<boolean>;
}

function lockKey(key: string): string {
  return key.startsWith('upbid:lock:') ? key : `upbid:lock:${key}`;
}

/** Acquires a lock, or returns null immediately if someone else holds it. */
export async function acquireLock(key: string, ttlMs: number): Promise<Lock | null> {
  const fullKey = lockKey(key);
  const token = randomUUID();
  const result = await redis.set(fullKey, token, 'PX', Math.max(1, Math.floor(ttlMs)), 'NX');
  if (result !== 'OK') return null;

  return {
    key: fullKey,
    token,
    async release(): Promise<boolean> {
      const released = await redis.eval(RELEASE_LOCK_SCRIPT, 1, fullKey, token);
      return released === 1;
    },
    async extend(nextTtlMs: number): Promise<boolean> {
      const extended = await redis.eval(
        EXTEND_LOCK_SCRIPT,
        1,
        fullKey,
        token,
        String(Math.max(1, Math.floor(nextTtlMs))),
      );
      return extended === 1;
    },
  };
}

/**
 * Runs fn under a distributed lock. Returns null without running fn when the
 * lock is held elsewhere - callers treat that as "another worker has this".
 */
export async function withLock<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T | null> {
  const lock = await acquireLock(key, ttlMs);
  if (!lock) {
    log.debug({ key }, 'lock busy, skipping');
    return null;
  }
  try {
    return await fn();
  } finally {
    try {
      await lock.release();
    } catch (err) {
      // The lock expires on its own; a failed release must not mask fn's result.
      log.warn({ err, key }, 'lock release failed');
    }
  }
}

// INCRBY + conditional EXPIRE in one round trip. Setting the TTL only on the
// first increment keeps the bucket aligned to its time window instead of
// sliding forward on every hit (and avoids EXPIRE ... NX, which needs Redis 7).
const INCR_WITH_TTL_SCRIPT = `
local current = redis.call("incrby", KEYS[1], ARGV[1])
if current == tonumber(ARGV[1]) then
  redis.call("pexpire", KEYS[1], ARGV[2])
end
return current
`;

/**
 * Increments a counter that expires after ttlSeconds. Used for hourly/daily
 * quota buckets keyed by the time.ts bucket helpers.
 */
export async function incrementCounter(key: string, ttlSeconds: number, by = 1): Promise<number> {
  const fullKey = key.startsWith('upbid:counter:') ? key : `upbid:counter:${key}`;
  const value = await redis.eval(
    INCR_WITH_TTL_SCRIPT,
    1,
    fullKey,
    String(by),
    String(Math.max(1, Math.floor(ttlSeconds)) * 1000),
  );
  return typeof value === 'number' ? value : Number(value ?? 0);
}

export async function getCounter(key: string): Promise<number> {
  const fullKey = key.startsWith('upbid:counter:') ? key : `upbid:counter:${key}`;
  const value = await redis.get(fullKey);
  return value === null ? 0 : Number(value) || 0;
}

export default redis;
