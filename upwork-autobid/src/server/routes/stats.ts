import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { child } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { daysAgo, hoursAgo } from '../../lib/time';
import type { PipelineStats } from '../../types';

const log = child('api:stats');

/** Row caps for the aggregations computed in JS rather than in Postgres. */
const MEDIAN_SAMPLE = 1000;
const SKILL_SAMPLE = 1000;
const HISTOGRAM_SAMPLE = 20000;

const querySchema = z.object({
  histogramDays: z.coerce.number().int().min(1).max(90).default(7),
  skillDays: z.coerce.number().int().min(1).max(90).default(30),
});

function startOfUtcDay(reference: Date = new Date()): Date {
  return new Date(
    Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate()),
  );
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function round(value: number | null, digits = 1): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export interface WindowStats {
  since: string;
  jobsSeen: number;
  jobsScored: number;
  matched: number;
  bid: number;
  review: number;
  skipped: number;
  drafted: number;
  submitted: number;
  approved: number;
  rejected: number;
  approvalRate: number | null;
  avgScore: number | null;
  medianTimeToDraftSeconds: number | null;
  connectsSpent: number;
}

async function windowStats(since: Date): Promise<WindowStats> {
  const [
    jobsSeen,
    jobsScored,
    bid,
    review,
    skipped,
    drafted,
    submitted,
    approved,
    rejected,
    scoreAggregate,
    connects,
    draftSample,
  ] = await Promise.all([
    prisma.job.count({ where: { firstSeenAt: { gte: since } } }),
    prisma.jobProfileMatch.count({ where: { scoredAt: { gte: since } } }),
    prisma.jobProfileMatch.count({ where: { scoredAt: { gte: since }, decision: 'BID' } }),
    prisma.jobProfileMatch.count({ where: { scoredAt: { gte: since }, decision: 'REVIEW' } }),
    prisma.jobProfileMatch.count({ where: { scoredAt: { gte: since }, decision: 'SKIP' } }),
    prisma.proposal.count({ where: { createdAt: { gte: since } } }),
    prisma.submission.count({ where: { createdAt: { gte: since }, status: 'SUBMITTED' } }),
    prisma.proposal.count({ where: { approvedAt: { gte: since } } }),
    prisma.proposal.count({ where: { rejectedAt: { gte: since } } }),
    prisma.jobProfileMatch.aggregate({
      where: { scoredAt: { gte: since } },
      _avg: { score: true },
    }),
    prisma.connectsLedger.aggregate({
      where: { createdAt: { gte: since }, delta: { lt: 0 } },
      _sum: { delta: true },
    }),
    prisma.proposal.findMany({
      where: { createdAt: { gte: since }, job: { postedAt: { not: null } } },
      orderBy: { createdAt: 'desc' },
      take: MEDIAN_SAMPLE,
      select: { createdAt: true, job: { select: { postedAt: true } } },
    }),
  ]);

  const latencies: number[] = [];
  for (const row of draftSample) {
    const postedAt = row.job.postedAt;
    if (!postedAt) continue;
    const seconds = (row.createdAt.getTime() - postedAt.getTime()) / 1000;
    // Backfilled or clock-skewed rows would poison the median.
    if (seconds >= 0 && seconds < 30 * 24 * 3600) latencies.push(seconds);
  }

  const decided = approved + rejected;

  return {
    since: since.toISOString(),
    jobsSeen,
    jobsScored,
    matched: bid + review,
    bid,
    review,
    skipped,
    drafted,
    submitted,
    approved,
    rejected,
    approvalRate: decided > 0 ? round(approved / decided, 3) : null,
    avgScore: round(scoreAggregate._avg.score, 1),
    medianTimeToDraftSeconds: round(median(latencies), 0),
    connectsSpent: Math.abs(connects._sum.delta ?? 0),
  };
}

