/**
 * Drafting worker. The generator, guardrails and pricing live in ../proposals;
 * this file only decides what happens to the row that comes back.
 */

import { env, publicUrl } from '../config/env';
import { NotFoundError, toErrorMessage } from '../lib/errors';
import { child } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { incrementCounter } from '../lib/redis';
import { dayBucket, secondsUntilEndOfDay } from '../lib/time';
import { notifySystemAlert } from '../notify';
import { draftForJob } from '../proposals';
import type { DraftJobData } from '../types';
import { addSubmitJob, PRIORITY } from '../queue/queues';

const log = child('worker:draft');

/** Job statuses a fresh draft is allowed to advance. */
const ADVANCEABLE_STATUSES = new Set<string>(['NEW', 'SCORED', 'QUEUED']);

export interface DraftOutcome {
  jobId: string;
  profileId: string;
  proposalId: string | null;
  status: string | null;
  created: boolean;
  enqueuedSubmit: boolean;
  skipped?: string;
}

async function recordMetric(name: string, by = 1): Promise<void> {
  if (!env.METRICS_ENABLED || by === 0) return;
  try {
    await incrementCounter(`metrics:${name}:${dayBucket()}`, secondsUntilEndOfDay(), by);
  } catch (err) {
    log.debug({ err, metric: name }, 'metric increment failed');
  }
}

/**
 * A DRAFT row means the guardrails rejected the generated text. Sending it into
 * the dispatcher would only get it marked FAILED, so it stays visible in the
 * dashboard for a human to fix and the operator is told once.
 */
async function notifyBlockedDraft(
  proposalId: string,
  jobId: string,
  jobTitle: string,
  warnings: string[],
): Promise<void> {
  try {
    await notifySystemAlert({
      kind: 'DEGRADED',
      component: 'drafting',
      severity: 'WARN',
      detail:
        'A proposal was generated but the guardrails blocked it, so nothing was queued for ' +
        'submission. Edit or discard it in the dashboard.',
      facts: [
        { label: 'Job', value: jobTitle },
        { label: 'Blocked by', value: warnings.join('; ') },
      ],
      dashboardUrl: publicUrl(`/#/proposals/${proposalId}`),
      refId: proposalId,
    });
  } catch (err) {
    log.error({ err, proposalId, jobId }, 'failed to send blocked draft notification');
  }
}

/**
 * Drafts a proposal for one (job, profile) and hands it to the submit queue.
 * draftForJob is itself idempotent, so a retry returns the existing row instead
 * of burning another model call.
 */
export async function runDraft(data: DraftJobData): Promise<DraftOutcome> {
  const { jobId, profileId } = data;
  const base: DraftOutcome = {
    jobId,
    profileId,
    proposalId: null,
    status: null,
    created: false,
    enqueuedSubmit: false,
  };

  let result: Awaited<ReturnType<typeof draftForJob>>;
  try {
    result = await draftForJob(jobId, profileId);
  } catch (err) {
    if (err instanceof NotFoundError) {
      // The job or profile was deleted between scoring and drafting. Retrying
      // cannot fix that, so end the job cleanly instead of burning attempts.
      log.warn({ jobId, profileId, err }, 'draft skipped: referenced row is gone');
      return { ...base, skipped: toErrorMessage(err) };
    }
    throw err;
  }

  const { proposal, created } = result;
  base.proposalId = proposal.id;
  base.status = proposal.status;
  base.created = created;

  if (created) {
    await recordMetric('proposals.drafted', 1);
    try {
      const job = await prisma.job.findUnique({ where: { id: jobId }, select: { status: true } });
      if (job && ADVANCEABLE_STATUSES.has(job.status)) {
        await prisma.job.update({ where: { id: jobId }, data: { status: 'DRAFTED' } });
      }
    } catch (err) {
      log.warn({ err, jobId }, 'could not advance job status to DRAFTED');
    }
  }

  if (proposal.status === 'DRAFT') {
    const warnings = proposal.warnings.length > 0 ? proposal.warnings : ['no detail recorded'];
    log.warn(
      { proposalId: proposal.id, jobId, profileId, warnings },
      'draft blocked by guardrails; not queueing for submission',
    );
    await recordMetric('proposals.blocked', 1);
    if (created) {
      const job = await prisma.job.findUnique({ where: { id: jobId }, select: { title: true } });
      await notifyBlockedDraft(proposal.id, jobId, job?.title ?? jobId, warnings);
    }
    return { ...base, skipped: 'guardrails blocked the draft' };
  }

  if (proposal.status === 'SUBMITTED' || proposal.status === 'SUBMITTING') {
    log.debug(
      { proposalId: proposal.id, status: proposal.status },
      'draft complete; submission already in flight',
    );
    return base;
  }

  try {
    await addSubmitJob({ proposalId: proposal.id }, { priority: PRIORITY.hot });
    base.enqueuedSubmit = true;
  } catch (err) {
    log.error({ err, proposalId: proposal.id }, 'failed to enqueue submit job');
    throw err;
  }

  log.info(
    {
      proposalId: proposal.id,
      jobId,
      profileId,
      status: proposal.status,
      created,
      model: proposal.model,
      generationMs: proposal.generationMs,
    },
    'proposal drafted and queued for submission',
  );

  return base;
}
