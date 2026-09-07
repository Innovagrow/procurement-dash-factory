import type { Prisma } from '@prisma/client';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { child } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import {
  PROPOSAL_TONES,
  TEMPLATE_SLOTS,
  computeBid,
  deriveTemplateVars,
  diffTemplateSlots,
  extractSlots,
  invalidateTemplateCache,
} from '../../proposals';
import type { DraftJob, DraftProfile, TemplateVars } from '../../proposals';
import { emit } from '../sse';

const log = child('api:templates');

const MAX_NAME_CHARS = 120;
const MAX_BODY_CHARS = 20_000;
const MAX_VARIABLES = 60;

/** Upper bound on the "(copy N)" scan when duplicating. */
const MAX_COPY_ATTEMPTS = 50;

const jobTypeEnum = z.enum(['HOURLY', 'FIXED', 'UNKNOWN']);

/**
 * A declared variable has to be addressable as {{name}}, and the slot parser
 * only recognises [a-zA-Z0-9_], so anything else could never be filled.
 */
const variableName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_]+$/, 'may only contain letters, digits and underscores');

/** Mirrors the Prisma Template model, minus the generated and counter columns. */
const templateFieldsSchema = z.object({
  name: z.string().trim().min(1).max(MAX_NAME_CHARS),
  description: z.string().trim().max(500).nullable().optional(),
  // Empty means "any job type", the same convention the Profile filters use.
  jobTypes: z.array(jobTypeEnum).max(3).default([]),
  tone: z.enum(PROPOSAL_TONES).default('professional'),
  categories: z.array(z.string().trim().min(1).max(200)).max(200).default([]),
  minScore: z.number().int().min(0).max(100).nullable().optional(),
  body: z.string().trim().min(1).max(MAX_BODY_CHARS),
  variables: z.array(variableName).max(MAX_VARIABLES).default([]),
  notes: z.string().trim().max(8000).nullable().optional(),
  isDefault: z.boolean().default(false),
  isActive: z.boolean().default(true),
});

const templateCreateSchema = templateFieldsSchema;

const templateUpdateSchema = templateFieldsSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'provide at least one field to update',
  });

const idParamsSchema = z.object({ id: z.string().trim().min(1).max(64) });

const toggleBodySchema = z.object({ isActive: z.boolean().optional() }).default({});

const previewBodySchema = z.object({
  body: z.string().trim().min(1).max(MAX_BODY_CHARS),
  variables: z.array(variableName).max(MAX_VARIABLES).default([]),
  jobId: z.string().trim().min(1).max(64).optional(),
});

type TemplateFields = z.infer<typeof templateFieldsSchema>;

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}

function isMissingRow(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2025';
}

function invalidBody(reply: FastifyReply, message: string, error: z.ZodError): FastifyReply {
  return reply.code(400).send({
    error: {
      code: 'BAD_REQUEST',
      message,
      issues: error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    },
  });
}

