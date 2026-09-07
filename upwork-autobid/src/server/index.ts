import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { env, isProd, safeConfigSummary } from '../config/env';
import { AppError, statusOf, toErrorMessage } from '../lib/errors';
import { child } from '../lib/logger';
import { connectPrisma, disconnectPrisma } from '../lib/prisma';
import { disconnectRedis } from '../lib/redis';
import { closeQueues } from '../queue/queues';
import { type HeartbeatHandle, startHeartbeat } from '../workers/heartbeat';
import { registerAuth } from './auth';
import { registerMetrics } from './metrics';
import actionRoutes from './routes/actions';
import healthRoutes from './routes/health';
import inboxRoutes from './routes/inbox';
import jobRoutes from './routes/jobs';
import oauthRoutes from './routes/oauth';
import profileRoutes from './routes/profiles';
import proposalRoutes from './routes/proposals';
import settingsRoutes from './routes/settings';
import statsRoutes from './routes/stats';
import templateRoutes from './routes/templates';
import { closeSse, registerSse, sseClientCount } from './sse';

const log = child('api');

/** Inbox payloads and edited cover letters are the only large bodies we accept. */
const BODY_LIMIT_BYTES = 4 * 1024 * 1024;

/** Paths whose per-request log line would be pure noise. */
const QUIET_PATHS = new Set(['/api/stream', '/api/metrics', '/api/health', '/api/health/live']);

declare module 'fastify' {
  interface FastifyRequest {
    startedAt?: number;
  }
}

/**
 * Serves the dashboard from src/public in development (tsx) and from whichever
 * copy exists next to the compiled output in production.
 */
export function resolvePublicDir(): string | null {
  const candidates = [
    join(__dirname, '..', 'public'),
    join(__dirname, '..', '..', 'src', 'public'),
    join(process.cwd(), 'src', 'public'),
    join(process.cwd(), 'dist', 'public'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function pathOnly(url: string): string {
  const index = url.indexOf('?');
  return index === -1 ? url : url.slice(0, index);
}

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    disableRequestLogging: true,
    trustProxy: true,
    bodyLimit: BODY_LIMIT_BYTES,
    genReqId: () => randomUUID(),
  });

  await app.register(cors, {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-actor'],
  });

  await app.register(formbody);

  app.addHook('onRequest', async (request) => {
    request.startedAt = Date.now();
  });

  app.addHook('onResponse', async (request, reply) => {
    const path = pathOnly(request.url);
    if (QUIET_PATHS.has(path) && reply.statusCode < 400) return;

    const payload = {
      reqId: request.id,
      method: request.method,
      path,
      status: reply.statusCode,
      ms: request.startedAt ? Date.now() - request.startedAt : undefined,
      ip: request.ip,
    };

    if (reply.statusCode >= 500) log.error(payload, 'request failed');
    else if (reply.statusCode >= 400) log.warn(payload, 'request rejected');
    else if (request.method === 'GET') log.debug(payload, 'request');
    else log.info(payload, 'request');
  });

  // The credential gate has to exist before any route is added: Fastify binds a
  // route's hook chain at registration time.
  registerAuth(app);
  registerSse(app);
  registerMetrics(app);

  await app.register(healthRoutes, { prefix: '/api' });
  await app.register(jobRoutes, { prefix: '/api' });
  await app.register(proposalRoutes, { prefix: '/api' });
  await app.register(profileRoutes, { prefix: '/api' });
  await app.register(statsRoutes, { prefix: '/api' });
  await app.register(inboxRoutes, { prefix: '/api' });
  await app.register(oauthRoutes, { prefix: '/api' });
  await app.register(templateRoutes, { prefix: '/api' });
  await app.register(settingsRoutes, { prefix: '/api' });
  await app.register(actionRoutes, { prefix: '/api' });

  // Upwork redirect URIs are registered by hand and are just as often set to
  // /oauth/upwork/callback as to /api/oauth/upwork/callback; both work.
  await app.register(oauthRoutes);

  const publicDir = resolvePublicDir();
  if (publicDir) {
    await app.register(fastifyStatic, {
      root: publicDir,
      prefix: '/',
      index: ['index.html'],
      // Leaves unmatched paths to the not-found handler below instead of
      // answering every /api typo with a static 404.
      wildcard: false,
      cacheControl: true,
      maxAge: isProd ? 300_000 : 0,
      etag: true,
    });
    log.info({ publicDir }, 'serving the dashboard');
  } else {
    log.warn('no public directory found; the dashboard will not be served');
  }

  app.setNotFoundHandler(async (request, reply) => {
    const path = pathOnly(request.url);

    if (path.startsWith('/api')) {
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: `no route for ${request.method} ${path}` } });
    }

    // Single-page app: deep links are resolved client-side.
    if (publicDir && request.method === 'GET' && typeof reply.sendFile === 'function') {
      return reply.type('text/html; charset=utf-8').sendFile('index.html');
    }

    return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'not found' } });
  });

  app.setErrorHandler((error: FastifyError | Error, request, reply) => {
    const path = pathOnly(request.url);

    if (error instanceof ZodError) {
      log.warn({ reqId: request.id, path, issues: error.issues }, 'request failed validation');
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'request payload failed validation',
          issues: error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
          requestId: request.id,
        },
      });
    }

    const fastifyError = error as FastifyError;
    if (fastifyError.validation) {
      log.warn({ reqId: request.id, path, err: error }, 'request failed schema validation');
      return reply.code(400).send({
        error: { code: 'VALIDATION_ERROR', message: error.message, requestId: request.id },
      });
    }

    const status = statusOf(error) ?? 500;
    const code = error instanceof AppError ? error.code : (fastifyError.code ?? 'INTERNAL_ERROR');

    if (status >= 500) {
      log.error({ reqId: request.id, path, err: error }, 'unhandled error in a route');
    } else {
      log.warn({ reqId: request.id, path, err: error }, 'request error');
    }

    // Internal failures never leak a driver message or a stack to the client.
    const message =
      status >= 500 && isProd ? 'internal server error' : toErrorMessage(error) || 'request failed';

    return reply.code(status).send({
      error: {
        code,
        message,
        requestId: request.id,
        ...(error instanceof AppError && Object.keys(error.details).length > 0
          ? { details: error.details }
          : {}),
      },
    });
  });

  return app;
}

