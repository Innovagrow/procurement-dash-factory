import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { child } from '../../lib/logger';
import { safeNormalizeJob } from '../../sources/normalize';
import {
  INBOX_KEY,
  type InboxItem,
  inboxDepth,
  inboxItemSchema,
  pushInboxItem,
} from '../../sources/webhook-inbox';
import type { RawJob } from '../../types';
import { emit } from '../sse';

const log = child('api:inbox');

/** One request may carry a batch; the drain worker pulls them back out one by one. */
const MAX_ITEMS_PER_REQUEST = 200;

const batchSchema = z.object({
  items: z.array(z.unknown()).min(1).max(MAX_ITEMS_PER_REQUEST),
});

function extractItems(body: unknown): unknown[] | { error: string } {
  if (Array.isArray(body)) {
    if (body.length === 0) return { error: 'the array is empty' };
    if (body.length > MAX_ITEMS_PER_REQUEST) {
      return { error: `at most ${MAX_ITEMS_PER_REQUEST} items per request` };
    }
    return body;
  }
  if (body && typeof body === 'object' && Array.isArray((body as { items?: unknown }).items)) {
    const parsed = batchSchema.safeParse(body);
    if (!parsed.success) {
      return {
        error: parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; '),
      };
    }
    return parsed.data.items;
  }
  if (body && typeof body === 'object') return [body];
  return { error: 'body must be a job object, an array of them, or {"items": [...]}' };
}

/** Same field mapping the webhook source uses when it drains the list. */
function previewOf(item: InboxItem): RawJob | null {
  return safeNormalizeJob({
    source:
      typeof item.source === 'string' && item.source.trim() !== '' ? item.source.trim() : 'webhook',
    externalId: item.externalId,
    ciphertext: item.ciphertext,
    id: item.id,
    url: item.url ?? item.link,
    title: item.title,
    description: item.description,
    descriptionHtml: item.descriptionHtml,
    postedAt: item.postedAt,
    skills: item.skills,
    category: item.category,
    subcategory: item.subcategory,
    jobType: item.jobType,
    budgetAmount: item.budgetAmount,
    budgetText: item.budgetText,
    hourlyMin: item.hourlyMin,
    hourlyMax: item.hourlyMax,
    hourlyRangeText: item.hourlyRangeText,
    currency: item.currency,
    durationLabel: item.durationLabel,
    experienceLevel: item.experienceLevel,
    workload: item.workload,
    connectsRequired: item.connectsRequired,
    proposalsCount: item.proposalsCount,
    interviewingCount: item.interviewingCount,
    screeningQuestions: item.screeningQuestions,
    client: item.client,
    raw: item,
  });
}

interface RejectedItem {
  index: number;
  error: string;
}

export default async function inboxRoutes(app: FastifyInstance): Promise<void> {
  app.get('/inbox', async (_request, reply) =>
    reply.send({ key: INBOX_KEY, depth: await inboxDepth(), maxItemsPerRequest: MAX_ITEMS_PER_REQUEST }),
  );

  app.post('/inbox', async (request, reply) => {
    const extracted = extractItems(request.body);
    if (!Array.isArray(extracted)) {
      return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: extracted.error } });
    }

    const previews: RawJob[] = [];
    const rejected: RejectedItem[] = [];
    let accepted = 0;
    let depth = 0;

    for (let index = 0; index < extracted.length; index += 1) {
      const parsed = inboxItemSchema.safeParse(extracted[index]);
      if (!parsed.success) {
        rejected.push({
          index,
          error: parsed.error.issues
            .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('; '),
        });
        continue;
      }

      const preview = previewOf(parsed.data);
      if (!preview) {
        rejected.push({
          index,
          error: 'item could not be normalised into a job (missing url/externalId or title)',
        });
        continue;
      }

      const result = await pushInboxItem(parsed.data);
      if (!result.accepted) {
        rejected.push({ index, error: result.error ?? 'redis rejected the item' });
        continue;
      }

      accepted += 1;
      depth = result.depth;
      previews.push(preview);
    }

    if (accepted > 0) {
      log.info({ accepted, rejected: rejected.length, depth }, 'inbox items queued');
      emit('inbox.received', { accepted, rejected: rejected.length, depth });
    } else {
      log.warn({ rejected: rejected.length }, 'inbox request accepted nothing');
    }

    const status = accepted === 0 ? 400 : rejected.length > 0 ? 207 : 202;
    return reply.code(status).send({
      accepted,
      rejected: rejected.length,
      errors: rejected.slice(0, 20),
      depth: accepted > 0 ? depth : await inboxDepth(),
      preview: previews.slice(0, 10).map((job) => ({
        source: job.source,
        externalId: job.externalId,
        url: job.url,
        title: job.title,
        jobType: job.jobType,
        budgetAmount: job.budgetAmount,
        hourlyMin: job.hourlyMin,
        hourlyMax: job.hourlyMax,
        currency: job.currency,
        skills: job.skills,
        postedAt: job.postedAt,
        connectsRequired: job.connectsRequired,
        proposalsCount: job.proposalsCount,
        screeningQuestions: job.screeningQuestions,
        client: job.client,
      })),
    });
  });
}
