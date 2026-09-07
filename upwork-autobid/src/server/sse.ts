import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Redis } from 'ioredis';
import { toErrorMessage } from '../lib/errors';
import { child } from '../lib/logger';
import { createRedisConnection, redis } from '../lib/redis';

const log = child('api:sse');

/** Worker and API processes both publish here; every API process fans out. */
export const EVENT_CHANNEL = 'upbid:events';

const KEEPALIVE_MS = 25_000;

/** Identifies the emitting process so a client can ignore its own echoes. */
const ORIGIN = `${process.pid}-${randomUUID().slice(0, 8)}`;

export interface SseEnvelope {
  event: string;
  data: unknown;
  at: string;
  origin: string;
}

interface SseClient {
  id: string;
  reply: FastifyReply;
  connectedAt: number;
}

const clients = new Map<string, SseClient>();

let subscriber: Redis | null = null;
let subscriberReady = false;
let keepAliveTimer: NodeJS.Timeout | null = null;

export function sseClientCount(): number {
  return clients.size;
}

function forget(id: string): void {
  clients.delete(id);
  if (clients.size === 0) stopKeepAlive();
}

function writeChunk(client: SseClient, chunk: string): boolean {
  const raw = client.reply.raw;
  if (raw.writableEnded || raw.destroyed) {
    forget(client.id);
    return false;
  }
  try {
    raw.write(chunk);
    return true;
  } catch (err) {
    log.debug({ err: toErrorMessage(err), clientId: client.id }, 'sse write failed, dropping client');
    dropClient(client.id);
    return false;
  }
}

function formatEvent(envelope: SseEnvelope): string {
  const payload = JSON.stringify({
    event: envelope.event,
    data: envelope.data,
    at: envelope.at,
    origin: envelope.origin,
  });
  // Any newline in the event name would end the frame early; JSON never contains one.
  const name = envelope.event.replace(/[\r\n]+/g, ' ').slice(0, 120);
  return `event: ${name}\ndata: ${payload}\n\n`;
}

function broadcastLocal(envelope: SseEnvelope): number {
  if (clients.size === 0) return 0;
  const chunk = formatEvent(envelope);
  let delivered = 0;
  for (const client of Array.from(clients.values())) {
    if (writeChunk(client, chunk)) delivered += 1;
  }
  return delivered;
}

function dropClient(id: string): void {
  const client = clients.get(id);
  forget(id);
  if (!client) return;
  try {
    if (!client.reply.raw.writableEnded) client.reply.raw.end();
  } catch (err) {
    log.debug({ err: toErrorMessage(err), clientId: id }, 'failed to end sse stream');
  }
}

function startKeepAlive(): void {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    if (clients.size === 0) {
      stopKeepAlive();
      return;
    }
    for (const client of Array.from(clients.values())) {
      writeChunk(client, `: keepalive ${Date.now()}\n\n`);
    }
  }, KEEPALIVE_MS);
  keepAliveTimer.unref();
}

