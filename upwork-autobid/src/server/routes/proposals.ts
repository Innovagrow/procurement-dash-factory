import type { Prisma } from '@prisma/client';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { toErrorMessage } from '../../lib/errors';
import { child } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { PRIORITY, addDraftJob } from '../../queue/queues';
import { approveProposal, rejectProposal } from '../../submit';
import { PROPOSAL_STATUS } from '../../types';
import { emit } from '../sse';

const log = child('api:proposals');

const MAX_PAGE_SIZE = 100;

/** Statuses whose text is live or already sent; editing them is refused. */
const FROZEN = new Set<string>(['SUBMITTING', 'SUBMITTED']);

const listQuerySchema = z.object({
  status: z.string().trim().min(1).max(32).optional(),
  profileId: z.string().trim().min(1).max(64).optional(),
  jobId: z.string().trim().min(1).max(64).optional(),
  editedByHuman: z.enum(['true', 'false']).optional(),
  since: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
  cursor: z.string().trim().min(1).max(512).optional(),
});

const idParamsSchema = z.object({ id: z.string().trim().min(1).max(64) });

const patchBodySchema = z
  .object({
    coverLetter: z.string().min(1).max(20000).optional(),
    bidAmount: z.number().min(0).max(1_000_000).nullable().optional(),
    hourlyRate: z.number().min(0).max(10_000).nullable().optional(),
    estimatedDurationLabel: z.string().max(120).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'provide at least one of coverLetter, bidAmount, hourlyRate, estimatedDurationLabel',
  });

const rejectBodySchema = z
  .object({ reason: z.string().trim().max(500).optional(), actor: z.string().trim().max(120).optional() })
  .default({});

const approveBodySchema = z
  .object({ actor: z.string().trim().max(120).optional() })
  .default({});

