/**
 * BullMQ queue definitions for the non-stop pipeline.
 *
 * Queues are created lazily and cached per process so importing this module
 * from the API, the workers or a test does not open Redis sockets until an
 * enqueue actually happens. Every producer goes through the typed add* helpers
 * below, which own the deduplication ids that keep the pipeline idempotent.
 */

import { Queue, QueueEvents, type JobsOptions } from 'bullmq';
import { sha256Short } from '../lib/hash';
import { child } from '../lib/logger';
import { redisConnectionOptions } from '../lib/redis';
import type {
  DraftJobData,
  NotifyJobData,
  PollJobData,
  ScoreJobData,
  SubmitJobData,
} from '../types';

const log = child('queue');

export const QUEUE_NAMES = {
  discover: 'discover',
  score: 'score',
  draft: 'draft',
  submit: 'submit',
  maintenance: 'maintenance',
  notifyDigest: 'notify-digest',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const ALL_QUEUE_NAMES: readonly QueueName[] = [
  QUEUE_NAMES.discover,
  QUEUE_NAMES.score,
  QUEUE_NAMES.draft,
  QUEUE_NAMES.submit,
  QUEUE_NAMES.maintenance,
  QUEUE_NAMES.notifyDigest,
] as const;

/**
 * Shared retry/retention policy. Completed jobs survive a day (enough to debug
 * a bad night) and failures a week, which is what the audit trail leans on.
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { age: 86400, count: 1000 },
  removeOnFail: { age: 604800 },
};

/** Lower numbers run first in BullMQ. */
export const PRIORITY = {
  hot: 1,
  normal: 5,
  low: 10,
} as const;

/* ------------------------------------------------------------- job payloads */

export type DiscoverLane = 'standard' | 'fast';

/**
 * A scheduled tick sweeps every eligible profile, so profileId is optional here
 * even though the shared PollJobData contract requires it for a targeted poll.
 */
export interface DiscoverJobData extends Partial<PollJobData> {
  lane: DiscoverLane;
}

export type MaintenanceTask = 'sweep' | 'heartbeat';

export interface MaintenanceJobData {
  task: MaintenanceTask;
  reason?: string;
}

export interface DigestJobData {
  reason?: string;
}

/* ---------------------------------------------------------------- registry */

const queueRegistry = new Map<QueueName, Queue>();
const queueEventsRegistry = new Map<QueueName, QueueEvents>();

// The registry is heterogeneous by design; each accessor re-applies the payload
// type it owns. The cast is confined to this one function.
function queueFor<T>(name: QueueName): Queue<T> {
  const cached = queueRegistry.get(name);
  if (cached) return cached as unknown as Queue<T>;

  const created = new Queue<T>(name, {
    connection: redisConnectionOptions,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });

  // BullMQ re-emits ioredis errors; without a listener Node would crash the
  // process on a transient connection blip.
  created.on('error', (err: Error) => log.error({ err, queue: name }, 'queue error'));

  queueRegistry.set(name, created as unknown as Queue);
  return created;
}

export function discoverQueue(): Queue<DiscoverJobData> {
  return queueFor<DiscoverJobData>(QUEUE_NAMES.discover);
}

export function scoreQueue(): Queue<ScoreJobData> {
  return queueFor<ScoreJobData>(QUEUE_NAMES.score);
}

export function draftQueue(): Queue<DraftJobData> {
  return queueFor<DraftJobData>(QUEUE_NAMES.draft);
}

export function submitQueue(): Queue<SubmitJobData> {
  return queueFor<SubmitJobData>(QUEUE_NAMES.submit);
}

export function maintenanceQueue(): Queue<MaintenanceJobData> {
  return queueFor<MaintenanceJobData>(QUEUE_NAMES.maintenance);
}

export function notifyDigestQueue(): Queue<DigestJobData | NotifyJobData> {
  return queueFor<DigestJobData | NotifyJobData>(QUEUE_NAMES.notifyDigest);
}

/** Every queue that has been touched in this process. */
export function activeQueues(): Queue[] {
  return Array.from(queueRegistry.values());
}

/* ------------------------------------------------------------ queue events */

export function getQueueEvents(name: QueueName): QueueEvents {
  const cached = queueEventsRegistry.get(name);
  if (cached) return cached;

  const events = new QueueEvents(name, { connection: redisConnectionOptions });
  events.on('error', (err: Error) => log.error({ err, queue: name }, 'queue events error'));
  queueEventsRegistry.set(name, events);
  return events;
}

/**
 * Subscribes to completion/failure streams for every queue and logs them.
 * Returns the instances so the caller can close them on shutdown.
 */
export function startQueueEventLogging(): QueueEvents[] {
  return ALL_QUEUE_NAMES.map((name) => {
    const events = getQueueEvents(name);
    events.on('failed', ({ jobId, failedReason }) => {
      log.warn({ queue: name, jobId, failedReason }, 'queue event: job failed');
    });
    events.on('stalled', ({ jobId }) => {
      log.warn({ queue: name, jobId }, 'queue event: job stalled');
    });
    events.on('completed', ({ jobId }) => {
      log.debug({ queue: name, jobId }, 'queue event: job completed');
    });
    return events;
  });
}

/* ------------------------------------------------------------ add* helpers */

export interface EnqueueOptions {
  priority?: number;
  delayMs?: number;
  /** Overrides the deduplication id. Pass null to let BullMQ generate one. */
  jobId?: string | null;
  attempts?: number;
}

function toJobOptions(options: EnqueueOptions, defaultJobId: string): JobsOptions {
  const jobId = options.jobId === null ? undefined : (options.jobId ?? defaultJobId);
  const opts: JobsOptions = {};
  if (jobId !== undefined) opts.jobId = jobId;
  if (options.priority !== undefined) opts.priority = options.priority;
  if (options.delayMs !== undefined) opts.delay = Math.max(0, Math.floor(options.delayMs));
  if (options.attempts !== undefined) opts.attempts = options.attempts;
  return opts;
}

/** Queues one discovery sweep. `lane` selects the standard or fast poll cadence. */
export async function addDiscoverJob(
  data: DiscoverJobData,
  options: EnqueueOptions = {},
): Promise<string | null> {
  const suffix = data.profileId ?? 'all';
  // Ad-hoc sweeps are never de-duplicated: "poll now" must always poll now.
  const defaultId = `discover:${data.lane}:${suffix}:${Date.now()}`;
  const job = await discoverQueue().add(
    `discover-${data.lane}`,
    data,
    toJobOptions(options, defaultId),
  );
  return job.id ?? null;
}

export interface ScoreEnqueueOptions extends EnqueueOptions {
  /** Part of the dedupe id so an edited posting is re-scored, not swallowed. */
  contentHash?: string;
}

export async function addScoreJob(
  data: ScoreJobData,
  options: ScoreEnqueueOptions = {},
): Promise<string | null> {
  const fingerprint = options.contentHash ? sha256Short(options.contentHash, 16) : 'nohash';
  const defaultId = `score:${data.jobId}:${data.profileId}:${fingerprint}`;
  const job = await scoreQueue().add('score', data, toJobOptions(options, defaultId));
  return job.id ?? null;
}

export async function addDraftJob(
  data: DraftJobData,
  options: EnqueueOptions = {},
): Promise<string | null> {
  const defaultId = `draft:${data.jobId}:${data.profileId}`;
  const job = await draftQueue().add('draft', data, toJobOptions(options, defaultId));
  return job.id ?? null;
}

export async function addSubmitJob(
  data: SubmitJobData,
  options: EnqueueOptions = {},
): Promise<string | null> {
  const defaultId = `submit:${data.proposalId}`;
  const job = await submitQueue().add('submit', data, toJobOptions(options, defaultId));
  return job.id ?? null;
}

export async function addMaintenanceJob(
  data: MaintenanceJobData,
  options: EnqueueOptions = {},
): Promise<string | null> {
  const defaultId = `maintenance:${data.task}:${Date.now()}`;
  const job = await maintenanceQueue().add(data.task, data, toJobOptions(options, defaultId));
  return job.id ?? null;
}

export async function addDigestJob(
  data: DigestJobData = {},
  options: EnqueueOptions = {},
): Promise<string | null> {
  const defaultId = `digest:${Date.now()}`;
  const job = await notifyDigestQueue().add('digest', data, toJobOptions(options, defaultId));
  return job.id ?? null;
}

/* --------------------------------------------------------------- inspection */

export type QueueCounts = Record<string, number>;

/** Job counts per queue for /health and the dashboard. Never throws. */
export async function queueCounts(): Promise<Record<string, QueueCounts>> {
  const entries = await Promise.all(
    ALL_QUEUE_NAMES.map(async (name): Promise<[string, QueueCounts]> => {
      try {
        const counts = await queueFor<unknown>(name).getJobCounts(
          'waiting',
          'active',
          'delayed',
          'completed',
          'failed',
          'paused',
        );
        return [name, counts];
      } catch (err) {
        log.warn({ err, queue: name }, 'failed to read queue counts');
        return [name, {}];
      }
    }),
  );
  return Object.fromEntries(entries);
}

/** Closes every queue and event stream this process opened. Never throws. */
export async function closeQueues(): Promise<void> {
  const closers: Promise<void>[] = [];

  for (const [name, events] of queueEventsRegistry) {
    closers.push(
      events.close().catch((err: unknown) => {
        log.warn({ err, queue: name }, 'failed to close queue events');
      }),
    );
  }

  for (const [name, queue] of queueRegistry) {
    closers.push(
      queue.close().catch((err: unknown) => {
        log.warn({ err, queue: name }, 'failed to close queue');
      }),
    );
  }

  await Promise.all(closers);
  queueEventsRegistry.clear();
  queueRegistry.clear();
  log.debug('queues closed');
}
