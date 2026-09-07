/**
 * Repeatable job registration.
 *
 * BullMQ derives a repeatable's key from its name, id and cadence, so changing
 * POLL_INTERVAL_SECONDS creates a second repeatable rather than editing the
 * first one. registerSchedules() therefore adds the current set (adding an
 * identical repeatable twice is a no-op) and then deletes every repeatable it
 * manages whose key is not in that set. Restarts converge; they never duplicate.
 */

import type { JobsOptions, Queue } from 'bullmq';
import { env } from '../config/env';
import { child } from '../lib/logger';
import { intervalMs } from '../lib/time';
import {
  QUEUE_NAMES,
  PRIORITY,
  type DigestJobData,
  type DiscoverJobData,
  type MaintenanceJobData,
  type QueueName,
  discoverQueue,
  maintenanceQueue,
  notifyDigestQueue,
} from './queues';

const log = child('queue:scheduler');

/**
 * Repeatable job names. Deliberately colon-free: newer BullMQ derives a job
 * scheduler id from the name and rejects ':' in it.
 */
export const SCHEDULE_NAMES = {
  discoverStandard: 'discover-standard',
  discoverFast: 'discover-fast',
  maintenanceSweep: 'maintenance-sweep',
  maintenanceHeartbeat: 'maintenance-heartbeat',
  digestDaily: 'digest-daily',
} as const;

export type ScheduleName = (typeof SCHEDULE_NAMES)[keyof typeof SCHEDULE_NAMES];

/**
 * Every repeatable name this module has ever owned, per queue. Cleanup only
 * touches these, so a repeatable added by hand or by another component is left
 * alone.
 */
const MANAGED_NAMES: Record<string, readonly string[]> = {
  [QUEUE_NAMES.discover]: [SCHEDULE_NAMES.discoverStandard, SCHEDULE_NAMES.discoverFast],
  [QUEUE_NAMES.maintenance]: [
    SCHEDULE_NAMES.maintenanceSweep,
    SCHEDULE_NAMES.maintenanceHeartbeat,
  ],
  [QUEUE_NAMES.notifyDigest]: [SCHEDULE_NAMES.digestDaily],
};

/** Profiles this fresh must be polled on the fast lane. Mirrors discover.ts. */
export const FAST_LANE_MAX_JOB_AGE_MINUTES = 30;

export const MAINTENANCE_INTERVAL_MS = 15 * 60_000;
export const HEARTBEAT_INTERVAL_MS = 60_000;
export const DIGEST_CRON = '0 8 * * *';
export const DIGEST_TZ = 'UTC';

export interface RepeatSpec {
  every?: number;
  pattern?: string;
  tz?: string;
}

export interface ScheduleDefinition {
  queue: QueueName;
  name: ScheduleName;
  /** Repeat id; part of the BullMQ repeat key. */
  jobId: string;
  repeat: RepeatSpec;
  description: string;
  register(): Promise<void>;
}

/**
 * Structural view of a BullMQ repeatable descriptor. Declared locally so a
 * minor-version change to the library's exported shape cannot break the build.
 */
interface RepeatableView {
  key: string;
  name: string;
  id?: string | null;
  tz?: string | null;
  pattern?: string | null;
  every?: string | number | null;
  next?: number;
}

function repeatables(queue: Queue): Promise<RepeatableView[]> {
  return queue.getRepeatableJobs() as unknown as Promise<RepeatableView[]>;
}

/* ------------------------------------------------------------- definitions */

