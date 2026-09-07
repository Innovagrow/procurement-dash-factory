/**
 * Shared machinery for every job source: rate limiting, circuit breaking,
 * checkpoint bookkeeping and a fetch path that can never throw into the worker.
 */

import { Prisma } from '@prisma/client';
import { env, sourcesEnabled } from '../config/env';
import { toErrorMessage } from '../lib/errors';
import { CircuitBreaker, RateLimiter, type CircuitBreakerOptions } from '../lib/http';
import { child, type Logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { toIso } from '../lib/time';
import type { JobSource, RawJob, SourceContext, SourceResult } from '../types';

/** True when the operator listed this source (or one of its aliases) in SOURCES. */
export function isSourceSelected(name: string, aliases: string[] = []): boolean {
  const wanted = new Set([name, ...aliases].map((entry) => entry.toLowerCase()));
  return sourcesEnabled.some((entry) => wanted.has(entry.trim().toLowerCase()));
}

export interface SourceCheckpointView {
  id: string | null;
  source: string;
  profileId: string | null;
  cursor: string | null;
  lastRunAt: Date | null;
  lastSuccessAt: Date | null;
  lastItemAt: Date | null;
  consecutiveFailures: number;
  disabledUntil: Date | null;
  state: Record<string, unknown>;
}

export interface CheckpointPatch {
  cursor?: string | null;
  lastRunAt?: Date | null;
  lastSuccessAt?: Date | null;
  lastItemAt?: Date | null;
  consecutiveFailures?: number;
  disabledUntil?: Date | null;
  state?: Record<string, unknown> | null;
}

export interface BaseSourceOptions {
  name: string;
  /** Token bucket sizing for outbound calls made by this source. */
  rateCapacity?: number;
  rateRefillPerSecond?: number;
  breaker?: CircuitBreakerOptions;
  /** Cooldown applied once consecutive failures reach failuresBeforeCooldown. */
  cooldownBaseMs?: number;
  cooldownMaxMs?: number;
  failuresBeforeCooldown?: number;
}

function emptyCheckpoint(source: string, profileId: string | null): SourceCheckpointView {
  return {
    id: null,
    source,
    profileId,
    cursor: null,
    lastRunAt: null,
    lastSuccessAt: null,
    lastItemAt: null,
    consecutiveFailures: 0,
    disabledUntil: null,
    state: {},
  };
}

function toStateRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

// Prisma's Json input type rejects `unknown`; the round-trip both narrows the
// value and drops anything non-serialisable before it reaches the driver.
function toJsonInput(value: Record<string, unknown>): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export function newestPostedAt(jobs: RawJob[]): Date | null {
  let newest: Date | null = null;
  for (const job of jobs) {
    if (job.postedAt === null) continue;
    if (newest === null || job.postedAt.getTime() > newest.getTime()) newest = job.postedAt;
  }
  return newest;
}

export abstract class BaseSource implements JobSource {
  readonly name: string;

  protected readonly log: Logger;
  protected readonly limiter: RateLimiter;
  protected readonly breaker: CircuitBreaker;

  private readonly cooldownBaseMs: number;
  private readonly cooldownMaxMs: number;
  private readonly failuresBeforeCooldown: number;

  constructor(options: BaseSourceOptions) {
    this.name = options.name;
    this.log = child(`source:${options.name}`);
    this.limiter = new RateLimiter(options.rateCapacity ?? 10, options.rateRefillPerSecond ?? 5);
    this.breaker = new CircuitBreaker({
      name: `source:${options.name}`,
      failureThreshold: 5,
      cooldownMs: 60_000,
      ...options.breaker,
    });
    this.cooldownBaseMs = options.cooldownBaseMs ?? 60_000;
    this.cooldownMaxMs = options.cooldownMaxMs ?? 60 * 60_000;
    this.failuresBeforeCooldown = options.failuresBeforeCooldown ?? 3;
  }

  abstract isEnabled(): boolean;

  /** Subclass implementation. May throw - safeFetch contains the damage. */
  protected abstract run(ctx: SourceContext): Promise<SourceResult>;

  /** JobSource entry point. Never throws; failures come back as empty results. */
  async fetch(ctx: SourceContext): Promise<SourceResult> {
    return this.safeFetch(ctx);
  }

  /**
   * Guarded fetch: honours the cooldown recorded on the checkpoint, runs the
   * source behind the rate limiter and circuit breaker, and persists success or
   * failure on the way out. Returns an empty SourceResult instead of throwing.
   */
  async safeFetch(ctx: SourceContext): Promise<SourceResult> {
    const startedAt = Date.now();

    if (!this.isEnabled()) {
      return { jobs: [], cursor: ctx.cursor, meta: { skipped: 'disabled', source: this.name } };
    }

    const checkpoint = await this.loadCheckpoint(ctx.profileId);

    if (checkpoint.disabledUntil && checkpoint.disabledUntil.getTime() > Date.now()) {
      this.log.debug(
        { profileId: ctx.profileId, until: toIso(checkpoint.disabledUntil) },
        'source is cooling down after repeated failures',
      );
      return {
        jobs: [],
        cursor: checkpoint.cursor,
        meta: {
          skipped: 'cooldown',
          source: this.name,
          disabledUntil: toIso(checkpoint.disabledUntil),
          consecutiveFailures: checkpoint.consecutiveFailures,
        },
      };
    }

    if (!this.breaker.canRequest()) {
      return {
        jobs: [],
        cursor: checkpoint.cursor,
        meta: {
          skipped: 'circuit_open',
          source: this.name,
          retryAfterMs: this.breaker.retryAfterMs(),
        },
      };
    }

    const effectiveCtx = this.buildContext(ctx, checkpoint);
    await this.saveCheckpoint(ctx.profileId, { lastRunAt: new Date() });

    try {
      await this.limiter.take();
      const result = await this.run(effectiveCtx);
      this.breaker.recordSuccess();

      const ms = Date.now() - startedAt;
      await this.recordSuccess(ctx.profileId, result);

      this.log.debug(
        { profileId: ctx.profileId, count: result.jobs.length, ms },
        'source fetch completed',
      );

      return {
        jobs: result.jobs,
        cursor: result.cursor,
        meta: { ...(result.meta ?? {}), source: this.name, ms, count: result.jobs.length },
      };
    } catch (err) {
      this.breaker.recordFailure();
      const ms = Date.now() - startedAt;
      const message = toErrorMessage(err);

      this.log.error({ err, profileId: ctx.profileId, ms }, 'source fetch failed');
      const failures = await this.recordFailure(ctx.profileId, message);

      return {
        jobs: [],
        cursor: checkpoint.cursor,
        meta: {
          source: this.name,
          ms,
          error: message,
          consecutiveFailures: failures,
        },
      };
    }
  }

  /** Same guards as safeFetch but propagates the error. Useful in tests. */
  async fetchOrThrow(ctx: SourceContext): Promise<SourceResult> {
    await this.limiter.take();
    return this.run(ctx);
  }

  /** Merges checkpoint state into the caller's context (cursor, since floor). */
  protected buildContext(ctx: SourceContext, checkpoint: SourceCheckpointView): SourceContext {
    const cursor = ctx.cursor ?? checkpoint.cursor;
    const checkpointSince = checkpoint.lastItemAt;
    const since =
      ctx.since && checkpointSince
        ? new Date(Math.max(ctx.since.getTime(), checkpointSince.getTime()))
        : (ctx.since ?? checkpointSince);

    return {
      ...ctx,
      cursor,
      since,
      limit: Math.max(1, Math.min(ctx.limit || env.MAX_JOBS_PER_POLL, 1000)),
    };
  }

  /* ------------------------------------------------------------ checkpoints */

  async loadCheckpoint(profileId: string | null): Promise<SourceCheckpointView> {
    try {
      const row = await prisma.sourceCheckpoint.findFirst({
        where: { source: this.name, profileId },
      });
      if (!row) return emptyCheckpoint(this.name, profileId);
      return {
        id: row.id,
        source: row.source,
        profileId: row.profileId,
        cursor: row.cursor,
        lastRunAt: row.lastRunAt,
        lastSuccessAt: row.lastSuccessAt,
        lastItemAt: row.lastItemAt,
        consecutiveFailures: row.consecutiveFailures,
        disabledUntil: row.disabledUntil,
        state: toStateRecord(row.state),
      };
    } catch (err) {
      // A checkpoint read failure must not stop detection; run without history.
      this.log.warn({ err, profileId }, 'failed to load source checkpoint');
      return emptyCheckpoint(this.name, profileId);
    }
  }

  /** Idempotent upsert of the checkpoint row. Swallows DB errors by design. */
  async saveCheckpoint(profileId: string | null, patch: CheckpointPatch): Promise<void> {
    const data: Prisma.SourceCheckpointUncheckedUpdateInput = {};
    if (patch.cursor !== undefined) data.cursor = patch.cursor;
    if (patch.lastRunAt !== undefined) data.lastRunAt = patch.lastRunAt;
    if (patch.lastSuccessAt !== undefined) data.lastSuccessAt = patch.lastSuccessAt;
    if (patch.lastItemAt !== undefined) data.lastItemAt = patch.lastItemAt;
    if (patch.consecutiveFailures !== undefined) data.consecutiveFailures = patch.consecutiveFailures;
    if (patch.disabledUntil !== undefined) data.disabledUntil = patch.disabledUntil;
    if (patch.state !== undefined && patch.state !== null) data.state = toJsonInput(patch.state);

    if (Object.keys(data).length === 0) return;

    try {
      const existing = await prisma.sourceCheckpoint.findFirst({
        where: { source: this.name, profileId },
        select: { id: true },
      });

      if (existing) {
        await prisma.sourceCheckpoint.update({ where: { id: existing.id }, data });
        return;
      }

      await prisma.sourceCheckpoint.create({
        data: {
          source: this.name,
          profileId,
          cursor: patch.cursor ?? null,
          lastRunAt: patch.lastRunAt ?? null,
          lastSuccessAt: patch.lastSuccessAt ?? null,
          lastItemAt: patch.lastItemAt ?? null,
          consecutiveFailures: patch.consecutiveFailures ?? 0,
          disabledUntil: patch.disabledUntil ?? null,
          ...(patch.state ? { state: toJsonInput(patch.state) } : {}),
        },
      });
    } catch (err) {
      // Two workers can race the create; the loser just updates the winner's row.
      try {
        const existing = await prisma.sourceCheckpoint.findFirst({
          where: { source: this.name, profileId },
          select: { id: true },
        });
        if (existing) {
          await prisma.sourceCheckpoint.update({ where: { id: existing.id }, data });
          return;
        }
      } catch (retryErr) {
        this.log.warn({ err: retryErr, profileId }, 'checkpoint retry write failed');
      }
      this.log.warn({ err, profileId }, 'failed to save source checkpoint');
    }
  }

  protected async recordSuccess(profileId: string | null, result: SourceResult): Promise<void> {
    const now = new Date();
    const newest = newestPostedAt(result.jobs);
    await this.saveCheckpoint(profileId, {
      cursor: result.cursor,
      lastRunAt: now,
      lastSuccessAt: now,
      consecutiveFailures: 0,
      disabledUntil: null,
      ...(newest ? { lastItemAt: newest } : {}),
    });
  }

  /** Bumps the failure counter and applies the exponential cooldown. */
  protected async recordFailure(profileId: string | null, message: string): Promise<number> {
    const checkpoint = await this.loadCheckpoint(profileId);
    const failures = checkpoint.consecutiveFailures + 1;
    const cooldownMs = this.cooldownFor(failures);

    await this.saveCheckpoint(profileId, {
      lastRunAt: new Date(),
      consecutiveFailures: failures,
      disabledUntil: cooldownMs > 0 ? new Date(Date.now() + cooldownMs) : null,
      state: {
        ...checkpoint.state,
        lastError: message.slice(0, 500),
        lastErrorAt: new Date().toISOString(),
      },
    });

    if (cooldownMs > 0) {
      this.log.warn(
        { profileId, failures, cooldownMs },
        'source paused after consecutive failures',
      );
    }

    return failures;
  }

  /** 0 until failuresBeforeCooldown, then base * 2^n capped at cooldownMaxMs. */
  cooldownFor(failures: number): number {
    if (failures < this.failuresBeforeCooldown) return 0;
    const exponent = failures - this.failuresBeforeCooldown;
    const raw = this.cooldownBaseMs * 2 ** Math.min(exponent, 16);
    return Math.min(this.cooldownMaxMs, raw);
  }

  snapshot(): {
    name: string;
    enabled: boolean;
    breaker: ReturnType<CircuitBreaker['snapshot']>;
    tokensAvailable: number;
  } {
    return {
      name: this.name,
      enabled: this.isEnabled(),
      breaker: this.breaker.snapshot(),
      tokensAvailable: this.limiter.available,
    };
  }
}

export type { JobSource, SourceContext, SourceResult };
