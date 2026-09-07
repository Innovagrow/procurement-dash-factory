/**
 * Worker process entrypoint.
 *
 * Boots the queue consumers, installs the repeatable schedules, beats for
 * liveness, and shuts down cleanly on a signal. Anything that escapes a job
 * handler is logged; anything that escapes the process is fatal on purpose, so
 * the platform restarts the container instead of leaving a half-dead worker.
 */

import { Worker, type Job, type WorkerOptions } from 'bullmq';
import { env, safeConfigSummary } from '../config/env';
import { child } from '../lib/logger';
import { connectPrisma, disconnectPrisma } from '../lib/prisma';
import { disconnectRedis, redisConnectionOptions } from '../lib/redis';
import { notify, startDigestFlusher, stopDigestFlusher } from '../notify';
import { startSourceWatchers, stopSourceWatchers } from '../sources/registry';
import type { DraftJobData, NotifyJobData, ScoreJobData, SubmitJobData } from '../types';
import {
  QUEUE_NAMES,
  closeQueues,
  queueCounts,
  startQueueEventLogging,
  type DigestJobData,
  type DiscoverJobData,
  type MaintenanceJobData,
  type QueueName,
} from '../queue/queues';
import { registerSchedules } from '../queue/scheduler';
import { runDiscover } from './discover';
import { runScore } from './score';
import { runDraft } from './draft';
import { runSubmit } from './submit';
import { runDigest, runMaintenance } from './maintenance';
import { beat, startHeartbeat, type HeartbeatHandle } from './heartbeat';

const log = child('worker');

/** Give a job plenty of lock headroom; the LLM calls are the slow ones. */
const LOCK_DURATION_MS = 120_000;

const SHUTDOWN_TIMEOUT_MS = 25_000;

export interface WorkerRuntime {
  workers: Worker[];
  heartbeat: HeartbeatHandle;
  stop(reason: string): Promise<void>;
}

function workerOptions(concurrency: number): WorkerOptions {
  return {
    connection: redisConnectionOptions,
    concurrency: Math.max(1, concurrency),
    lockDuration: LOCK_DURATION_MS,
  };
}

/** Structured logs for every failure mode BullMQ can surface. */
function wireWorkerEvents(worker: Worker, queue: string): void {
  worker.on('failed', (job: Job | undefined, err: Error) => {
    log.error(
      {
        err,
        queue,
        jobId: job?.id,
        jobName: job?.name,
        attemptsMade: job?.attemptsMade,
        maxAttempts: job?.opts.attempts,
        data: job?.data,
      },
      'job failed',
    );
  });

  worker.on('error', (err: Error) => {
    log.error({ err, queue }, 'worker error');
  });

  worker.on('stalled', (jobId: string) => {
    log.warn({ queue, jobId }, 'job stalled and will be re-queued');
  });

  worker.on('completed', (job: Job) => {
    log.debug({ queue, jobId: job.id, jobName: job.name }, 'job completed');
  });
}

/* ---------------------------------------------------------------- workers */

function createWorkers(): Worker[] {
  const concurrency = env.WORKER_CONCURRENCY;
  const workers: Worker[] = [];

  // The generic Worker<T> is narrowed per queue for the processor's sake; the
  // array that owns them is heterogeneous, hence the single cast per entry.
  const register = <T>(
    queue: QueueName,
    processor: (job: Job<T>) => Promise<unknown>,
    workerConcurrency: number,
  ): void => {
    const worker = new Worker<T>(queue, processor, workerOptions(workerConcurrency));
    wireWorkerEvents(worker as unknown as Worker, queue);
    workers.push(worker as unknown as Worker);
  };

  register<DiscoverJobData>(QUEUE_NAMES.discover, (job) => runDiscover(job.data), concurrency);
  register<ScoreJobData>(QUEUE_NAMES.score, (job) => runScore(job.data), concurrency);
  register<DraftJobData>(QUEUE_NAMES.draft, (job) => runDraft(job.data), concurrency);

  register<SubmitJobData>(
    QUEUE_NAMES.submit,
    (job) =>
      runSubmit(job.data, {
        attempt: (job.attemptsMade ?? 0) + 1,
        maxAttempts: job.opts.attempts ?? 5,
      }),
    concurrency,
  );

  // Housekeeping and the digest are serialised on purpose: both hold their own
  // locks anyway, and a second concurrent sweep would only contend for them.
  register<MaintenanceJobData>(
    QUEUE_NAMES.maintenance,
    async (job) => {
      const task = job.data?.task ?? (job.name.includes('heartbeat') ? 'heartbeat' : 'sweep');
      if (task === 'heartbeat') {
        // Proves the repeatable scheduler is still delivering jobs, which is a
        // stronger signal than "this process is alive".
        await beat('scheduler', { detail: 'repeatable schedule delivered' });
        return { task, ok: true };
      }
      return { task, ...(await runMaintenance()) };
    },
    1,
  );

  register<DigestJobData | NotifyJobData>(
    QUEUE_NAMES.notifyDigest,
    async (job) => {
      const data = job.data;
      // The same queue carries the scheduled digest and any ad-hoc message the
      // API wants delivered out of band.
      if (data && typeof data === 'object' && 'message' in data && data.message) {
        return notify(data.message);
      }
      return runDigest();
    },
    1,
  );

  return workers;
}

