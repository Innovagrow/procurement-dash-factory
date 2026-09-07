import type { FastifyInstance } from 'fastify';
import { env } from '../config/env';
import { toErrorMessage } from '../lib/errors';
import { child } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { getCounter } from '../lib/redis';
import { dayBucket, hoursAgo } from '../lib/time';
import { queueCounts } from '../queue/queues';
import { describeSources, sourceSnapshots } from '../sources/registry';
import { inboxDepth } from '../sources/webhook-inbox';
import { heartbeatSnapshot } from '../workers/heartbeat';
import { sseClientCount } from './sse';

const log = child('api:metrics');

/**
 * Prometheus exposition is built by hand: prom-client would duplicate state that
 * already lives in Postgres and Redis, and the whole surface is a dozen series.
 */

type MetricType = 'counter' | 'gauge';

interface Sample {
  labels?: Record<string, string | number>;
  value: number;
}

/** Counter names the workers increment in Redis, keyed by UTC day. */
const DAILY_COUNTERS = [
  'jobs.seen',
  'jobs.created',
  'jobs.changed',
  'jobs.scored',
  'proposals.drafted',
  'proposals.blocked',
  'submissions.submitted',
  'submissions.queued_for_review',
  'submissions.failed',
  'submissions.skipped',
  'submissions.dry_run',
  'submissions.unknown',
  'connects.spent',
] as const;

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function escapeHelp(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, ' ');
}

function renderLabels(labels: Record<string, string | number> | undefined): string {
  if (!labels) return '';
  const entries = Object.entries(labels).filter(([, value]) => value !== undefined && value !== null);
  if (entries.length === 0) return '';
  const rendered = entries
    .map(([key, value]) => `${key}="${escapeLabelValue(String(value))}"`)
    .join(',');
  return `{${rendered}}`;
}

function renderNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return Number.isInteger(value) ? String(value) : value.toFixed(6);
}

function renderMetric(name: string, type: MetricType, help: string, samples: Sample[]): string[] {
  if (samples.length === 0) return [];
  const lines = [`# HELP ${name} ${escapeHelp(help)}`, `# TYPE ${name} ${type}`];
  for (const sample of samples) {
    lines.push(`${name}${renderLabels(sample.labels)} ${renderNumber(sample.value)}`);
  }
  return lines;
}

async function safely<T>(label: string, fallback: T, task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (err) {
    log.warn({ err: toErrorMessage(err), collector: label }, 'metrics collector failed');
    return fallback;
  }
}

interface GroupCount {
  key: string;
  count: number;
}

async function groupCounts(
  label: string,
  loader: () => Promise<{ key: string | null; count: number }[]>,
): Promise<GroupCount[]> {
  const rows = await safely<{ key: string | null; count: number }[]>(label, [], loader);
  return rows.map((row) => ({ key: row.key ?? 'unknown', count: row.count }));
}