export function buildSchedules(): ScheduleDefinition[] {
  const definitions: ScheduleDefinition[] = [];

  const standardRepeat: RepeatSpec = { every: intervalMs(env.POLL_INTERVAL_SECONDS) };
  definitions.push({
    queue: QUEUE_NAMES.discover,
    name: SCHEDULE_NAMES.discoverStandard,
    jobId: 'standard',
    repeat: standardRepeat,
    description: `detect new postings for every active profile every ${env.POLL_INTERVAL_SECONDS}s`,
    async register(): Promise<void> {
      const data: DiscoverJobData = { lane: 'standard', reason: 'schedule' };
      await addRepeatable(
        discoverQueue(),
        SCHEDULE_NAMES.discoverStandard,
        data,
        'standard',
        standardRepeat,
      );
    },
  });

  // The fast lane only earns its keep when it is actually faster than the
  // standard one; otherwise it would just double every poll.
  const fastRepeat: RepeatSpec = { every: intervalMs(env.FAST_POLL_INTERVAL_SECONDS) };
  if ((fastRepeat.every ?? 0) < (standardRepeat.every ?? 0)) {
    definitions.push({
      queue: QUEUE_NAMES.discover,
      name: SCHEDULE_NAMES.discoverFast,
      jobId: 'fast',
      repeat: fastRepeat,
      description:
        `re-poll profiles with maxJobAgeMinutes <= ${FAST_LANE_MAX_JOB_AGE_MINUTES} ` +
        `every ${env.FAST_POLL_INTERVAL_SECONDS}s`,
      async register(): Promise<void> {
        const data: DiscoverJobData = { lane: 'fast', reason: 'schedule' };
        await addRepeatable(
          discoverQueue(),
          SCHEDULE_NAMES.discoverFast,
          data,
          'fast',
          fastRepeat,
        );
      },
    });
  }

  const sweepRepeat: RepeatSpec = { every: MAINTENANCE_INTERVAL_MS };
  definitions.push({
    queue: QUEUE_NAMES.maintenance,
    name: SCHEDULE_NAMES.maintenanceSweep,
    jobId: 'sweep',
    repeat: sweepRepeat,
    description: 'expire stale rows, prune logs and reconcile quotas every 15 minutes',
    async register(): Promise<void> {
      const data: MaintenanceJobData = { task: 'sweep', reason: 'schedule' };
      await addRepeatable(
        maintenanceQueue(),
        SCHEDULE_NAMES.maintenanceSweep,
        data,
        'sweep',
        sweepRepeat,
      );
    },
  });

  const heartbeatRepeat: RepeatSpec = { every: HEARTBEAT_INTERVAL_MS };
  definitions.push({
    queue: QUEUE_NAMES.maintenance,
    name: SCHEDULE_NAMES.maintenanceHeartbeat,
    jobId: 'heartbeat',
    repeat: heartbeatRepeat,
    description: 'prove the repeatable scheduler is still delivering, every 60s',
    async register(): Promise<void> {
      const data: MaintenanceJobData = { task: 'heartbeat', reason: 'schedule' };
      await addRepeatable(
        maintenanceQueue(),
        SCHEDULE_NAMES.maintenanceHeartbeat,
        data,
        'heartbeat',
        heartbeatRepeat,
        // A heartbeat backlog is worthless: keep the tail short and never retry.
        { attempts: 1, removeOnComplete: { count: 20 }, removeOnFail: { count: 50 } },
      );
    },
  });

  const digestRepeat: RepeatSpec = { pattern: DIGEST_CRON, tz: DIGEST_TZ };
  definitions.push({
    queue: QUEUE_NAMES.notifyDigest,
    name: SCHEDULE_NAMES.digestDaily,
    jobId: 'daily',
    repeat: digestRepeat,
    description: 'daily pipeline digest at 08:00 UTC',
    async register(): Promise<void> {
      const data: DigestJobData = { reason: 'schedule' };
      await addRepeatable(
        notifyDigestQueue(),
        SCHEDULE_NAMES.digestDaily,
        data,
        'daily',
        digestRepeat,
      );
    },
  });

  return definitions;
}

// BullMQ resolves a queue's job-name type from its data type, which stays
// deferred behind an unresolved generic. Only `add` is needed here, so accept
// the structural shape instead of threading six type parameters through.
type AddableQueue<T> = {
  add(name: string, data: T, opts?: JobsOptions): Promise<unknown>;
};

async function addRepeatable<T>(
  queue: AddableQueue<T>,
  name: string,
  data: T,
  jobId: string,
  repeat: RepeatSpec,
  extra: JobsOptions = {},
): Promise<void> {
  const options: JobsOptions = {
    jobId,
    repeat,
    priority: PRIORITY.normal,
    removeOnComplete: { age: 3600, count: 100 },
    removeOnFail: { age: 86400, count: 200 },
    ...extra,
  };
  await queue.add(name, data, options);
}

/* ---------------------------------------------------------------- matching */

function sameRepeat(existing: RepeatableView, definition: ScheduleDefinition): boolean {
  if (existing.name !== definition.name) return false;
  // BullMQ does not echo the caller's jobId back from getRepeatableJobs(), so an
  // absent id means "unknown", not "different". Only a populated, mismatched id
  // marks a repeatable as superseded. Comparing it strictly made every schedule
  // look stale the instant it was added, which silently stopped all detection.
  if (existing.id && existing.id !== definition.jobId) return false;

  const { every, pattern, tz } = definition.repeat;

  if (every !== undefined) {
    if (existing.every === null || existing.every === undefined) return false;
    return String(existing.every) === String(every);
  }

  if (pattern !== undefined) {
    if ((existing.pattern ?? '') !== pattern) return false;
    return (existing.tz ?? '') === (tz ?? '');
  }

  return false;
}