function dedupe(values: string[]): string[] {
  const seen: string[] = [];
  for (const value of values) {
    if (!seen.includes(value)) seen.push(value);
  }
  return seen;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/**
 * The body and the declared variable list must describe the same set of slots.
 * A slot with no declaration never gets a value at draft time; a declaration
 * with no slot silently does nothing. Both are named explicitly so the operator
 * can fix them without hunting through the body.
 */
function slotIssues(body: string, variables: string[]): string[] {
  const { undeclared, unused } = diffTemplateSlots(body, variables);

  const issues: string[] = [];
  if (undeclared.length > 0) {
    issues.push(
      `variables: ${undeclared.map((slot) => `{{${slot}}}`).join(', ')} ${plural(
        undeclared.length,
        'is used in the body but is not declared',
        'are used in the body but are not declared',
      )}`,
    );
  }
  if (unused.length > 0) {
    issues.push(
      `variables: ${unused.join(', ')} ${plural(
        unused.length,
        'is declared but never used in the body',
        'are declared but never used in the body',
      )}`,
    );
  }
  return issues;
}

function slotMismatch(reply: FastifyReply, issues: string[]): FastifyReply {
  return reply.code(400).send({
    error: {
      code: 'TEMPLATE_SLOT_MISMATCH',
      message: 'the template body and its declared variables do not match',
      issues,
    },
  });
}

/* ------------------------------------------------------------------ usage */

interface TemplateUsage {
  timesUsed: number;
  lastUsedAt: Date | null;
  /** Share of all recorded uses, or null while nothing has been drafted yet. */
  sharePercent: number | null;
}

interface UsageRow {
  timesUsed: number;
  lastUsedAt: Date | null;
}

function usageOf(row: UsageRow, totalUses: number): TemplateUsage {
  return {
    timesUsed: row.timesUsed,
    lastUsedAt: row.lastUsedAt,
    sharePercent: totalUses > 0 ? Math.round((row.timesUsed / totalUses) * 1000) / 10 : null,
  };
}

/* -------------------------------------------------------------- persistence */

type TemplateWriteData = Omit<Prisma.TemplateCreateInput, 'id' | 'createdAt' | 'updatedAt'>;

function createDataFrom(fields: TemplateFields): TemplateWriteData {
  return {
    name: fields.name,
    description: fields.description ?? null,
    jobTypes: fields.jobTypes,
    tone: fields.tone,
    categories: fields.categories,
    minScore: fields.minScore ?? null,
    body: fields.body,
    variables: dedupe(fields.variables),
    notes: fields.notes ?? null,
    isDefault: fields.isDefault,
    isActive: fields.isActive,
  };
}

function updateDataFrom(fields: Partial<TemplateFields>): Prisma.TemplateUpdateInput {
  const data: Prisma.TemplateUpdateInput = {};
  if (fields.name !== undefined) data.name = fields.name;
  if (fields.description !== undefined) data.description = fields.description;
  if (fields.jobTypes !== undefined) data.jobTypes = fields.jobTypes;
  if (fields.tone !== undefined) data.tone = fields.tone;
  if (fields.categories !== undefined) data.categories = fields.categories;
  if (fields.minScore !== undefined) data.minScore = fields.minScore;
  if (fields.body !== undefined) data.body = fields.body;
  if (fields.variables !== undefined) data.variables = dedupe(fields.variables);
  if (fields.notes !== undefined) data.notes = fields.notes;
  if (fields.isDefault !== undefined) data.isDefault = fields.isDefault;
  if (fields.isActive !== undefined) data.isActive = fields.isActive;
  return data;
}

/* ------------------------------------------------------------------ preview */

/**
 * Stand-in posting for the live preview when no job id is supplied. It carries
 * every field the slot derivation reads, so a preview looks like a real draft
 * even on a fresh install with an empty jobs table.
 */
function sampleJob(): DraftJob {
  return {
    id: 'sample',
    source: 'sample',
    externalId: 'sample-job',
    url: 'https://www.upwork.com/jobs/~sample',
    title: 'Build a Node.js integration between our CRM and Postgres warehouse',
    description:
      'We sync deals from our CRM into Postgres every night with a script that keeps breaking. ' +
      'We need a reliable integration: incremental sync, retries, alerting when a run fails, and ' +
      'a short handover doc so our team can maintain it. The current script is TypeScript on Node 20.',
    skills: ['Node.js', 'TypeScript', 'PostgreSQL', 'API Integration', 'ETL'],
    category: 'Web, Mobile & Software Dev',
    subcategory: 'Scripts & Utilities',
    jobType: 'FIXED',
    budgetAmount: 2500,
    currency: 'USD',
    durationLabel: '1 to 3 months',
    experienceLevel: 'EXPERT',
    workload: 'Less than 30 hrs/week',
    connectsRequired: 8,
    proposalsCount: 6,
    interviewingCount: 1,
    clientCountry: 'United States',
    clientPaymentVerified: true,
    clientTotalSpent: 48000,
    clientTotalHires: 19,
    clientHireRate: 0.72,
    clientAvgRating: 4.9,
    clientReviewsCount: 31,
    clientOpenJobs: 2,
    screeningQuestions: ['Which similar integrations have you shipped, and what broke?'],
    postedAt: new Date(Date.now() - 30 * 60_000),
    firstSeenAt: new Date(),
  };
}

/** Used only when the database holds no active profile to preview against. */
const SAMPLE_PROFILE: DraftProfile = {
  name: 'Sample profile',
  includeKeywords: ['api integration', 'data pipeline'],
  requiredSkills: ['Node.js', 'TypeScript'],
  niceToHaveSkills: ['PostgreSQL', 'AWS'],
  categories: ['Web, Mobile & Software Dev'],
  hourlyRate: 65,
  fixedBidStrategy: 'PERCENT_OF_BUDGET',
  fixedBidPercent: 0.9,
  freelancerProfile:
    'Backend engineer working on Node.js and TypeScript integrations, mostly data sync and ' +
    'internal APIs for small product teams.',
  portfolioHighlights: [
    'Rebuilt a nightly CRM to warehouse sync that had been failing weekly; it has run unattended since.',
  ],
  proposalTone: 'professional',
  proposalMaxChars: 1500,
  proposalLanguage: 'en',
};

function slotValues(vars: TemplateVars): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, raw] of Object.entries(vars)) {
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      values[key] = String(raw);
      continue;
    }
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (trimmed !== '') values[key] = trimmed;
  }
  return values;
}

