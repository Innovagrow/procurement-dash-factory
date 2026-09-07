import { Prisma } from '@prisma/client';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { toErrorMessage } from '../../lib/errors';
import { child } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { FIXED_BID_STRATEGIES, PROPOSAL_TONES } from '../../proposals';
import { scoreJob } from '../../scoring';
import type { ScorableJob, ScoringProfile } from '../../scoring';
import type { Decision, ScoreResult } from '../../types';
import { emit } from '../sse';

const log = child('api:profiles');

const TEST_SAMPLE_DEFAULT = 50;
const TEST_SAMPLE_MAX = 200;

const stringList = (max = 200) =>
  z.array(z.string().trim().min(1).max(200)).max(max).default([]);

const jobTypeEnum = z.enum(['HOURLY', 'FIXED', 'UNKNOWN']);
const experienceEnum = z.enum(['ENTRY', 'INTERMEDIATE', 'EXPERT']);

/** Mirrors the Prisma Profile model, minus the generated columns. */
const profileFieldsSchema = z.object({
  name: z.string().trim().min(1).max(120),
  isActive: z.boolean().default(true),

  includeKeywords: stringList(),
  excludeKeywords: stringList(),
  requiredSkills: stringList(),
  niceToHaveSkills: stringList(),
  categories: stringList(),
  searchQueries: z.array(z.string().trim().min(1).max(500)).max(50).default([]),

  jobTypes: z.array(jobTypeEnum).max(3).default([]),
  experienceLevels: z.array(experienceEnum).max(3).default([]),
  minFixedBudget: z.number().min(0).max(10_000_000).nullable().optional(),
  maxFixedBudget: z.number().min(0).max(10_000_000).nullable().optional(),
  minHourlyRate: z.number().min(0).max(10_000).nullable().optional(),
  maxProposals: z.number().int().min(0).max(1000).nullable().optional(),
  maxJobAgeMinutes: z.number().int().min(1).max(20160).default(180),
  requirePaymentVerified: z.boolean().default(true),
  minClientSpend: z.number().min(0).max(100_000_000).nullable().optional(),
  minClientRating: z.number().min(0).max(5).nullable().optional(),
  minClientHireRate: z.number().min(0).max(1).nullable().optional(),
  minClientReviews: z.number().int().min(0).max(100_000).nullable().optional(),
  allowedCountries: stringList(300),
  blockedCountries: stringList(300),
  blockedClients: stringList(1000),

  autoBidThreshold: z.number().int().min(0).max(100).default(85),
  reviewThreshold: z.number().int().min(0).max(100).default(60),
  weights: z.record(z.number().min(0).max(1000)).nullable().optional(),
  useLlmRerank: z.boolean().default(true),

  fixedBidStrategy: z.enum(FIXED_BID_STRATEGIES).default('PERCENT_OF_BUDGET'),
  autoSubmit: z.boolean().default(false),
  hourlyRate: z.number().min(0).max(10_000).nullable().optional(),
  fixedBidPercent: z.number().min(0.1).max(3).default(0.9),
  minBid: z.number().min(0).max(1_000_000).nullable().optional(),
  maxBid: z.number().min(0).max(1_000_000).nullable().optional(),
  maxDailySubmissions: z.number().int().min(0).max(500).default(15),
  maxHourlySubmissions: z.number().int().min(0).max(200).default(5),
  maxDailyConnects: z.number().int().min(0).max(10_000).default(120),

  freelancerProfile: z.string().max(20000).nullable().optional(),
  portfolioHighlights: z.array(z.string().trim().min(1).max(1000)).max(50).default([]),
  proposalTone: z.enum(PROPOSAL_TONES).default('professional'),
  proposalMaxChars: z.number().int().min(300).max(5000).default(1500),
  proposalLanguage: z.string().trim().min(2).max(32).default('en'),
  customInstructions: z.string().max(8000).nullable().optional(),
});

const profileCreateSchema = profileFieldsSchema.superRefine((value, ctx) => {
  if (value.reviewThreshold > value.autoBidThreshold) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reviewThreshold'],
      message: 'reviewThreshold must be lower than or equal to autoBidThreshold',
    });
  }
});

const profileUpdateSchema = profileFieldsSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: 'provide at least one field to update' },
);

