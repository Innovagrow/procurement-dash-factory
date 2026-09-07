import { Prisma, type Proposal } from '@prisma/client';
import { NotFoundError, RetryableError, serializeError } from '../lib/errors';
import { child } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { withLock } from '../lib/redis';
import type { ProposalStatus, QuestionAnswer } from '../types';
import { type GeneratedProposal, generateProposal } from './generator';
import type { ScoreSummary } from './prompt';

const log = child('proposals');

/**
 * Statuses that mean "this attempt is finished and a new draft is allowed".
 * Anything else - DRAFT, PENDING_APPROVAL, APPROVED, SUBMITTING, SUBMITTED -
 * is live work that must never be silently duplicated.
 */
export const REDRAFTABLE_PROPOSAL_STATUS: readonly ProposalStatus[] = [
  'REJECTED',
  'FAILED',
  'EXPIRED',
];

const DRAFT_LOCK_TTL_MS = 120000;

export interface DraftForJobResult {
  proposal: Proposal;
  /** False when an existing non-terminal proposal was returned untouched. */
  created: boolean;
  /** Null when nothing was generated because a proposal already existed. */
  generated: GeneratedProposal | null;
}

function answersToJson(answers: QuestionAnswer[]): Prisma.InputJsonValue {
  return answers.map((entry) => ({ question: entry.question, answer: entry.answer }));
}

function findLiveProposal(jobId: string, profileId: string): Promise<Proposal | null> {
  return prisma.proposal.findFirst({
    where: { jobId, profileId, status: { notIn: [...REDRAFTABLE_PROPOSAL_STATUS] } },
    orderBy: { createdAt: 'desc' },
  });
}

async function recordAudit(
  action: string,
  proposalId: string,
  details: Prisma.InputJsonObject,
): Promise<void> {
  try {
    await prisma.auditEvent.create({
      data: { actor: 'system', action, refType: 'proposal', refId: proposalId, details },
    });
  } catch (err) {
    // The proposal itself is already committed; losing its audit row must not
    // fail the job and cause a duplicate draft on retry.
    log.warn({ err: serializeError(err), action, proposalId }, 'failed to write audit event');
  }
}

async function persist(
  jobId: string,
  profileId: string,
  generated: GeneratedProposal,
): Promise<Proposal> {
  const status: ProposalStatus = generated.errors.length > 0 ? 'DRAFT' : 'PENDING_APPROVAL';

  const proposal = await prisma.proposal.create({
    data: {
      jobId,
      profileId,
      status,
      coverLetter: generated.coverLetter,
      bidAmount: generated.bidAmount,
      hourlyRate: generated.hourlyRate,
      estimatedDurationLabel: generated.estimatedDurationLabel,
      questionAnswers: answersToJson(generated.questionAnswers),
      connectsCost: generated.connectsCost,
      model: generated.model,
      promptTokens: generated.promptTokens ?? null,
      completionTokens: generated.completionTokens ?? null,
      warnings: [...generated.warnings, ...generated.errors.map((error) => `blocked: ${error}`)],
      generationMs: Math.round(generated.generationMs),
    },
  });

  const details: Prisma.InputJsonObject = {
    jobId,
    profileId,
    status,
    source: generated.source,
    model: generated.model,
    templateId: generated.templateId,
    confidence: generated.confidence,
    bidAmount: generated.bidAmount,
    hourlyRate: generated.hourlyRate,
    currency: generated.pricing.currency,
    strategy: generated.pricing.strategy,
    connectsCost: generated.connectsCost,
    generationMs: Math.round(generated.generationMs),
    warnings: generated.warnings,
    errors: generated.errors,
  };
  await recordAudit('proposal.drafted', proposal.id, details);

  log.info(
    {
      proposalId: proposal.id,
      jobId,
      profileId,
      status,
      source: generated.source,
      warnings: generated.warnings.length,
      errors: generated.errors.length,
    },
    'proposal persisted',
  );

  return proposal;
}

/**
 * Loads a job, its profile and their match, drafts a proposal and stores it.
 *
 * Idempotent in two layers: a Redis lock serialises concurrent workers on the
 * same (jobId, profileId), and inside the lock an existing non-terminal
 * proposal short-circuits the whole thing. Guardrail errors land the row in
 * DRAFT so a human sees it instead of it going to the approval queue.
 */