/* ----------------------------------------------------------------- syncing */

export interface ScheduleSyncResult {
  registered: string[];
  removed: string[];
  errors: string[];
}

/**
 * Idempotently installs the current schedule set and drops superseded ones.
 * Safe to call on every boot and from more than one process at a time.
 */
export async function registerSchedules(): Promise<ScheduleSyncResult> {
  const definitions = buildSchedules();
  const result: ScheduleSyncResult = { registered: [], removed: [], errors: [] };

  // Prune BEFORE registering. Doing it the other way round means a stale-match
  // false positive deletes the schedule that was just installed.
  const removed = await pruneStaleSchedules(definitions);
  result.removed.push(...removed);

  for (const definition of definitions) {
    try {
      await definition.register();
      result.registered.push(definition.name);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err, schedule: definition.name }, 'failed to register repeatable job');
      result.errors.push(`${definition.name}: ${message}`);
    }
  }

  log.info(
    {
      registered: result.registered,
      removed: result.removed,
      errors: result.errors,
      pollIntervalSeconds: env.POLL_INTERVAL_SECONDS,
      fastPollIntervalSeconds: env.FAST_POLL_INTERVAL_SECONDS,
    },
    'repeatable schedules synchronised',
  );

  return result;
}

/** Removes managed repeatables whose cadence no longer matches the config. */
export async function pruneStaleSchedules(
  definitions: ScheduleDefinition[] = buildSchedules(),
): Promise<string[]> {
  const removed: string[] = [];
  const queuesToCheck: { name: QueueName; queue: Queue }[] = [
    { name: QUEUE_NAMES.discover, queue: discoverQueue() as unknown as Queue },
    { name: QUEUE_NAMES.maintenance, queue: maintenanceQueue() as unknown as Queue },
    { name: QUEUE_NAMES.notifyDigest, queue: notifyDigestQueue() as unknown as Queue },
  ];

  for (const entry of queuesToCheck) {
    const managed = MANAGED_NAMES[entry.name] ?? [];
    if (managed.length === 0) continue;

    let existing: RepeatableView[];
    try {
      existing = await repeatables(entry.queue);
    } catch (err) {
      log.warn({ err, queue: entry.name }, 'could not list repeatable jobs');
      continue;
    }

    const wanted = definitions.filter((definition) => definition.queue === entry.name);

    for (const candidate of existing) {
      if (!managed.includes(candidate.name)) continue;
      if (wanted.some((definition) => sameRepeat(candidate, definition))) continue;

      try {
        await entry.queue.removeRepeatableByKey(candidate.key);
        removed.push(candidate.key);
        log.info(
          { queue: entry.name, key: candidate.key, name: candidate.name },
          'removed superseded repeatable job',
        );
      } catch (err) {
        log.warn({ err, queue: entry.name, key: candidate.key }, 'failed to remove repeatable job');
      }
    }
  }

  return removed;
}

export interface ScheduleDescription {
  queue: string;
  name: string;
  key: string;
  id: string | null;
  every: number | null;
  pattern: string | null;
  tz: string | null;
  nextRunAt: string | null;
}

/** Current repeatables as Redis knows them, for /health and the dashboard. */
export async function describeSchedules(): Promise<ScheduleDescription[]> {
  const out: ScheduleDescription[] = [];
  const queuesToCheck: { name: QueueName; queue: Queue }[] = [
    { name: QUEUE_NAMES.discover, queue: discoverQueue() as unknown as Queue },
    { name: QUEUE_NAMES.maintenance, queue: maintenanceQueue() as unknown as Queue },
    { name: QUEUE_NAMES.notifyDigest, queue: notifyDigestQueue() as unknown as Queue },
  ];

  for (const entry of queuesToCheck) {
    try {
      const existing = await repeatables(entry.queue);
      for (const candidate of existing) {
        const every =
          candidate.every === null || candidate.every === undefined
            ? null
            : Number(candidate.every);
        out.push({
          queue: entry.name,
          name: candidate.name,
          key: candidate.key,
          id: candidate.id ?? null,
          every: every !== null && Number.isFinite(every) ? every : null,
          pattern: candidate.pattern ?? null,
          tz: candidate.tz ?? null,
          nextRunAt: candidate.next ? new Date(candidate.next).toISOString() : null,
        });
      }
    } catch (err) {
      log.warn({ err, queue: entry.name }, 'could not describe repeatable jobs');
    }
  }

  return out;
}

/** Drops every managed repeatable. Used by tooling, not by the runtime. */
export async function removeAllSchedules(): Promise<number> {
  const removed = await pruneStaleSchedules([]);
  return removed.length;
}