async function collect(): Promise<string> {
  const since24h = hoursAgo(24);
  const bucket = dayBucket();

  const [
    jobsByStatus,
    jobsTotal,
    jobs24h,
    matchesByDecision,
    proposalsByStatus,
    submissionsByStatus,
    queues,
    heartbeats,
    daily,
    inbox,
  ] = await Promise.all([
    groupCounts('jobs.byStatus', async () => {
      const rows = await prisma.job.groupBy({ by: ['status'], _count: { _all: true } });
      return rows.map((row) => ({ key: row.status, count: row._count._all }));
    }),
    safely('jobs.total', 0, () => prisma.job.count()),
    safely('jobs.24h', 0, () => prisma.job.count({ where: { firstSeenAt: { gte: since24h } } })),
    groupCounts('matches.byDecision', async () => {
      const rows = await prisma.jobProfileMatch.groupBy({
        by: ['decision'],
        _count: { _all: true },
      });
      return rows.map((row) => ({ key: row.decision, count: row._count._all }));
    }),
    groupCounts('proposals.byStatus', async () => {
      const rows = await prisma.proposal.groupBy({ by: ['status'], _count: { _all: true } });
      return rows.map((row) => ({ key: row.status, count: row._count._all }));
    }),
    groupCounts('submissions.byStatus', async () => {
      const rows = await prisma.submission.groupBy({ by: ['status'], _count: { _all: true } });
      return rows.map((row) => ({ key: row.status, count: row._count._all }));
    }),
    safely<Record<string, Record<string, number>>>('queues', {}, () => queueCounts()),
    safely<Awaited<ReturnType<typeof heartbeatSnapshot>>>('heartbeats', [], () =>
      heartbeatSnapshot(),
    ),
    safely<{ name: string; value: number }[]>('daily', [], async () => {
      const values = await Promise.all(
        DAILY_COUNTERS.map(async (name) => ({
          name,
          value: await getCounter(`metrics:${name}:${bucket}`),
        })),
      );
      return values;
    }),
    safely('inbox', 0, () => inboxDepth()),
  ]);

  const sources = describeSources();
  const snapshots = sourceSnapshots();
  const lines: string[] = [];

  lines.push(...renderMetric('upbid_up', 'gauge', 'Always 1 for a responding API process.', [
    { value: 1 },
  ]));

  lines.push(
    ...renderMetric('upbid_uptime_seconds', 'gauge', 'Seconds since this process started.', [
      { value: Math.round(process.uptime()) },
    ]),
  );

  lines.push(
    ...renderMetric('upbid_jobs_seen_total', 'counter', 'Job postings ever stored.', [
      { value: jobsTotal },
    ]),
  );

  lines.push(
    ...renderMetric(
      'upbid_jobs_seen_recent',
      'gauge',
      'Job postings first seen inside the window.',
      [{ labels: { window: '24h' }, value: jobs24h }],
    ),
  );

  lines.push(
    ...renderMetric(
      'upbid_jobs_by_status',
      'gauge',
      'Stored jobs grouped by pipeline status.',
      jobsByStatus.map((row) => ({ labels: { status: row.key }, value: row.count })),
    ),
  );

  lines.push(
    ...renderMetric(
      'upbid_matches_by_decision',
      'gauge',
      'Job/profile matches grouped by scoring decision.',
      matchesByDecision.map((row) => ({ labels: { decision: row.key }, value: row.count })),
    ),
  );

  lines.push(
    ...renderMetric(
      'upbid_proposals_by_status',
      'gauge',
      'Proposals grouped by status.',
      proposalsByStatus.map((row) => ({ labels: { status: row.key }, value: row.count })),
    ),
  );

  lines.push(
    ...renderMetric(
      'upbid_submissions_by_status',
      'gauge',
      'Submission attempts grouped by outcome.',
      submissionsByStatus.map((row) => ({ labels: { status: row.key }, value: row.count })),
    ),
  );

  const queueSamples: Sample[] = [];
  for (const [queue, counts] of Object.entries(queues)) {
    for (const [state, value] of Object.entries(counts)) {
      queueSamples.push({ labels: { queue, state }, value });
    }
  }
  lines.push(
    ...renderMetric('upbid_queue_jobs', 'gauge', 'BullMQ job counts per queue and state.', queueSamples),
  );

  lines.push(
    ...renderMetric(
      'upbid_source_enabled',
      'gauge',
      'A source is selected in SOURCES and fully configured.',
      sources.map((source) => ({
        labels: { source: source.name, selected: String(source.selected) },
        value: source.enabled ? 1 : 0,
      })),
    ),
  );

  lines.push(
    ...renderMetric(
      'upbid_source_breaker_open',
      'gauge',
      'A source circuit breaker is not CLOSED (1 = tripped or probing).',
      snapshots.map((snapshot) => ({
        labels: { source: snapshot.name, state: snapshot.breaker.state },
        value: snapshot.breaker.state === 'CLOSED' ? 0 : 1,
      })),
    ),
  );

  lines.push(
    ...renderMetric(
      'upbid_source_breaker_failures',
      'gauge',
      'Consecutive failures recorded by a source circuit breaker.',
      snapshots.map((snapshot) => ({
        labels: { source: snapshot.name },
        value: snapshot.breaker.failures,
      })),
    ),
  );

  lines.push(
    ...renderMetric(
      'upbid_source_rate_tokens',
      'gauge',
      'Tokens left in a source rate-limit bucket.',
      snapshots.map((snapshot) => ({
        labels: { source: snapshot.name },
        value: snapshot.tokensAvailable,
      })),
    ),
  );

  lines.push(
    ...renderMetric(
      'upbid_heartbeat_age_seconds',
      'gauge',
      'Seconds since a component last recorded a heartbeat (-1 when it never has).',
      heartbeats.map((entry) => ({
        labels: { component: entry.component, status: entry.status },
        value: entry.ageSeconds ?? -1,
      })),
    ),
  );

  lines.push(
    ...renderMetric(
      'upbid_heartbeat_healthy',
      'gauge',
      'A component beat recently enough to be considered alive.',
      heartbeats.map((entry) => ({
        labels: { component: entry.component },
        value: entry.healthy ? 1 : 0,
      })),
    ),
  );

  lines.push(
    ...renderMetric(
      'upbid_daily_events',
      'gauge',
      'Pipeline counters for the current UTC day.',
      daily.map((entry) => ({ labels: { metric: entry.name, day: bucket }, value: entry.value })),
    ),
  );

  lines.push(
    ...renderMetric('upbid_inbox_depth', 'gauge', 'Webhook inbox items waiting to be drained.', [
      { value: inbox },
    ]),
  );

  lines.push(
    ...renderMetric('upbid_sse_clients', 'gauge', 'Dashboards attached to this process.', [
      { value: sseClientCount() },
    ]),
  );

  const memory = process.memoryUsage();
  lines.push(
    ...renderMetric('upbid_process_resident_memory_bytes', 'gauge', 'Resident set size.', [
      { value: memory.rss },
    ]),
  );
  lines.push(
    ...renderMetric('upbid_process_heap_used_bytes', 'gauge', 'V8 heap in use.', [
      { value: memory.heapUsed },
    ]),
  );

  return `${lines.join('\n')}\n`;
}

export function registerMetrics(app: FastifyInstance): void {
  app.get('/api/metrics', async (_request, reply) => {
    if (!env.METRICS_ENABLED) {
      return reply
        .code(404)
        .send({ error: { code: 'METRICS_DISABLED', message: 'set METRICS_ENABLED=true to expose metrics' } });
    }

    const body = await collect();
    return reply
      .code(200)
      .header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .send(body);
  });
}

/** Exposed for tests and for the /api/health payload. */
export async function renderMetrics(): Promise<string> {
  return collect();
}