export async function draftForJob(jobId: string, profileId: string): Promise<DraftForJobResult> {
  const existing = await findLiveProposal(jobId, profileId);
  if (existing) {
    log.debug({ jobId, profileId, proposalId: existing.id }, 'proposal already exists, skipping draft');
    return { proposal: existing, created: false, generated: null };
  }

  const result = await withLock(`proposal:${jobId}:${profileId}`, DRAFT_LOCK_TTL_MS, async () => {
    const raced = await findLiveProposal(jobId, profileId);
    if (raced) {
      return { proposal: raced, created: false, generated: null } satisfies DraftForJobResult;
    }

    const [job, profile] = await Promise.all([
      prisma.job.findUnique({ where: { id: jobId } }),
      prisma.profile.findUnique({ where: { id: profileId } }),
    ]);

    if (!job) throw new NotFoundError(`job ${jobId} not found`, { details: { jobId } });
    if (!profile) throw new NotFoundError(`profile ${profileId} not found`, { details: { profileId } });

    const match = await prisma.jobProfileMatch.findUnique({
      where: { jobId_profileId: { jobId, profileId } },
    });

    const score: ScoreSummary | null = match
      ? {
          score: match.score,
          decision: match.decision,
          reasons: match.reasons,
          matchedKeywords: match.matchedKeywords,
          matchedSkills: match.matchedSkills,
          llmRationale: match.llmRationale,
        }
      : null;

    const generated = await generateProposal(job, profile, score);
    const proposal = await persist(jobId, profileId, generated);

    return { proposal, created: true, generated } satisfies DraftForJobResult;
  });

  if (result) return result;

  // Another worker holds the lock. It will have written the row by the time it
  // releases; if it has not, the queue retries rather than drafting twice.
  const afterLock = await findLiveProposal(jobId, profileId);
  if (afterLock) {
    return { proposal: afterLock, created: false, generated: null };
  }
  throw new RetryableError('another worker is drafting this proposal', {
    details: { jobId, profileId },
  });
}

export {
  BID_DRIFT_TOLERANCE,
  GENERATION_TIMEOUT_MS,
  LOW_CONFIDENCE,
  MAX_ATTEMPTS,
  TEMPERATURE,
  TEMPLATE_MODEL_ID,
  balancedJsonSpan,
  buildTemplateProposal,
  deriveQuestionAnswers,
  deriveTemplateVars,
  extractJsonObject,
  generateProposal,
  parseModelResponse,
} from './generator';
export type { DraftSource, GeneratedProposal, ModelResponse } from './generator';

export {
  BANNED_PHRASES,
  MIN_ANSWER_CHARS,
  MIN_COVER_LETTER_CHARS,
  MIN_COVER_LETTER_WORDS,
  OFF_PLATFORM_SOLICITATIONS,
  OFF_PLATFORM_TERMS,
  OVERBID_FACTOR,
  filterOffPlatform,
  findUnresolvedPlaceholders,
  findUnsupportedMetrics,
  stripContacts,
  trimToSentenceBoundary,
  validateProposal,
  wordsIn,
} from './guardrails';
export type {
  ContactStripResult,
  GuardrailResult,
  ProposalDraftInput,
  SanitizedProposal,
} from './guardrails';

export {
  CONNECTS_LADDER,
  DEFAULT_CONNECTS,
  DEFAULT_FIXED_BID_PERCENT,
  DEFAULT_HOURS_PER_WEEK,
  FIXED_BID_STRATEGIES,
  HOURLY_RANGE_TARGET,
  MAX_CONNECTS,
  bidStep,
  computeBid,
  currencyOf,
  describeBid,
  estimateConnects,
  estimateDuration,
  estimateEffort,
  hoursPerWeekFor,
  normalizeFixedBidStrategy,
  roundBid,
  roundRate,
} from './pricing';
export type {
  AppliedStrategy,
  BidComputation,
  DraftJob,
  DraftProfile,
  EffortEstimate,
  FixedBidStrategy,
} from './pricing';

export {
  DEFAULT_PROPOSAL_MAX_CHARS,
  HARD_RULES,
  MAX_ANSWER_CHARS,
  MAX_DESCRIPTION_CHARS,
  MAX_PROPOSAL_MAX_CHARS,
  MAX_QUESTIONS,
  MIN_PROPOSAL_MAX_CHARS,
  RESPONSE_CONTRACT,
  buildPrompts,
  buildSystemPrompt,
  buildUserPrompt,
  languageName,
  resolveMaxChars,
  screeningQuestions,
} from './prompt';
export type { BuiltPrompts, PromptContext, ScoreSummary } from './prompt';

export {
  PROPOSAL_TONES,
  TEMPLATES,
  TEMPLATE_SECTIONS,
  TEMPLATE_SLOTS,
  extractSlots,
  getTemplate,
  normalizeTone,
  pickTemplate,
  renderSlots,
  renderTemplate,
  templateSkeleton,
  templateSlots,
} from './templates';
export type {
  ProposalTemplate,
  ProposalTone,
  TemplateJobType,
  TemplateSlot,
  TemplateVars,
} from './templates';