export default async function statsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/stats', async (request, reply) => {
    const parsed = querySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: 'BAD_REQUEST',
          message: 'invalid query parameters',
          issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        },
      });
    }

    const now = new Date();
    const today = startOfUtcDay(now);
    const last7d = daysAgo(7, now);
    const last30d = daysAgo(30, now);
    const last24h = hoursAgo(24, now);
    const histogramSince = daysAgo(parsed.data.histogramDays, now);
    const skillSince = daysAgo(parsed.data.skillDays, now);

    const [
      windows,
      sourceRows,
      skillRows,
      postingRows,
      pendingApproval,
      activeProfiles,
      jobs24h,
      scored24h,
      drafted24h,
      submitted24h,
      avg24h,
      profileRows,
    ] = await Promise.all([
      Promise.all([windowStats(today), windowStats(last7d), windowStats(last30d)]),
      prisma.job.groupBy({
        by: ['source'],
        where: { firstSeenAt: { gte: last30d } },
        _count: { _all: true },
      }),
      prisma.jobProfileMatch.findMany({
        where: { decision: 'BID', scoredAt: { gte: skillSince } },
        orderBy: { scoredAt: 'desc' },
        take: SKILL_SAMPLE,
        select: { job: { select: { skills: true } } },
      }),
      prisma.job.findMany({
        where: { postedAt: { gte: histogramSince } },
        take: HISTOGRAM_SAMPLE,
        select: { postedAt: true },
      }),
      prisma.proposal.count({ where: { status: 'PENDING_APPROVAL' } }),
      prisma.profile.count({ where: { isActive: true } }),
      prisma.job.count({ where: { firstSeenAt: { gte: last24h } } }),
      prisma.jobProfileMatch.count({ where: { scoredAt: { gte: last24h } } }),
      prisma.proposal.count({ where: { createdAt: { gte: last24h } } }),
      prisma.submission.count({ where: { createdAt: { gte: last24h }, status: 'SUBMITTED' } }),
      prisma.jobProfileMatch.aggregate({
        where: { scoredAt: { gte: last24h } },
        _avg: { score: true },
      }),
      prisma.profile.findMany({
        where: { isActive: true },
        select: {
          id: true,
          name: true,
          isActive: true,
          autoSubmit: true,
          autoBidThreshold: true,
          reviewThreshold: true,
          _count: { select: { proposals: true, jobs: true } },
        },
        orderBy: { name: 'asc' },
      }),
    ]);

    const skillCounts = new Map<string, number>();
    for (const row of skillRows) {
      for (const skill of row.job.skills) {
        const key = skill.trim().toLowerCase();
        if (key === '') continue;
        skillCounts.set(key, (skillCounts.get(key) ?? 0) + 1);
      }
    }

    const hourly = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
    for (const row of postingRows) {
      if (!row.postedAt) continue;
      hourly[row.postedAt.getUTCHours()].count += 1;
    }

    const pipeline: PipelineStats = {
      jobsSeen24h: jobs24h,
      jobsScored24h: scored24h,
      proposalsDrafted24h: drafted24h,
      submitted24h,
      pendingApproval,
      avgScore24h: round(avg24h._avg.score, 1),
    };

    log.debug({ pendingApproval, activeProfiles }, 'stats computed');

    return reply.send({
      generatedAt: now.toISOString(),
      windows: {
        today: windows[0],
        '7d': windows[1],
        '30d': windows[2],
      },
      pipeline,
      profiles: profileRows,
      activeProfiles,
      sources: sourceRows
        .map((row) => ({ source: row.source, jobs: row._count._all }))
        .sort((left, right) => right.jobs - left.jobs),
      topSkills: Array.from(skillCounts.entries())
        .map(([skill, count]) => ({ skill, count }))
        .sort((left, right) => right.count - left.count)
        .slice(0, 25),
      hourlyHistogram: {
        windowDays: parsed.data.histogramDays,
        timezone: 'UTC',
        buckets: hourly,
        sampled: postingRows.length,
      },
    });
  });
}
