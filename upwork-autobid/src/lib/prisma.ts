import { PrismaClient } from '@prisma/client';
import { env, isProd } from '../config/env';
import { child } from './logger';

const log = child('prisma');

// tsx watch reloads the module graph on every change; without the global cache
// each reload would open a fresh connection pool and exhaust Postgres.
const globalForPrisma = globalThis as unknown as { __upbidPrisma?: PrismaClient };

/** Minimal structural view of the event emitter - the typed overload depends on
 * the literal `log` option, which we cannot express through a factory function. */
type PrismaEventEmitter = {
  $on(event: 'error' | 'warn', callback: (event: unknown) => void): void;
};

function createClient(): PrismaClient {
  const client = new PrismaClient({
    datasources: { db: { url: env.DATABASE_URL } },
    log: [
      { emit: 'event', level: 'error' },
      { emit: 'event', level: 'warn' },
    ],
  });

  const emitter = client as unknown as PrismaEventEmitter;
  emitter.$on('error', (event) => log.error({ event }, 'prisma error'));
  emitter.$on('warn', (event) => log.warn({ event }, 'prisma warning'));

  return client;
}

export const prisma: PrismaClient = globalForPrisma.__upbidPrisma ?? createClient();

if (!isProd) {
  globalForPrisma.__upbidPrisma = prisma;
}

export async function connectPrisma(): Promise<void> {
  await prisma.$connect();
  log.debug('prisma connected');
}

export async function disconnectPrisma(): Promise<void> {
  try {
    await prisma.$disconnect();
    log.debug('prisma disconnected');
  } catch (err) {
    log.warn({ err }, 'prisma disconnect failed');
  } finally {
    if (globalForPrisma.__upbidPrisma) delete globalForPrisma.__upbidPrisma;
  }
}

/** Cheap liveness probe for /health. */
export async function pingDatabase(): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
  const started = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export default prisma;