/* ------------------------------------------------------------------- boot */

/**
 * Starts every consumer and the schedules they feed on. Throws if the queue
 * backend is unreachable - a worker that cannot schedule is worse than a
 * restart loop, because it looks healthy while detecting nothing.
 */
export async function startWorkers(): Promise<WorkerRuntime> {
  await connectPrisma();
  await beat('worker', { detail: 'booting' });

  const schedules = await registerSchedules();
  await beat('scheduler', { detail: `registered ${schedules.registered.length} schedules` });

  startQueueEventLogging();
  const workers = createWorkers();

  // Batched (digest-mode) alerts only leave the buffer if something flushes it,
  // and this is the process that is always up.
  startDigestFlusher();

  try {
    const watchers = await startSourceWatchers();
    if (watchers.length > 0) log.info({ watchers }, 'source watchers started');
  } catch (err) {
    // Push-style sources are a bonus; polling still covers detection.
    log.warn({ err }, 'failed to start source watchers');
  }

  const heartbeat = startHeartbeat('worker', {
    meta: async () => ({
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      concurrency: env.WORKER_CONCURRENCY,
      queues: await queueCounts(),
    }),
  });

  log.info(
    {
      queues: Object.values(QUEUE_NAMES),
      schedules: schedules.registered,
      removedSchedules: schedules.removed,
      scheduleErrors: schedules.errors,
      config: safeConfigSummary(),
    },
    'workers started',
  );

  let stopped = false;

  return {
    workers,
    heartbeat,
    async stop(reason: string): Promise<void> {
      if (stopped) return;
      stopped = true;
      log.info({ reason }, 'stopping workers');

      stopDigestFlusher();
      await heartbeat.stop(reason);

      await Promise.all(
        workers.map((worker) =>
          worker.close().catch((err: unknown) => {
            log.warn({ err, queue: worker.name }, 'failed to close worker');
          }),
        ),
      );

      try {
        await stopSourceWatchers();
      } catch (err) {
        log.warn({ err }, 'failed to stop source watchers');
      }

      await closeQueues();
      await disconnectPrisma();
      await disconnectRedis();

      log.info({ reason }, 'workers stopped');
    },
  };
}

/* --------------------------------------------------------------- shutdown */

let shuttingDown = false;

/**
 * Installs signal and process-level handlers. A crash exits non-zero so the
 * platform restarts the container; a signal exits zero after draining.
 */
export function installShutdownHandlers(
  stop: (reason: string) => Promise<void>,
  timeoutMs: number = SHUTDOWN_TIMEOUT_MS,
): void {
  const run = async (reason: string, code: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    const forceExit = setTimeout(() => {
      log.error({ reason, timeoutMs }, 'graceful shutdown timed out; forcing exit');
      process.exit(code === 0 ? 1 : code);
    }, timeoutMs);

    try {
      await stop(reason);
      clearTimeout(forceExit);
      process.exit(code);
    } catch (err) {
      clearTimeout(forceExit);
      log.error({ err, reason }, 'shutdown failed');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => {
    log.info('received SIGINT');
    void run('SIGINT', 0);
  });

  process.on('SIGTERM', () => {
    log.info('received SIGTERM');
    void run('SIGTERM', 0);
  });

  process.on('unhandledRejection', (reason: unknown) => {
    log.fatal({ err: reason }, 'unhandled promise rejection; exiting for a restart');
    void run('unhandledRejection', 1);
  });

  process.on('uncaughtException', (err: Error) => {
    log.fatal({ err }, 'uncaught exception; exiting for a restart');
    void run('uncaughtException', 1);
  });
}

async function main(): Promise<void> {
  const runtime = await startWorkers();
  installShutdownHandlers((reason) => runtime.stop(reason));
}

if (require.main === module) {
  main().catch((err: unknown) => {
    log.fatal({ err }, 'worker failed to start');
    process.exit(1);
  });
}
