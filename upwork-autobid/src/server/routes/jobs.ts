import type { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { child } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { PRIORITY, addScoreJob } from '../../queue/queues';
import { emit } from '../sse';

const log = child('api:jobs');

const MAX_PAGE_SIZE = 100;

const listQuerySchema = z.object({
  status: z.string().trim().min(1).max(32).optional(),
  decision: z.enum(['BID', 'REVIEW', 'SKIP']).optional(),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  maxScore: z.coerce.number().int().min(0).max(100).optional(),
  source: z.string().trim().min(1).max(64).optional(),
  profileId: z.string().trim().min(1).max(64).optional(),
  q: z.string().trim().min(1).max(200).optional(),
  since: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
  cursor: z.string().trim().min(1).max(512).optional(),
});

const idParamsSchema = z.object({ id: z.string().trim().min(1).max(64) });

const rescoreBodySchema = z
  .object({ profileId: z.string().trim().min(1).max(64).optional() })
  .default({});

interface Cursor {
  firstSeenAt: Date;
  id: string;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.firstSeenAt.toISOString()}|${cursor.id}`, 'utf8').toString('base64url');
}

function decodeCursor(raw: string): Cursor | null {
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const separator = decoded.lastIndexOf('|');
    if (separator === -1) return null;
    const date = new Date(decoded.slice(0, separator));
    const id = decoded.slice(separator + 1);
    if (Number.isNaN(date.getTime()) || id === '') return null;
    return { firstSeenAt: date, id };
  } catch {
    return null;
  }
}

const JOB_LIST_SELECT = {
  id: true,
  source: true,
  externalId: true,
  url: true,
  title: true,
  skills: true,
  category: true,
  jobType: true,
  budgetAmount: true,
  hourlyMin: true,
  hourlyMax: true,
  currency: true,
  experienceLevel: true,
  connectsRequired: true,
  proposalsCount: true,
  interviewingCount: true,
  clientCountry: true,
  clientPaymentVerified: true,
  clientTotalSpent: true,
  clientAvgRating: true,
  clientHireRate: true,
  postedAt: true,
  firstSeenAt: true,
  lastSeenAt: true,
  status: true,
} satisfies Prisma.JobSelect;

const MATCH_SELECT = {
  id: true,
  profileId: true,
  score: true,
  decision: true,
  reasons: true,
  matchedKeywords: true,
  matchedSkills: true,
  llmScore: true,
  llmRationale: true,
  scoredAt: true,
  redFlags: true,
  profile: { select: { id: true, name: true } },
} satisfies Prisma.JobProfileMatchSelect;

function buildMatchFilter(
  query: z.infer<typeof listQuerySchema>,
): Prisma.JobProfileMatchWhereInput | null {
  const filter: Prisma.JobProfileMatchWhereInput = {};
  let used = false;

  if (query.profileId) {
    filter.profileId = query.profileId;
    used = true;
  }
  if (query.decision) {
    filter.decision = query.decision;
    used = true;
  }
  if (query.minScore !== undefined || query.maxScore !== undefined) {
    const score: Prisma.IntFilter = {};
    if (query.minScore !== undefined) score.gte = query.minScore;
    if (query.maxScore !== undefined) score.lte = query.maxScore;
    filter.score = score;
    used = true;
  }

  return used ? filter : null;
}

export default async function jobRoutes(app: FastifyInstance): Promise<void> {
  app.get('/jobs', async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: 'BAD_REQUEST',
          message: 'invalid query parameters',
          issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        },
      });
    }

    const query = parsed.data;
    const where: Prisma.JobWhereInput = {};

    if (query.status) where.status = query.status.toUpperCase();
    if (query.source) where.source = query.source;
    if (query.since) where.firstSeenAt = { gte: query.since };
    if (query.q) {
      where.OR = [
        { title: { contains: query.q, mode: 'insensitive' } },
        { description: { contains: query.q, mode: 'insensitive' } },
      ];
    }

    const matchFilter = buildMatchFilter(query);
    if (matchFilter) where.matches = { some: matchFilter };

    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      if (!cursor) {
        return reply.code(400).send({ error: { code: 'BAD_CURSOR', message: 'cursor is not valid' } });
      }
      where.AND = [
        {
          OR: [
            { firstSeenAt: { lt: cursor.firstSeenAt } },
            { firstSeenAt: cursor.firstSeenAt, id: { lt: cursor.id } },
          ],
        },
      ];
    }

    // One extra row tells us whether another page exists without a second count.
    const rows = await prisma.job.findMany({
      where,
      orderBy: [{ firstSeenAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      select: {
        ...JOB_LIST_SELECT,
        matches: {
          where: matchFilter ?? {},
          orderBy: { score: 'desc' },
          take: 1,
          select: MATCH_SELECT,
        },
      },
    });

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const last = page.at(-1);

    const items = page.map(({ matches, ...job }) => ({
      ...job,
      bestMatch: matches[0] ?? null,
    }));

    return reply.send({
      items,
      count: items.length,
      hasMore,
      nextCursor:
        hasMore && last ? encodeCursor({ firstSeenAt: last.firstSeenAt, id: last.id }) : null,
    });
  });

  app.get('/jobs/:id', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params ?? {});
    if (!params.success) {
      return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'invalid job id' } });
    }

    const job = await prisma.job.findUnique({
      where: { id: params.data.id },
      include: {
        matches: {
          orderBy: { score: 'desc' },
          select: { ...MATCH_SELECT, breakdown: true },
        },
        proposals: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            profileId: true,
            status: true,
            bidAmount: true,
            hourlyRate: true,
            estimatedDurationLabel: true,
            connectsCost: true,
            model: true,
            editedByHuman: true,
            warnings: true,
            createdAt: true,
            updatedAt: true,
            approvedAt: true,
            rejectedAt: true,
            rejectionReason: true,
            profile: { select: { id: true, name: true } },
            submissions: {
              orderBy: { createdAt: 'desc' },
              take: 5,
              select: {
                id: true,
                submitter: true,
                status: true,
                externalRef: true,
                message: true,
                attempt: true,
                connectsSpent: true,
                createdAt: true,
              },
            },
          },
        },
      },
    });

    if (!job) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'job not found' } });
    }

    return reply.send({ job });
  });

  app.post('/jobs/:id/rescore', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params ?? {});
    if (!params.success) {
      return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'invalid job id' } });
    }

    const body = rescoreBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'invalid body' } });
    }

    const job = await prisma.job.findUnique({
      where: { id: params.data.id },
      select: { id: true, contentHash: true, title: true },
    });
    if (!job) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'job not found' } });
    }

    const profiles = body.data.profileId
      ? await prisma.profile.findMany({
          where: { id: body.data.profileId },
          select: { id: true, name: true },
        })
      : await prisma.profile.findMany({
          where: { isActive: true },
          select: { id: true, name: true },
        });

    if (profiles.length === 0) {
      return reply.code(409).send({
        error: {
          code: 'NO_PROFILE',
          message: body.data.profileId ? 'profile not found' : 'no active profile to score against',
        },
      });
    }

    const enqueued: { profileId: string; profileName: string; queueJobId: string | null }[] = [];
    for (const profile of profiles) {
      // jobId:null bypasses the content-hash dedupe id: a manual rescore must run
      // even though the same (job, profile, hash) triple already went through.
      const queueJobId = await addScoreJob(
        { jobId: job.id, profileId: profile.id },
        { jobId: null, priority: PRIORITY.hot },
      );
      enqueued.push({ profileId: profile.id, profileName: profile.name, queueJobId });
    }

    log.info({ jobId: job.id, profiles: enqueued.length }, 'manual rescore enqueued');
    emit('job.rescore', { jobId: job.id, title: job.title, profiles: enqueued.length });

    return reply.code(202).send({ jobId: job.id, enqueued });
  });
}