interface PreviewRender {
  rendered: string;
  unresolved: string[];
}

/**
 * Preview rendering, deliberately not renderTemplate(): that one throws on the
 * first unfilled slot, while the operator editing a template needs to see the
 * whole letter plus every hole in it at once. Unresolved slots are left in place
 * so their position in the letter stays visible.
 */
function renderPreview(body: string, values: Record<string, string>): PreviewRender {
  const slots = extractSlots(body);
  if (slots.length === 0) return { rendered: body, unresolved: [] };

  const unresolved: string[] = [];
  // One pass over the body: substituting slot by slot would let a value that
  // happens to contain "{{...}}" be rewritten by a later slot. extractSlots
  // only yields [a-zA-Z0-9_] names, so the alternation needs no escaping.
  const pattern = new RegExp(`\\{\\{\\s*(${slots.join('|')})\\s*\\}\\}`, 'g');
  const rendered = body.replace(pattern, (match: string, name: string) => {
    const value = values[name];
    if (value === undefined) {
      if (!unresolved.includes(name)) unresolved.push(name);
      return match;
    }
    return value;
  });

  return { rendered, unresolved };
}

/* ------------------------------------------------------------------- routes */

export default async function templateRoutes(app: FastifyInstance): Promise<void> {
  app.get('/templates', async (_request, reply) => {
    const templates = await prisma.template.findMany({ orderBy: { createdAt: 'desc' } });
    const totalUses = templates.reduce((sum, template) => sum + template.timesUsed, 0);

    return reply.send({
      items: templates.map((template) => ({ ...template, usage: usageOf(template, totalUses) })),
      count: templates.length,
      totalUses,
      activeCount: templates.filter((template) => template.isActive).length,
      defaultId: templates.find((template) => template.isDefault)?.id ?? null,
    });
  });

  app.get('/templates/:id', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params ?? {});
    if (!params.success) {
      return reply
        .code(400)
        .send({ error: { code: 'BAD_REQUEST', message: 'invalid template id' } });
    }

    const template = await prisma.template.findUnique({ where: { id: params.data.id } });
    if (!template) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'template not found' } });
    }

    return reply.send({ template, slots: extractSlots(template.body) });
  });

  app.post('/templates', async (request, reply) => {
    const body = templateCreateSchema.safeParse(request.body ?? {});
    if (!body.success) return invalidBody(reply, 'invalid template', body.error);

    const issues = slotIssues(body.data.body, body.data.variables);
    if (issues.length > 0) return slotMismatch(reply, issues);

    const data = createDataFrom(body.data);

    try {
      const template = await prisma.$transaction(async (tx) => {
        // One default at a time: clear the flag before setting it, in the same
        // transaction, so a concurrent write cannot leave two defaults behind.
        if (data.isDefault === true) {
          await tx.template.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
        }
        return tx.template.create({ data });
      });

      log.info({ templateId: template.id, name: template.name }, 'template created');
      // Drafting reads templates through a 60s cache; a dashboard edit has to
      // reach the next proposal, not the one after the cache expires.
      invalidateTemplateCache();
      emit('template.created', { templateId: template.id, name: template.name });
      return reply.code(201).send({ template });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return reply.code(409).send({
          error: { code: 'CONFLICT', message: 'a template with that name already exists' },
        });
      }
      throw err;
    }
  });

  const updateHandler = async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const params = idParamsSchema.safeParse(request.params ?? {});
    if (!params.success) {
      return reply
        .code(400)
        .send({ error: { code: 'BAD_REQUEST', message: 'invalid template id' } });
    }

    const body = templateUpdateSchema.safeParse(request.body ?? {});
    if (!body.success) return invalidBody(reply, 'invalid template update', body.error);

    const current = await prisma.template.findUnique({
      where: { id: params.data.id },
      select: { id: true, body: true, variables: true },
    });
    if (!current) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'template not found' } });
    }

    // A partial update must still leave the stored body and variables in step,
    // so the check runs against the merged result rather than what was sent.
    const issues = slotIssues(
      body.data.body ?? current.body,
      body.data.variables ?? current.variables,
    );
    if (issues.length > 0) return slotMismatch(reply, issues);

    const data = updateDataFrom(body.data);

    try {
      const template = await prisma.$transaction(async (tx) => {
        if (data.isDefault === true) {
          await tx.template.updateMany({
            where: { id: { not: current.id }, isDefault: true },
            data: { isDefault: false },
          });
        }
        return tx.template.update({ where: { id: current.id }, data });
      });

      log.info({ templateId: template.id, fields: Object.keys(body.data) }, 'template updated');
      invalidateTemplateCache();
      emit('template.updated', { templateId: template.id, name: template.name });
      return reply.send({ template });
    } catch (err) {
      if (isMissingRow(err)) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'template not found' } });
      }
      if (isUniqueViolation(err)) {
        return reply.code(409).send({
          error: { code: 'CONFLICT', message: 'a template with that name already exists' },
        });
      }
      throw err;
    }
  };

  app.put('/templates/:id', updateHandler);
  app.patch('/templates/:id', updateHandler);

  app.delete('/templates/:id', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params ?? {});
    if (!params.success) {
      return reply
        .code(400)
        .send({ error: { code: 'BAD_REQUEST', message: 'invalid template id' } });
    }

    const current = await prisma.template.findUnique({
      where: { id: params.data.id },
      select: { id: true, name: true, isDefault: true, isActive: true },
    });
    if (!current) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'template not found' } });
    }

    if (current.isDefault && current.isActive) {
      const alternatives = await prisma.template.count({
        where: { id: { not: current.id }, isDefault: true, isActive: true },
      });
      if (alternatives === 0) {
        return reply.code(409).send({
          error: {
            code: 'CONFLICT',
            message:
              'this is the last active default template; make another template the default, or deactivate this one, before deleting it',
          },
        });
      }
    }

    try {
      const template = await prisma.template.delete({
        where: { id: current.id },
        select: { id: true, name: true },
      });
      log.warn({ templateId: template.id, name: template.name }, 'template deleted');
      invalidateTemplateCache();
      emit('template.deleted', { templateId: template.id, name: template.name });
      return reply.send({ deleted: true, template });
    } catch (err) {
      if (isMissingRow(err)) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'template not found' } });
      }
      throw err;
    }
  });

  app.post('/templates/:id/duplicate', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params ?? {});
    if (!params.success) {
      return reply
        .code(400)
        .send({ error: { code: 'BAD_REQUEST', message: 'invalid template id' } });
    }

    const source = await prisma.template.findUnique({ where: { id: params.data.id } });
    if (!source) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'template not found' } });
    }

    // Name is unique, so the suffix has to survive repeated duplication. One
    // query collects every existing "(copy...)" of this template up front.
    const room = MAX_NAME_CHARS - ' (copy 99)'.length;
    const stem = source.name.length > room ? source.name.slice(0, room).trimEnd() : source.name;
    const taken = new Set(
      (
        await prisma.template.findMany({
          where: { name: { startsWith: `${stem} (copy` } },
          select: { name: true },
        })
      ).map((row) => row.name),
    );

    let name: string | null = null;
    for (let attempt = 1; attempt <= MAX_COPY_ATTEMPTS; attempt += 1) {
      const candidate = attempt === 1 ? `${stem} (copy)` : `${stem} (copy ${attempt})`;
      if (!taken.has(candidate)) {
        name = candidate;
        break;
      }
    }
    if (name === null) {
      return reply.code(409).send({
        error: {
          code: 'CONFLICT',
          message: `there are already ${MAX_COPY_ATTEMPTS} copies of this template; rename some of them first`,
        },
      });
    }

    try {
      const template = await prisma.template.create({
        data: {
          name,
          description: source.description,
          jobTypes: source.jobTypes,
          tone: source.tone,
          categories: source.categories,
          minScore: source.minScore,
          body: source.body,
          variables: source.variables,
          notes: source.notes,
          // A copy is never the default, and it starts its own usage history.
          isDefault: false,
          isActive: source.isActive,
        },
      });

      log.info(
        { templateId: template.id, name: template.name, sourceId: source.id },
        'template duplicated',
      );
      invalidateTemplateCache();
      emit('template.created', { templateId: template.id, name: template.name });
      return reply.code(201).send({ template, duplicatedFrom: source.id });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return reply.code(409).send({
          error: { code: 'CONFLICT', message: 'a template with that name already exists' },
        });
      }
      throw err;
    }
  });

  app.post('/templates/:id/toggle', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params ?? {});
    if (!params.success) {
      return reply
        .code(400)
        .send({ error: { code: 'BAD_REQUEST', message: 'invalid template id' } });
    }
    const body = toggleBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'invalid body' } });
    }

    const current = await prisma.template.findUnique({
      where: { id: params.data.id },
      select: { id: true, name: true, isActive: true },
    });
    if (!current) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'template not found' } });
    }

    const isActive = body.data.isActive ?? !current.isActive;
    const template = await prisma.template.update({
      where: { id: current.id },
      data: { isActive },
      select: { id: true, name: true, isActive: true, isDefault: true },
    });

    log.info({ templateId: template.id, isActive: template.isActive }, 'template toggled');
    invalidateTemplateCache();
    emit('template.toggled', { templateId: template.id, isActive: template.isActive });

    return reply.send({ template });
  });

  app.post('/templates/:id/default', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params ?? {});
    if (!params.success) {
      return reply
        .code(400)
        .send({ error: { code: 'BAD_REQUEST', message: 'invalid template id' } });
    }

    const outcome = await prisma.$transaction(async (tx) => {
      const current = await tx.template.findUnique({
        where: { id: params.data.id },
        select: { id: true },
      });
      if (!current) return null;

      const cleared = await tx.template.updateMany({
        where: { id: { not: current.id }, isDefault: true },
        data: { isDefault: false },
      });
      // An inactive default would never be picked, so promoting also activates.
      const template = await tx.template.update({
        where: { id: current.id },
        data: { isDefault: true, isActive: true },
      });
      return { template, cleared: cleared.count };
    });

    if (!outcome) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'template not found' } });
    }

    log.info(
      { templateId: outcome.template.id, cleared: outcome.cleared },
      'default template changed',
    );
    invalidateTemplateCache();
    emit('template.default', {
      templateId: outcome.template.id,
      name: outcome.template.name,
    });

    return reply.send({ template: outcome.template, cleared: outcome.cleared });
  });

  /**
   * Live preview for the editor. Renders the submitted body against a real
   * posting (or the built-in sample) using exactly the slot values the drafting
   * pipeline would derive, and writes nothing at all.
   */
  app.post('/templates/preview', async (request, reply) => {
    const body = previewBodySchema.safeParse(request.body ?? {});
    if (!body.success) return invalidBody(reply, 'invalid preview request', body.error);

    let job: DraftJob;
    let jobSummary: { id: string; title: string; url: string; source: string } | null = null;

    if (body.data.jobId) {
      const row = await prisma.job.findUnique({ where: { id: body.data.jobId } });
      if (!row) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'job not found' } });
      }
      job = row;
      jobSummary = { id: row.id, title: row.title, url: row.url, source: row.source };
    } else {
      job = sampleJob();
    }

    const storedProfile = await prisma.profile.findFirst({
      where: { isActive: true },
      orderBy: { updatedAt: 'desc' },
    });
    const profile: DraftProfile = storedProfile ?? SAMPLE_PROFILE;

    const values = slotValues(deriveTemplateVars(job, profile, computeBid(job, profile)));
    const { rendered, unresolved } = renderPreview(body.data.body, values);

    const slots = diffTemplateSlots(body.data.body, body.data.variables);

    return reply.send({
      rendered,
      unresolved,
      charCount: rendered.length,
      slots: slots.used,
      undeclared: slots.undeclared,
      unused: slots.unused,
      // The closed vocabulary the drafting pipeline can actually fill.
      knownVariables: [...TEMPLATE_SLOTS],
      sample: jobSummary === null,
      job: jobSummary,
      profile: storedProfile ? { id: storedProfile.id, name: storedProfile.name } : null,
    });
  });
}