interface Cursor {
  createdAt: Date;
  id: string;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.createdAt.toISOString()}|${cursor.id}`, 'utf8').toString('base64url');
}

function decodeCursor(raw: string): Cursor | null {
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const separator = decoded.lastIndexOf('|');
    if (separator === -1) return null;
    const date = new Date(decoded.slice(0, separator));
    const id = decoded.slice(separator + 1);
    if (Number.isNaN(date.getTime()) || id === '') return null;
    return { createdAt: date, id };
  } catch {
    return null;
  }
}

function actorOf(request: FastifyRequest, fallback?: string): string {
  const header = request.headers['x-actor'];
  if (typeof header === 'string' && header.trim() !== '') return header.trim().slice(0, 120);
  if (fallback && fallback !== '') return fallback;
  return 'dashboard';
}

const PROPOSAL_LIST_SELECT = {
  id: true,
  jobId: true,
  profileId: true,
  status: true,
  bidAmount: true,
  hourlyRate: true,
  estimatedDurationLabel: true,
  connectsCost: true,
  model: true,
  editedByHuman: true,
  warnings: true,
  generationMs: true,
  createdAt: true,
  updatedAt: true,
  approvedAt: true,
  approvedBy: true,
  rejectedAt: true,
  rejectionReason: true,
  profile: { select: { id: true, name: true } },
  job: {
    select: {
      id: true,
      title: true,
      url: true,
      source: true,
      jobType: true,
      budgetAmount: true,
      hourlyMin: true,
      hourlyMax: true,
      connectsRequired: true,
      postedAt: true,
    },
  },
} satisfies Prisma.ProposalSelect;

export default async function proposalRoutes(app: FastifyInstance): Promise<void> {
  app.get('/proposals', async (request, reply) => {
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
    const where: Prisma.ProposalWhereInput = {};

    if (query.status) {
      const wanted = query.status
        .split(',')
        .map((entry) => entry.trim().toUpperCase())
        .filter((entry) => (PROPOSAL_STATUS as readonly string[]).includes(entry));
      if (wanted.length === 0) {
        return reply
          .code(400)
          .send({ error: { code: 'BAD_REQUEST', message: 'unknown proposal status filter' } });
      }
      where.status = wanted.length === 1 ? wanted[0] : { in: wanted };
    }
    if (query.profileId) where.profileId = query.profileId;
    if (query.jobId) where.jobId = query.jobId;
    if (query.editedByHuman) where.editedByHuman = query.editedByHuman === 'true';
    if (query.since) where.createdAt = { gte: query.since };

    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      if (!cursor) {
        return reply.code(400).send({ error: { code: 'BAD_CURSOR', message: 'cursor is not valid' } });
      }
      where.AND = [
        {
          OR: [
            { createdAt: { lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { lt: cursor.id } },
          ],
        },
      ];
    }

    const rows = await prisma.proposal.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      select: PROPOSAL_LIST_SELECT,
    });

    const hasMore = rows.length > query.limit;
    const items = hasMore ? rows.slice(0, query.limit) : rows;
    const last = items.at(-1);

    return reply.send({
      items,
      count: items.length,
      hasMore,
      nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
    });
  });

  app.get('/proposals/:id', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params ?? {});
    if (!params.success) {
      return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'invalid proposal id' } });
    }

    const proposal = await prisma.proposal.findUnique({
      where: { id: params.data.id },
      include: {
        profile: { select: { id: true, name: true, hourlyRate: true, autoSubmit: true } },
        job: true,
        submissions: { orderBy: { createdAt: 'desc' } },
      },
    });

    if (!proposal) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'proposal not found' } });
    }

    const match = await prisma.jobProfileMatch.findUnique({
      where: { jobId_profileId: { jobId: proposal.jobId, profileId: proposal.profileId } },
    });

    return reply.send({ proposal, match });
  });

  app.patch('/proposals/:id', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params ?? {});
    if (!params.success) {
      return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'invalid proposal id' } });
    }

    const body = patchBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({
        error: {
          code: 'BAD_REQUEST',
          message: 'invalid body',
          issues: body.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        },
      });
    }

    const existing = await prisma.proposal.findUnique({
      where: { id: params.data.id },
      select: { id: true, status: true, jobId: true, profileId: true },
    });
    if (!existing) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'proposal not found' } });
    }
    if (FROZEN.has(existing.status)) {
      return reply.code(409).send({
        error: {
          code: 'CONFLICT',
          message: `proposal is ${existing.status} and can no longer be edited`,
        },
      });
    }

    const data: Prisma.ProposalUpdateInput = { editedByHuman: true };
    if (body.data.coverLetter !== undefined) data.coverLetter = body.data.coverLetter;
    if (body.data.bidAmount !== undefined) data.bidAmount = body.data.bidAmount;
    if (body.data.hourlyRate !== undefined) data.hourlyRate = body.data.hourlyRate;
    if (body.data.estimatedDurationLabel !== undefined) {
      data.estimatedDurationLabel = body.data.estimatedDurationLabel;
    }

    // An edit invalidates a prior approval: the operator approved other text.
    if (existing.status === 'APPROVED') {
      data.status = 'PENDING_APPROVAL';
      data.approvedAt = null;
      data.approvedBy = null;
    }

    const proposal = await prisma.proposal.update({
      where: { id: existing.id },
      data,
      select: PROPOSAL_LIST_SELECT,
    });

    const actor = actorOf(request);
    await writeAudit('proposal.edited', proposal.id, actor, {
      fields: Object.keys(body.data),
      previousStatus: existing.status,
    });

    log.info({ proposalId: proposal.id, actor }, 'proposal edited by a human');
    emit('proposal.updated', { proposalId: proposal.id, status: proposal.status });

    return reply.send({ proposal });
  });

  app.post('/proposals/:id/approve', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params ?? {});
    if (!params.success) {
      return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'invalid proposal id' } });
    }
    const body = approveBodySchema.safeParse(request.body ?? {});
    const actor = actorOf(request, body.success ? body.data.actor : undefined);

    const outcome = await approveProposal(params.data.id, actor);
    emit('proposal.approved', {
      proposalId: outcome.proposalId,
      status: outcome.status,
      ok: outcome.ok,
    });

    if (!outcome.ok && outcome.status === 'UNKNOWN') {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: outcome.message } });
    }
    return reply.code(outcome.ok ? 200 : 409).send(outcome);
  });

  app.post('/proposals/:id/reject', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params ?? {});
    if (!params.success) {
      return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'invalid proposal id' } });
    }
    const body = rejectBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'invalid body' } });
    }
    const actor = actorOf(request, body.data.actor);

    const outcome = await rejectProposal(params.data.id, actor, body.data.reason);
    emit('proposal.rejected', {
      proposalId: outcome.proposalId,
      status: outcome.status,
      ok: outcome.ok,
    });

    if (!outcome.ok && outcome.status === 'UNKNOWN') {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: outcome.message } });
    }
    return reply.code(outcome.ok ? 200 : 409).send(outcome);
  });

  app.post('/proposals/:id/regenerate', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params ?? {});
    if (!params.success) {
      return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'invalid proposal id' } });
    }

    const existing = await prisma.proposal.findUnique({
      where: { id: params.data.id },
      select: { id: true, jobId: true, profileId: true, status: true },
    });
    if (!existing) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'proposal not found' } });
    }
    if (FROZEN.has(existing.status)) {
      return reply.code(409).send({
        error: {
          code: 'CONFLICT',
          message: `proposal is ${existing.status} and cannot be regenerated`,
        },
      });
    }

    const actor = actorOf(request);

    // The drafter refuses to touch a job that already has a live proposal, so the
    // old row is retired first. Its text stays in the database for the audit trail.
    await prisma.proposal.update({
      where: { id: existing.id },
      data: {
        status: 'EXPIRED',
        rejectionReason: `superseded by a regenerate requested by ${actor}`,
      },
    });

    const queueJobId = await addDraftJob(
      { jobId: existing.jobId, profileId: existing.profileId },
      { jobId: null, priority: PRIORITY.hot },
    );

    await writeAudit('proposal.regenerate', existing.id, actor, {
      previousStatus: existing.status,
      queueJobId,
    });

    log.info({ proposalId: existing.id, actor, queueJobId }, 'proposal regeneration enqueued');
    emit('proposal.regenerate', { proposalId: existing.id, jobId: existing.jobId });

    return reply.code(202).send({
      ok: true,
      proposalId: existing.id,
      jobId: existing.jobId,
      profileId: existing.profileId,
      queueJobId,
      message: 'a fresh draft was queued; the new proposal appears when the worker finishes',
    });
  });
}

async function writeAudit(
  action: string,
  proposalId: string,
  actor: string,
  details: Prisma.InputJsonObject,
): Promise<void> {
  try {
    await prisma.auditEvent.create({
      data: { actor, action, refType: 'proposal', refId: proposalId, details },
    });
  } catch (err) {
    // The mutation is already committed; a missing audit row must not 500 the call.
    log.warn({ err: toErrorMessage(err), action, proposalId }, 'failed to write audit event');
  }
}
