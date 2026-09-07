/**
 * Single-process entrypoint: Fastify API and the BullMQ workers in one
 * container. Cheapest way to run UpBid 24/7 on a small Railway/Fly instance.
 *
 * The API module is resolved at runtime rather than statically imported, the
 * same way src/submit/review-queue.ts resolves the notifier: the server exports
 * a start/buildServer pair, and resolving it by shape means an entrypoint
 * rename cannot break this build. If neither half can start, the process exits
 * non-zero so the platform restarts it instead of serving a dead pipeline.
 */

import { env, safeConfigSummary } from '../config/env';
import { toErrorMessage } from '../lib/errors';
import { child } from '../lib/logger';
import { startHeartbeat } from '../workers/heartbeat';
import { installShutdownHandlers, startWorkers, type WorkerRuntime } from '../workers';

const log = child('bootstrap');

/** Export names the server module may use for "listen on the configured port". */
const START_EXPORTS = ['start', 'startServer', 'main'] as const;

/** Export names for "build me a server I have to listen on myself". */
const BUILD_EXPORTS = ['buildServer', 'createServer', 'build', 'server'] as const;

interface ClosableServer {
  close(): Promise<unknown> | unknown;
}

interface ListenableServer extends ClosableServer {
  listen(options: { port: number; host: string }): Promise<unknown>;
}

export interface ApiHandle {
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isClosable(value: unknown): value is ClosableServer {
  return isRecord(value) && typeof value.close === 'function';
}

function isListenable(value: unknown): value is ListenableServer {
  return isRecord(value) && typeof value.close === 'function' && typeof value.listen === 'function';
}

function pickFunction(
  containers: Record<string, unknown>[],
  names: readonly string[],
): { name: string; fn: (...args: unknown[]) => unknown; owner: Record<string, unknown> } | null {
  for (const container of containers) {
    for (const name of names) {
      const candidate = container[name];
      if (typeof candidate === 'function') {
        return {
          name,
          fn: candidate as (...args: unknown[]) => unknown,
          owner: container,
        };
      }
    }
  }
  return null;
}

function loadServerModule(): Record<string, unknown>[] {
  const loaded: unknown = require('../server');
  const containers: Record<string, unknown>[] = [];
  if (isRecord(loaded)) {
    containers.push(loaded);
    const fallback = loaded.default;
    if (isRecord(fallback)) containers.push(fallback);
  }
  return containers;
}

function toHandle(value: unknown, label: string): ApiHandle {
  if (!isClosable(value)) {
    return {
      async close(): Promise<void> {
        log.debug({ label }, 'api exposes no close(); relying on process exit');
      },
    };
  }
  return {
    async close(): Promise<void> {
      await value.close();
    },
  };
}

/**
 * Starts the HTTP API. Prefers an exported start()/startServer(); falls back to
 * buildServer() plus an explicit listen on PORT.
 */
export async function startApi(): Promise<ApiHandle> {
  const containers = loadServerModule();
  if (containers.length === 0) {
    throw new Error('src/server did not export anything usable');
  }

  const starter = pickFunction(containers, START_EXPORTS);
  if (starter) {
    const result: unknown = await starter.fn.call(starter.owner);
    log.info({ entrypoint: starter.name, port: env.PORT }, 'api started');
    return toHandle(result, starter.name);
  }

  const builder = pickFunction(containers, BUILD_EXPORTS);
  if (builder) {
    const built: unknown = await builder.fn.call(builder.owner);
    if (!isListenable(built)) {
      throw new Error(`src/server.${builder.name}() did not return a listenable server`);
    }
    await built.listen({ port: env.PORT, host: '0.0.0.0' });
    log.info({ entrypoint: builder.name, port: env.PORT }, 'api started');
    return toHandle(built, builder.name);
  }

  throw new Error(
    `src/server exports none of: ${[...START_EXPORTS, ...BUILD_EXPORTS].join(', ')}`,
  );
}

/* ------------------------------------------------------------------- boot */

async function main(): Promise<void> {
  log.info({ config: safeConfigSummary() }, 'starting UpBid (api + workers in one process)');

  const api = await startApi();
  // In this deployment mode the API lives in this process, so this process is
  // the honest source of the "api" heartbeat.
  const apiHeartbeat = startHeartbeat('api', {
    meta: () => ({ pid: process.pid, mode: 'all-in-one', port: env.PORT }),
  });

  let runtime: WorkerRuntime;
  try {
    runtime = await startWorkers();
  } catch (err) {
    // Half a system is not a system: an API with no workers detects nothing, so
    // shut the API down too and let the platform restart the whole container.
    log.fatal({ err }, 'workers failed to start; shutting down the api as well');
    await apiHeartbeat.stop('worker startup failed');
    await api.close().catch((closeErr: unknown) => {
      log.warn({ err: closeErr }, 'failed to close the api during startup failure');
    });
    throw err;
  }

  installShutdownHandlers(async (reason: string) => {
    log.info({ reason }, 'all-in-one shutdown started');
    // Stop accepting traffic first, then drain the queues.
    await apiHeartbeat.stop(reason);
    await api.close().catch((err: unknown) => {
      log.warn({ err }, 'failed to close the api');
    });
    await runtime.stop(reason);
  });

  log.info({ port: env.PORT, workers: runtime.workers.length }, 'UpBid is running');
}

if (require.main === module) {
  main().catch((err: unknown) => {
    log.fatal({ err }, `all-in-one bootstrap failed: ${toErrorMessage(err)}`);
    process.exit(1);
  });
}

export { main as bootstrap };
