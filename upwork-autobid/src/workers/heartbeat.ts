/**
 * Liveness beats.
 *
 * Each long-running component ("api", "worker", "scheduler") refreshes a row in
 * the Heartbeat table on a timer. The API's /health endpoint reads them back
 * through isHealthy(), which is what turns "the container is up" into "the
 * pipeline is actually running" for the platform's health check.
 */

import { Prisma } from '@prisma/client';
import { child } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { secondsSince, toIso } from '../lib/time';
import type { HealthReport } from '../types';

const log = child('heartbeat');

export const HEARTBEAT_COMPONENTS = ['api', 'worker', 'scheduler'] as const;
export type HeartbeatComponent = (typeof HEARTBEAT_COMPONENTS)[number];

/** Beat interval. Half the default staleness window, so one missed beat is survivable. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/** A component silent for longer than this is considered down. */
export const DEFAULT_MAX_AGE_SECONDS = 120;

export type HeartbeatStatus = 'OK' | 'DEGRADED' | 'STOPPED';

export interface BeatOptions {
  status?: HeartbeatStatus;
  detail?: string | null;
  meta?: Record<string, unknown>;
}

function toMeta(meta: Record<string, unknown> | undefined): Prisma.InputJsonValue | undefined {
  if (!meta) return undefined;
  try {
    return JSON.parse(JSON.stringify(meta)) as Prisma.InputJsonValue;
  } catch {
    return undefined;
  }
}

/**
 * Writes or refreshes one component's heartbeat. Returns false instead of
 * throwing: a database blip must not take down the process that is beating.
 */
export async function beat(component: string, options: BeatOptions = {}): Promise<boolean> {
  const lastBeatAt = new Date();
  const status = options.status ?? 'OK';
  const detail = options.detail ?? null;
  const meta = toMeta(options.meta);

  try {
    await prisma.heartbeat.upsert({
      where: { component },
      create: {
        component,
        lastBeatAt,
        status,
        detail,
        ...(meta === undefined ? {} : { meta }),
      },
      update: {
        lastBeatAt,
        status,
        detail,
        ...(meta === undefined ? {} : { meta }),
      },
    });
    return true;
  } catch (err) {
    log.warn({ err, component }, 'failed to write heartbeat');
    return false;
  }
}

/**
 * True when the component beat recently enough. A missing row, a stale row or a
 * database error all read as unhealthy - fail closed, never claim health we
 * cannot prove.
 */
export async function isHealthy(
  component: string,
  maxAgeSec: number = DEFAULT_MAX_AGE_SECONDS,
): Promise<boolean> {
  try {
    const row = await prisma.heartbeat.findUnique({
      where: { component },
      select: { lastBeatAt: true, status: true },
    });
    if (!row) return false;
    if (row.status === 'STOPPED') return false;
    return secondsSince(row.lastBeatAt) <= Math.max(1, maxAgeSec);
  } catch (err) {
    log.warn({ err, component }, 'failed to read heartbeat');
    return false;
  }
}

/** Every recorded heartbeat, shaped for HealthReport.components. */
export async function readHeartbeats(): Promise<HealthReport['components']> {
  try {
    const rows = await prisma.heartbeat.findMany({ orderBy: { component: 'asc' } });
    return rows.map((row) => ({
      component: row.component,
      lastBeatAt: toIso(row.lastBeatAt) ?? '',
      status: row.status,
      detail: row.detail,
    }));
  } catch (err) {
    log.warn({ err }, 'failed to list heartbeats');
    return [];
  }
}

export interface HeartbeatSnapshot {
  component: string;
  lastBeatAt: string | null;
  ageSeconds: number | null;
  status: string;
  detail: string | null;
  healthy: boolean;
}

/** Snapshot of the three known components, including ones that never beat. */
export async function heartbeatSnapshot(
  maxAgeSec: number = DEFAULT_MAX_AGE_SECONDS,
): Promise<HeartbeatSnapshot[]> {
  let rows: { component: string; lastBeatAt: Date; status: string; detail: string | null }[] = [];
  try {
    rows = await prisma.heartbeat.findMany({
      select: { component: true, lastBeatAt: true, status: true, detail: true },
    });
  } catch (err) {
    log.warn({ err }, 'failed to snapshot heartbeats');
  }

  const byComponent = new Map(rows.map((row) => [row.component, row]));
  const names = new Set<string>([...HEARTBEAT_COMPONENTS, ...byComponent.keys()]);

  return Array.from(names)
    .sort()
    .map((component) => {
      const row = byComponent.get(component);
      if (!row) {
        return {
          component,
          lastBeatAt: null,
          ageSeconds: null,
          status: 'UNKNOWN',
          detail: null,
          healthy: false,
        };
      }
      const ageSeconds = Math.round(secondsSince(row.lastBeatAt));
      return {
        component,
        lastBeatAt: toIso(row.lastBeatAt),
        ageSeconds,
        status: row.status,
        detail: row.detail,
        healthy: row.status !== 'STOPPED' && ageSeconds <= Math.max(1, maxAgeSec),
      };
    });
}

/* ------------------------------------------------------------- beat loop */

export interface HeartbeatHandle {
  readonly component: string;
  /** Stops the timer and records a final STOPPED beat. */
  stop(detail?: string): Promise<void>;
}

export interface StartHeartbeatOptions {
  intervalMs?: number;
  /** Called on every beat to attach live numbers (queue depth, uptime, ...). */
  meta?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
}

/**
 * Beats immediately and then on a timer. The timer is unref'd so it can never
 * be the reason the process refuses to exit.
 */
export function startHeartbeat(
  component: string,
  options: StartHeartbeatOptions = {},
): HeartbeatHandle {
  const intervalMs = Math.max(1000, options.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    let meta: Record<string, unknown> | undefined;
    if (options.meta) {
      try {
        meta = await options.meta();
      } catch (err) {
        log.debug({ err, component }, 'heartbeat meta collector failed');
      }
    }
    await beat(component, meta === undefined ? {} : { meta });
  };

  void tick();

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref();

  log.debug({ component, intervalMs }, 'heartbeat started');

  return {
    component,
    async stop(detail?: string): Promise<void> {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await beat(component, {
        status: 'STOPPED',
        detail: detail ?? 'graceful shutdown',
      });
      log.debug({ component }, 'heartbeat stopped');
    },
  };
}