let shuttingDown = false;

async function shutdown(app: FastifyInstance, heartbeat: HeartbeatHandle | null, signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  log.info({ signal }, 'shutting the api down');

  const steps: [string, () => Promise<unknown>][] = [
    ['heartbeat', async () => (heartbeat ? heartbeat.stop(`received ${signal}`) : undefined)],
    ['http', async () => app.close()],
    ['sse', closeSse],
    ['queues', closeQueues],
    ['redis', disconnectRedis],
    ['prisma', disconnectPrisma],
  ];

  for (const [name, step] of steps) {
    try {
      await step();
    } catch (err) {
      log.warn({ err: toErrorMessage(err), step: name }, 'shutdown step failed');
    }
  }

  log.info('api stopped');
}

export async function start(): Promise<FastifyInstance> {
  try {
    await connectPrisma();
  } catch (err) {
    // Starting anyway keeps /api/health reachable so the platform can report
    // *why* the container is unhealthy instead of crash-looping silently.
    log.error({ err: toErrorMessage(err) }, 'database connection failed at startup');
  }

  const app = await buildServer();

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  log.info({ port: env.PORT, config: safeConfigSummary() }, 'api listening');

  const heartbeat = startHeartbeat('api', {
    meta: () => ({
      port: env.PORT,
      sseClients: sseClientCount(),
      uptimeSeconds: Math.round(process.uptime()),
      rssBytes: process.memoryUsage().rss,
    }),
  });

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void shutdown(app, heartbeat, signal).then(() => {
        process.exit(0);
      });
    });
  }

  process.on('unhandledRejection', (reason) => {
    log.error({ err: reason }, 'unhandled promise rejection');
  });

  process.on('uncaughtException', (err) => {
    log.error({ err }, 'uncaught exception');
  });

  return app;
}

if (require.main === module) {
  start().catch((err: unknown) => {
    log.fatal({ err: toErrorMessage(err) }, 'api failed to start');
    process.exit(1);
  });
}