const idParamsSchema = z.object({ id: z.string().trim().min(1).max(64) });

const toggleBodySchema = z.object({ isActive: z.boolean().optional() }).default({});

const testBodySchema = z
  .object({
    limit: z.number().int().min(1).max(TEST_SAMPLE_MAX).default(TEST_SAMPLE_DEFAULT),
    source: z.string().trim().min(1).max(64).optional(),
    overrides: profileFieldsSchema.partial().optional(),
  })
  .default({ limit: TEST_SAMPLE_DEFAULT });

type ProfileFields = z.infer<typeof profileFieldsSchema>;
type ProfileUpdate = z.infer<typeof profileUpdateSchema>;

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'P2002'
  );
}

function isMissingRow(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2025'
  );
}

function weightsForPrisma(
  weights: Record<string, number> | null | undefined,
): Prisma.InputJsonValue | typeof Prisma.DbNull | undefined {
  if (weights === undefined) return undefined;
  if (weights === null) return Prisma.DbNull;
  return weights as Prisma.InputJsonObject;
}

/** Merges request overrides onto a stored row to form the candidate scorer view. */
function candidateProfile(
  stored: {
    id: string;
    name: string;
    includeKeywords: string[];
    excludeKeywords: string[];
    requiredSkills: string[];
    niceToHaveSkills: string[];
    categories: string[];
    jobTypes: string[];
    experienceLevels: string[];
    minFixedBudget: number | null;
    maxFixedBudget: number | null;
    minHourlyRate: number | null;
    maxProposals: number | null;
    maxJobAgeMinutes: number;
    requirePaymentVerified: boolean;
    minClientSpend: number | null;
    minClientRating: number | null;
    minClientHireRate: number | null;
    minClientReviews: number | null;
    allowedCountries: string[];
    blockedCountries: string[];
    blockedClients: string[];
    autoBidThreshold: number;
    reviewThreshold: number;
    weights: Prisma.JsonValue;
    useLlmRerank: boolean;
    hourlyRate: number | null;
    freelancerProfile: string | null;
    portfolioHighlights: string[];
  },
  overrides: ProfileUpdate | undefined,
): ScoringProfile {
  const pick = <K extends keyof ProfileFields>(key: K, fallback: unknown): unknown => {
    const value = overrides ? (overrides as Record<string, unknown>)[key as string] : undefined;
    return value === undefined ? fallback : value;
  };

  return {
    id: stored.id,
    name: (pick('name', stored.name) as string) ?? stored.name,
    includeKeywords: pick('includeKeywords', stored.includeKeywords) as string[],
    excludeKeywords: pick('excludeKeywords', stored.excludeKeywords) as string[],
    requiredSkills: pick('requiredSkills', stored.requiredSkills) as string[],
    niceToHaveSkills: pick('niceToHaveSkills', stored.niceToHaveSkills) as string[],
    categories: pick('categories', stored.categories) as string[],
    jobTypes: pick('jobTypes', stored.jobTypes) as string[],
    experienceLevels: pick('experienceLevels', stored.experienceLevels) as string[],
    minFixedBudget: pick('minFixedBudget', stored.minFixedBudget) as number | null,
    maxFixedBudget: pick('maxFixedBudget', stored.maxFixedBudget) as number | null,
    minHourlyRate: pick('minHourlyRate', stored.minHourlyRate) as number | null,
    maxProposals: pick('maxProposals', stored.maxProposals) as number | null,
    maxJobAgeMinutes: pick('maxJobAgeMinutes', stored.maxJobAgeMinutes) as number,
    requirePaymentVerified: pick('requirePaymentVerified', stored.requirePaymentVerified) as boolean,
    minClientSpend: pick('minClientSpend', stored.minClientSpend) as number | null,
    minClientRating: pick('minClientRating', stored.minClientRating) as number | null,
    minClientHireRate: pick('minClientHireRate', stored.minClientHireRate) as number | null,
    minClientReviews: pick('minClientReviews', stored.minClientReviews) as number | null,
    allowedCountries: pick('allowedCountries', stored.allowedCountries) as string[],
    blockedCountries: pick('blockedCountries', stored.blockedCountries) as string[],
    blockedClients: pick('blockedClients', stored.blockedClients) as string[],
    autoBidThreshold: pick('autoBidThreshold', stored.autoBidThreshold) as number,
    reviewThreshold: pick('reviewThreshold', stored.reviewThreshold) as number,
    weights: overrides && overrides.weights !== undefined ? overrides.weights : stored.weights,
    useLlmRerank: pick('useLlmRerank', stored.useLlmRerank) as boolean,
    hourlyRate: pick('hourlyRate', stored.hourlyRate) as number | null,
    freelancerProfile: pick('freelancerProfile', stored.freelancerProfile) as string | null,
    portfolioHighlights: pick('portfolioHighlights', stored.portfolioHighlights) as string[],
  };
}