function stopKeepAlive(): void {
  if (!keepAliveTimer) return;
  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

function parseEnvelope(message: string): SseEnvelope | null {
  try {
    const parsed: unknown = JSON.parse(message);
    if (!parsed || typeof parsed !== 'object') return null;
    const candidate = parsed as Partial<SseEnvelope>;
    if (typeof candidate.event !== 'string' || candidate.event === '') return null;
    return {
      event: candidate.event,
      data: candidate.data ?? null,
      at: typeof candidate.at === 'string' ? candidate.at : new Date().toISOString(),
      origin: typeof candidate.origin === 'string' ? candidate.origin : 'unknown',
    };
  } catch (err) {
    log.debug({ err: toErrorMessage(err) }, 'ignored malformed sse payload');
    return null;
  }
}

/**
 * A dedicated connection: a subscribed ioredis client refuses ordinary commands,
 * so it can never be the shared client used for locks and counters.
 */
function ensureSubscriber(): void {
  if (subscriber) return;

  const connection = createRedisConnection('sse-subscriber');
  subscriber = connection;

  connection.on('message', (channel: string, message: string) => {
    if (channel !== EVENT_CHANNEL) return;
    const envelope = parseEnvelope(message);
    if (envelope) broadcastLocal(envelope);
  });

  connection.on('error', (err: Error) => {
    log.warn({ err }, 'sse subscriber connection error');
  });

  connection
    .subscribe(EVENT_CHANNEL)
    .then(() => {
      subscriberReady = true;
      log.debug({ channel: EVENT_CHANNEL }, 'sse subscriber ready');
    })
    .catch((err: unknown) => {
      subscriberReady = false;
      log.error({ err: toErrorMessage(err) }, 'failed to subscribe to the event channel');
    });
}

/**
 * Publishes one event to every dashboard connected to any API process. Failure
 * to reach Redis degrades to a local fan-out rather than losing the event for
 * the clients this process is already serving.
 */
export async function publish(event: string, data: unknown): Promise<void> {
  const envelope: SseEnvelope = {
    event,
    data,
    at: new Date().toISOString(),
    origin: ORIGIN,
  };

  try {
    await redis.publish(EVENT_CHANNEL, JSON.stringify(envelope));
    if (!subscriberReady) broadcastLocal(envelope);
  } catch (err) {
    log.warn({ err: toErrorMessage(err), event }, 'event publish failed, falling back to local fan-out');
    broadcastLocal(envelope);
  }
}

/** Fire-and-forget wrapper for handlers that must not await the fan-out. */
export function emit(event: string, data: unknown): void {
  void publish(event, data).catch((err: unknown) => {
    log.debug({ err: toErrorMessage(err), event }, 'event emit failed');
  });
}

export function registerSse(app: FastifyInstance): void {
  ensureSubscriber();

  app.get('/api/stream', async (request, reply) => {
    const id = randomUUID();

    reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    // Defeats proxy buffering (nginx and most PaaS routers honour this).
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.flushHeaders();

    // Fastify must not try to serialise or close this reply; we own the socket.
    reply.hijack();

    const client: SseClient = { id, reply, connectedAt: Date.now() };
    clients.set(id, client);
    startKeepAlive();

    writeChunk(client, 'retry: 5000\n\n');
    writeChunk(
      client,
      formatEvent({
        event: 'connected',
        data: { clientId: id, origin: ORIGIN, clients: clients.size },
        at: new Date().toISOString(),
        origin: ORIGIN,
      }),
    );

    const cleanup = (): void => {
      if (!clients.has(id)) return;
      forget(id);
      log.debug({ clientId: id, clients: clients.size }, 'sse client disconnected');
    };

    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);
    reply.raw.on('close', cleanup);

    log.debug({ clientId: id, clients: clients.size }, 'sse client connected');
  });

  app.addHook('onClose', async () => {
    await closeSse();
  });
}

/** Ends every stream and releases the subscriber. Never throws. */
export async function closeSse(): Promise<void> {
  stopKeepAlive();

  for (const client of Array.from(clients.values())) {
    try {
      if (!client.reply.raw.writableEnded) {
        client.reply.raw.write(
          formatEvent({
            event: 'shutdown',
            data: { reason: 'server shutting down' },
            at: new Date().toISOString(),
            origin: ORIGIN,
          }),
        );
        client.reply.raw.end();
      }
    } catch (err) {
      log.debug({ err: toErrorMessage(err), clientId: client.id }, 'failed to close sse client');
    }
  }
  clients.clear();

  const connection = subscriber;
  subscriber = null;
  subscriberReady = false;
  if (!connection) return;

  try {
    await connection.unsubscribe(EVENT_CHANNEL);
  } catch (err) {
    log.debug({ err: toErrorMessage(err) }, 'sse unsubscribe failed');
  }
  try {
    await connection.quit();
  } catch (err) {
    log.debug({ err: toErrorMessage(err) }, 'sse subscriber quit failed');
    connection.disconnect();
  }
}
