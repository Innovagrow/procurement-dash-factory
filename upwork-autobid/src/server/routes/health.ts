import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { safeConfigSummary } from '../../config/env';
import { toErrorMessage } from '../../lib/errors';
import { child } from '../../lib/logger';
import { pingDatabase } from '../../lib/prisma';
import { pingRedis } from '../../lib/redis';
import { queueCounts } from '../../queue/queues';
import { describeSources, sourceSnapshots } from '../../sources/registry';
import { getConnectionStatus } from '../../sources/upwork-oauth';
import { submitterStatus } from '../../submit';
import { heartbeatSnapshot } from '../../workers/heartbeat';

const log = child('api:health');

/** Components whose staleness downgrades the report but never fails the probe. */
const REQUIRED_COMPONENTS = ['worker'] as const;

let cachedVersion: string | null = null;

/**
 * package.json sits outside rootDir, so it cannot be imported: reading it at
 * runtime works from both src (tsx) and dist (node).
 */
function readVersion(): string {
  if (cachedVersion !== null) return cachedVersion;

  const candidates = [
    join(__dirname, '..', '..', '..', 'package.json'),
    join(__dirname, '..', '..', '..', '..', 'package.json'),
    join(process.cwd(), 'package.json'),
  ];

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(candidate, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        const version = (parsed as { version?: unknown }).version;
        if (typeof version === 'string' && version !== '') {
          cachedVersion = version;
          return cachedVersion;
        }
      }
    } catch {
      // Try the next candidate; a missing package.json is not an error here.
    }
  }

  cachedVersion = '0.0.0';
  return cachedVersion;
}

interface CheckResult {
  ok: boolean;
  latencyMs?: number;
  detail?: string;
}

async function safeCheck(name: string, task: () => Promise<CheckResult>): Promise<CheckResult> {
  try {
    return await task();
  } catch (err) {
    log.warn({ err: toErrorMessage(err), check: name }, 'health check threw');
    return { ok: false, detail: toErrorMessage(err) };
  }
}

export default async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health/live', async (_request, reply) =>
    reply.code(200).send({
      status: 'alive',
      uptime: Math.round(process.uptime()),
      version: readVersion(),
      at: new Date().toISOString(),
    }),
  );

  app.get('/health', async (_request, reply) => {
    const [db, redisCheck, queues, heartbeats, submitter, oauth] = await Promise.all([
      safeCheck('database', async () => pingDatabase()),
      safeCheck('redis', async () => pingRedis()),
      (async () => {
        try {
          return await queueCounts();
        } catch (err) {
          log.warn({ err: toErrorMessage(err) }, 'failed to read queue counts');
          return {} as Record<string, Record<string, number>>;
        }
      })(),
      (async () => {
        try {
          return await heartbeatSnapshot();
        } catch (err) {
          log.warn({ err: toErrorMessage(err) }, 'failed to read heartbeats');
          return [] as Awaited<ReturnType<typeof heartbeatSnapshot>>;
        }
      })(),
      (async () => {
        try {
          return await submitterStatus();
        } catch (err) {
          log.warn({ err: toErrorMessage(err) }, 'failed to read submitter status');
          return null;
        }
      })(),
      (async () => {
        try {
          return await getConnectionStatus();
        } catch (err) {
          log.warn({ err: toErrorMessage(err) }, 'failed to read upwork oauth status');
          return null;
        }
      })(),
    ]);

    const snapshots = new Map(sourceSnapshots().map((entry) => [entry.name, entry]));
    const sources = describeSources().map((source) => {
      const snapshot = snapshots.get(source.name);
      return {
        name: source.name,
        selected: source.selected,
        enabled: source.enabled,
        breaker: snapshot ? snapshot.breaker.state : 'UNKNOWN',
        failures: snapshot ? snapshot.breaker.failures : 0,
        retryAfterMs: snapshot ? snapshot.breaker.retryAfterMs : 0,
      };
    });

    const byComponent = new Map(heartbeats.map((entry) => [entry.component, entry]));
    const workersHealthy = REQUIRED_COMPONENTS.every(
      (component) => byComponent.get(component)?.healthy === true,
    );
    const anySourceEnabled = sources.some((source) => source.enabled);

    const critical = db.ok && redisCheck.ok;
    const status = critical ? (workersHealthy && anySourceEnabled ? 'ok' : 'degraded') : 'down';

    const notes: string[] = [];
    if (!workersHealthy) notes.push('no recent worker heartbeat');
    if (!anySourceEnabled) notes.push('no detection source is enabled and configured');
    if (!db.ok) notes.push(`database unreachable: ${db.detail ?? 'unknown error'}`);
    if (!redisCheck.ok) notes.push(`redis unreachable: ${redisCheck.detail ?? 'unknown error'}`);

    return reply.code(critical ? 200 : 503).send({
      status,
      at: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
      version: readVersion(),
      db,
      redis: redisCheck,
      queues,
      heartbeats,
      sources,
      submitter,
      upworkOAuth: oauth,
      notes,
      config: safeConfigSummary(),
    });
  });
}