function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)));
  return sorted[index];
}

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

export default async function profileRoutes(app: FastifyInstance): Promise<void> {
  app.get('/profiles', async (_request, reply) => {
    const profiles = await prisma.profile.findMany({
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      include: { _count: { select: { jobs: true, proposals: true } } },
    });
    return reply.send({ items: profiles, count: profiles.length });
  });

  app.get('/profiles/:id', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params ?? {});
    if (!params.success) {
      return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'invalid profile id' } });
    }

    const profile = await prisma.profile.findUnique({
      where: { id: params.data.id },
      include: { _count: { select: { jobs: true, proposals: true } } },
    });
    if (!profile) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'profile not found' } });
    }
    return reply.send({ profile });
  });

  app.post('/profiles', async (request, reply) => {
    const body = profileCreateSchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({
        error: {
          code: 'BAD_REQUEST',
          message: 'invalid profile',
          issues: body.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        },
      });
    }

    const { weights, ...rest } = body.data;
    const data: Prisma.ProfileCreateInput = { ...rest };
    const json = weightsForPrisma(weights);
    if (json !== undefined) data.weights = json;

    try {
      const profile = await prisma.profile.create({ data });
      log.info({ profileId: profile.id, name: profile.name }, 'profile created');
      emit('profile.created', { profileId: profile.id, name: profile.name });
      return reply.code(201).send({ profile });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return reply
          .code(409)
          .send({ error: { code: 'CONFLICT', message: 'a profile with that name already exists' } });
      }
      throw err;
    }
  });

  const updateHandler = async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const params = idParamsSchema.safeParse(request.params ?? {});
    if (!params.success) {
      return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'invalid profile id' } });
    }

    const body = profileUpdateSchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({
        error: {
          code: 'BAD_REQUEST',
          message: 'invalid profile update',
          issues: body.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        },
      });
    }

    const { weights, ...rest } = body.data;
    const data: Prisma.ProfileUpdateInput = { ...rest };
    const json = weightsForPrisma(weights);
    if (json !== undefined) data.weights = json;

    try {
      const profile = await prisma.profile.update({ where: { id: params.data.id }, data });
      log.info({ profileId: profile.id, fields: Object.keys(body.data) }, 'profile updated');
      emit('profile.updated', { profileId: profile.id, name: profile.name });
      return reply.send({ profile });
    } catch (err) {
      if (isMissingRow(err)) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'profile not found' } });
      }
      if (isUniqueViolation(err)) {
        return reply
          .code(409)
          .send({ error: { code: 'CONFLICT', message: 'a profile with that name already exists' } });
      }
      throw err;
    }
  };

  app.put('/profiles/:id', updateHandler);
  app.patch('/profiles/:id', updateHandler);

  app.delete('/profiles/:id', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params ?? {});
    if (!params.success) {
      return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'invalid profile id' } });
    }

    try {
      const profile = await prisma.profile.delete({
        where: { id: params.data.id },
        select: { id: true, name: true },
      });
      log.warn({ profileId: profile.id, name: profile.name }, 'profile deleted');
      emit('profile.deleted', { profileId: profile.id, name: profile.name });
      return reply.code(200).send({ deleted: true, profile });
    } catch (err) {
      if (isMissingRow(err)) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'profile not found' } });
      }
      throw err;
    }
  });

  app.post('/profiles/:id/toggle', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params ?? {});
    if (!params.success) {
      return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'invalid profile id' } });
    }
    const body = toggleBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'invalid body' } });
    }

    const current = await prisma.profile.findUnique({
      where: { id: params.data.id },
      select: { id: true, isActive: true, name: true },
    });
    if (!current) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'profile not found' } });
    }

    const isActive = body.data.isActive ?? !current.isActive;
    const profile = await prisma.profile.update({
      where: { id: current.id },
      data: { isActive },
      select: { id: true, name: true, isActive: true },
    });

    log.info({ profileId: profile.id, isActive: profile.isActive }, 'profile toggled');
    emit('profile.toggled', { profileId: profile.id, isActive: profile.isActive });

    return reply.send({ profile });
  });

  /**
   * Dry-run tuning: scores recent postings against a candidate profile with the
   * pure rules engine. Nothing is written and no LLM call is made, so the
   * operator can iterate on filters as fast as they can click.
   */
  app.post('/profiles/:id/test', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params ?? {});
    if (!params.success) {
      return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'invalid profile id' } });
    }

    const body = testBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({
        error: {
          code: 'BAD_REQUEST',
          message: 'invalid test request',
          issues: body.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        },
      });
    }

    const stored = await prisma.profile.findUnique({ where: { id: params.data.id } });
    if (!stored) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'profile not found' } });
    }

    const candidate = candidateProfile(stored, body.data.overrides);
    const jobs = await prisma.job.findMany({
      where: body.data.source ? { source: body.data.source } : {},
      orderBy: { firstSeenAt: 'desc' },
      take: body.data.limit,
    });

    const existing = await prisma.jobProfileMatch.findMany({
      where: { profileId: stored.id, jobId: { in: jobs.map((job) => job.id) } },
      select: { jobId: true, score: true, decision: true },
    });
    const previous = new Map(existing.map((row) => [row.jobId, row]));

    const reference = new Date();
    const decisions: Record<Decision, number> = { BID: 0, REVIEW: 0, SKIP: 0 };
    const histogram = Array.from({ length: 10 }, (_, index) => ({
      bucket: `${index * 10}-${index * 10 + 9}`,
      count: 0,
    }));
    const hardFilters = new Map<string, number>();
    const scores: number[] = [];

    const results = jobs.map((job) => {
      const scorable: ScorableJob = job;
      let result: ScoreResult;
      try {
        result = scoreJob(scorable, candidate, { reference });
      } catch (err) {
        log.warn({ err: toErrorMessage(err), jobId: job.id }, 'test scoring failed for a job');
        return null;
      }

      decisions[result.decision] += 1;
      scores.push(result.score);
      const slot = Math.min(9, Math.max(0, Math.floor(result.score / 10)));
      histogram[slot].count += 1;
      for (const failure of result.hardFilterFailures) {
        hardFilters.set(failure, (hardFilters.get(failure) ?? 0) + 1);
      }

      const before = previous.get(job.id) ?? null;
      return {
        jobId: job.id,
        title: job.title,
        url: job.url,
        source: job.source,
        postedAt: job.postedAt,
        score: result.score,
        decision: result.decision,
        reasons: result.reasons.slice(0, 4),
        hardFilterFailures: result.hardFilterFailures,
        redFlags: result.redFlags,
        matchedKeywords: result.matchedKeywords,
        matchedSkills: result.matchedSkills,
        previousScore: before ? before.score : null,
        previousDecision: before ? before.decision : null,
      };
    });

    const scored = results.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    const sorted = [...scores].sort((left, right) => left - right);
    const total = scores.reduce((sum, value) => sum + value, 0);

    return reply.send({
      profileId: stored.id,
      sampleSize: scored.length,
      requestedLimit: body.data.limit,
      thresholds: {
        autoBid: candidate.autoBidThreshold ?? stored.autoBidThreshold,
        review: candidate.reviewThreshold ?? stored.reviewThreshold,
      },
      decisions,
      scores: {
        min: sorted.length > 0 ? sorted[0] : null,
        max: sorted.length > 0 ? sorted[sorted.length - 1] : null,
        avg: scored.length > 0 ? Math.round((total / scored.length) * 10) / 10 : null,
        median: median(sorted),
        p90: percentile(sorted, 0.9),
      },
      histogram,
      hardFilters: Array.from(hardFilters.entries())
        .map(([reason, count]) => ({ reason, count }))
        .sort((left, right) => right.count - left.count)
        .slice(0, 20),
      top: [...scored].sort((left, right) => right.score - left.score).slice(0, 10),
      items: scored,
    });
  });
}
