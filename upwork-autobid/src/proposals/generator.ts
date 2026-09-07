import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { env } from '../config/env';
import { isRetryable, serializeError, toErrorMessage } from '../lib/errors';
import { backoffDelay, sleep } from '../lib/http';
import { child } from '../lib/logger';
import { formatMoney, isKnownNumber, normalizeJobType, truncate } from '../scoring/weights';
import type { DraftProposal, QuestionAnswer } from '../types';
import { stripContacts, validateProposal } from './guardrails';
import {
  type BidComputation,
  type DraftJob,
  type DraftProfile,
  computeBid,
  describeBid,
} from './pricing';
import { type ScoreSummary, buildPromptsForJob, languageName, screeningQuestions } from './prompt';
import { type ProposalTemplate, type TemplateVars, pickTemplate, renderTemplate } from './templates';

const log = child('proposals.generator');

/** One drafting call may take a while; the pipeline is async, so 60s is fine. */
export const GENERATION_TIMEOUT_MS = 60000;
export const MAX_ATTEMPTS = 3;
export const TEMPERATURE = 0.7;
export const TEMPLATE_MODEL_ID = 'template-fallback';
export const LOW_CONFIDENCE = 0.4;
/** How far the model's own price may drift from the computed one before we flag it. */
export const BID_DRIFT_TOLERANCE = 0.4;

export type DraftSource = 'model' | 'template';

/** A DraftProposal plus everything the persistence layer and dashboard want. */
export interface GeneratedProposal extends DraftProposal {
  source: DraftSource;
  templateId: string;
  connectsCost: number;
  confidence: number;
  /** Guardrail failures that could not be repaired; non-empty means DRAFT. */
  errors: string[];
  pricing: BidComputation;
}

/* --------------------------------------------------------- response parsing */

const numericField = z
  .union([z.number(), z.string(), z.null()])
  .optional()
  .transform((value): number | null => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const cleaned = value.replace(/[^0-9.-]/g, '');
    if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  });

const answerSchema = z.object({
  question: z
    .union([z.string(), z.null()])
    .optional()
    .transform((value): string => (value ?? '').trim()),
  answer: z
    .union([z.string(), z.number(), z.null()])
    .optional()
    .transform((value): string => (value === null || value === undefined ? '' : String(value).trim())),
});

const responseSchema = z.object({
  coverLetter: z.string().min(1),
  questionAnswers: z
    .array(answerSchema)
    .nullish()
    .transform((value): QuestionAnswer[] => value ?? []),
  suggestedBidAmount: numericField,
  suggestedHourlyRate: numericField,
  estimatedDurationLabel: z
    .union([z.string(), z.null()])
    .optional()
    .transform((value): string => (value ?? '').trim()),
  confidence: numericField,
});

export type ModelResponse = z.infer<typeof responseSchema>;

function tryParse(candidate: string): unknown {
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return undefined;
  }
}

/** Walks the string tracking quotes and escapes to find the outermost object. */
export function balancedJsonSpan(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      if (inString) escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Models sometimes wrap the object in prose or a fence despite the instruction.
 * Try the whole string, then any fenced block, then the outermost balanced
 * object, then the widest brace span.
 */
export function extractJsonObject(text: string): unknown {
  const trimmed = (text ?? '').trim();
  if (trimmed === '') return undefined;

  const candidates: string[] = [trimmed];

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced) candidates.push(fenced[1].trim());

  const balanced = balancedJsonSpan(trimmed);
  if (balanced) candidates.push(balanced);

  const greedy = /\{[\s\S]*\}/.exec(trimmed);
  if (greedy) candidates.push(greedy[0]);

  for (const candidate of candidates) {
    const parsed = tryParse(candidate);
    if (parsed !== undefined && parsed !== null && typeof parsed === 'object') return parsed;
  }
  return undefined;
}

export function parseModelResponse(text: string): ModelResponse | null {
  const raw = extractJsonObject(text);
  if (raw === undefined) return null;
  const parsed = responseSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/* --------------------------------------------------------- fallback drafting */

function cleanTitle(title: string): string {
  return title
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—*|]+/, '')
    .replace(/[\s\-–—*|]+$/, '')
    .replace(/\s*[-–—|]\s*(?:urgent|asap|hiring now|read carefully)[!.\s]*$/i, '')
    .trim();
}

/** Strips markdown noise so a quoted line from the brief reads cleanly. */
function cleanFragment(text: string): string {
  return text
    .replace(/[*_`#>]+/g, ' ')
    .replace(/^[\s\-–—•·]+/, '')
    .replace(/["“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** First bullet or sentence with enough substance to quote back to the client. */
function briefAnchor(job: DraftJob, maxChars: number): string {
  const description = (job.description ?? '').replace(/\r/g, '');

  const bullet = description
    .split('\n')
    .map((line) => line.trim())
    .find((line) => /^(?:[-*•·]|\d{1,2}[.)])\s+\S/.test(line) && cleanFragment(line).split(/\s+/).length >= 4);
  if (bullet) return truncate(cleanFragment(bullet), maxChars);

  const sentence = description
    .split(/(?<=[.!?])\s+|\n{2,}/)
    .map((part) => cleanFragment(part))
    .find((part) => part.split(/\s+/).length >= 6);
  if (sentence) return truncate(sentence, maxChars);


  const title = cleanTitle(job.title ?? '');
  return title === '' ? 'the outcome you described in your post' : truncate(title, maxChars);
}

function primarySkillFor(job: DraftJob, profile: DraftProfile): string {
  const wanted = new Set(
    [...(profile.requiredSkills ?? []), ...(profile.niceToHaveSkills ?? [])]
      .map((skill) => (skill ?? '').trim().toLowerCase())
      .filter((skill) => skill !== ''),
  );

  const overlap = (job.skills ?? []).find((skill) => wanted.has((skill ?? '').trim().toLowerCase()));
  if (overlap) return overlap.trim();

  const firstJobSkill = (job.skills ?? []).map((skill) => (skill ?? '').trim()).find((skill) => skill !== '');
  if (firstJobSkill) return firstJobSkill;

  const firstProfileSkill = (profile.requiredSkills ?? [])
    .map((skill) => (skill ?? '').trim())
    .find((skill) => skill !== '');
  if (firstProfileSkill) return firstProfileSkill;

  return 'delivery work like this';
}

function proofPointFor(profile: DraftProfile): string {
  const highlight = (profile.portfolioHighlights ?? [])
    .map((item) => (item ?? '').trim())
    .find((item) => item.length >= 20);
  if (highlight) return truncate(cleanFragment(highlight), 320);

  const summary = (profile.freelancerProfile ?? '').trim();
  if (summary !== '') {
    const sentences = summary.split(/(?<=[.!?])\s+/).map((part) => cleanFragment(part));
    const usable = sentences.filter((part) => part.split(/\s+/).length >= 5).slice(0, 2);
    if (usable.length > 0) return truncate(usable.join(' '), 320);
  }

  return 'I work on this kind of build regularly and can walk you through a comparable project before you commit to anything.';
}

function clarifyingQuestionFor(job: DraftJob, bid: BidComputation): string {
  if (bid.jobType === 'HOURLY') {
    return 'how many hours a week do you expect in the first month, and who signs off on the work?';
  }
  if (!isKnownNumber(job.budgetAmount)) {
    return 'do you have a budget range in mind, or would you rather I price it against a scope I propose?';
  }
  if ((job.screeningQuestions ?? []).length === 0) {
    return 'is the scope in your post final, or are there pieces you expect to add once we start?';
  }
  return 'what does a successful first two weeks look like from your side?';
}

function availabilityFor(bid: BidComputation): string {
  if (bid.jobType === 'HOURLY' && bid.estimatedWeeklyHours !== null) {
    return `I can start this week and hold about ${bid.estimatedWeeklyHours} hours a week for you.`;
  }
  return `I can start this week, and I would expect ${bid.estimatedDurationLabel.toLowerCase()} for the work as described.`;
}

function priceLineFor(bid: BidComputation): string {
  if (bid.hourlyRate !== null) {
    return `My rate for this is ${formatMoney(bid.hourlyRate, bid.currency)} per hour.`;
  }
  if (bid.bidAmount !== null) {
    return `My price for the scope above is ${formatMoney(bid.bidAmount, bid.currency)}.`;
  }
  return 'Happy to price it once the scope is agreed.';
}

export function deriveTemplateVars(
  job: DraftJob,
  profile: DraftProfile,
  bid: BidComputation,
): TemplateVars {
  const title = cleanTitle(job.title ?? '');
  // The anchor is client-authored text quoted back verbatim, so it goes through
  // the same contact stripping the finished letter does.
  const anchor = stripContacts(briefAnchor(job, 160)).text;
  const focus = title === '' ? anchor : title;
  const hourly = bid.jobType === 'HOURLY';

  return {
    jobTitle: title === '' ? focus : title,
    focus,
    primarySkill: primarySkillFor(job, profile),
    proofPoint: proofPointFor(profile),
    planStep1: `Confirm scope and success criteria against what you wrote: "${anchor}"`,
    planStep2: hourly
      ? 'Work the priority list in short cycles, with a written update at the end of each week'
      : 'Build the deliverable in reviewable stages so you can course-correct before the end',
    planStep3: hourly
      ? 'Keep a running backlog so you always know what is next and what it costs'
      : 'Hand over with documentation and a walkthrough, then stay available for follow-up questions',
    clarifyingQuestion: clarifyingQuestionFor(job, bid),
    availability: availabilityFor(bid),
    priceLine: priceLineFor(bid),
  };
}

/** Deterministic answers built only from facts we already hold. */
export function deriveQuestionAnswers(
  job: DraftJob,
  profile: DraftProfile,
  bid: BidComputation,
  vars: TemplateVars,
): QuestionAnswer[] {
  const questions = screeningQuestions(job);
  if (questions.length === 0) return [];

  const skill = String(vars.primarySkill ?? 'this work');
  const proof = String(vars.proofPoint ?? '');
  const availability = String(vars.availability ?? 'I can start this week.');
  const price = String(vars.priceLine ?? '');
  const plan = [vars.planStep1, vars.planStep2, vars.planStep3]
    .map((step) => String(step ?? ''))
    .filter((step) => step !== '')
    .join('; ');

  return questions.map((question) => {
    const needle = question.toLowerCase();
    let answer: string;

    if (/\bhours?\b|\bavailab|\bstart\b|\btimezone|\btime zone|\bwhen can/.test(needle)) {
      answer = availability;
    } else if (/\brate\b|\bbudget\b|\bprice\b|\bcost\b|\bcharge\b/.test(needle)) {
      answer =
        price !== ''
          ? price
          : `Happy to agree the budget once the scope is confirmed; I would expect ${bid.estimatedDurationLabel.toLowerCase()}.`;
    } else if (/\bexperience\b|\byears\b|\bworked\b|\bportfolio\b|\bexample\b|\bsimilar\b/.test(needle)) {
      answer = proof !== '' ? proof : `Most of my work is ${skill}, and I can walk you through a comparable project.`;
    } else if (/\bapproach\b|\bhow would you\b|\bplan\b|\bprocess\b|\bsteps?\b/.test(needle)) {
      answer = plan !== '' ? plan : `I would start by confirming scope, then deliver in reviewable stages.`;
    } else if (/\btool|\bstack\b|\btech|\bsoftware|\bframework/.test(needle)) {
      answer = `I work primarily with ${skill}, and I am happy to fit into whatever your team already uses.`;
    } else {
      answer = `Covered in my proposal: ${truncate(String(vars.focus ?? 'the work you described'), 120)}. Happy to expand on any part of it here before we start.`;
    }

    return { question, answer: truncate(answer, 600) };
  });
}

/**
 * Template-only draft. Used when no API key is configured and whenever the model
 * call fails, so a detection never stalls for want of a proposal.
 */
export function buildTemplateProposal(
  job: DraftJob,
  profile: DraftProfile,
  bid: BidComputation,
  template: ProposalTemplate,
  reason: string,
  startedAt: number,
): GeneratedProposal {
  const warnings = [`drafted from the ${template.id} template without the model: ${reason}`];
  const vars = deriveTemplateVars(job, profile, bid);

  let coverLetter: string;
  try {
    coverLetter = renderTemplate(template, vars);
  } catch (err) {
    // renderTemplate throws only on an unfilled slot, which means a template and
    // a var set that disagree - recoverable, but the operator must see it.
    warnings.push(`template rendering failed: ${toErrorMessage(err)}`);
    coverLetter = '';
  }

  const language = (profile.proposalLanguage ?? 'en').trim().toLowerCase();
  if (language !== '' && !language.startsWith('en')) {
    warnings.push(`fallback draft is in English but the profile asks for ${languageName(language)}`);
  }

  const validated = validateProposal(
    {
      coverLetter,
      bidAmount: bid.bidAmount,
      hourlyRate: bid.hourlyRate,
      estimatedDurationLabel: bid.estimatedDurationLabel,
      questionAnswers: deriveQuestionAnswers(job, profile, bid, vars),
      currency: bid.currency,
    },
    job,
    profile,
  );

  return {
    coverLetter: validated.sanitized.coverLetter,
    bidAmount: validated.sanitized.bidAmount,
    hourlyRate: validated.sanitized.hourlyRate,
    estimatedDurationLabel: validated.sanitized.estimatedDurationLabel,
    questionAnswers: validated.sanitized.questionAnswers,
    model: TEMPLATE_MODEL_ID,
    warnings: [...warnings, ...validated.warnings],
    generationMs: Date.now() - startedAt,
    source: 'template',
    templateId: template.id,
    connectsCost: bid.connectsCost,
    confidence: 0.35,
    errors: validated.errors,
    pricing: bid,
  };
}

/* ------------------------------------------------------------- model client */

let cachedClient: Anthropic | null = null;

function getClient(): Anthropic | null {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  if (!cachedClient) {
    // maxRetries: 0 - the retry loop below owns the timeout and backoff budget.
    cachedClient = new Anthropic({ apiKey, timeout: GENERATION_TIMEOUT_MS, maxRetries: 0 });
  }
  return cachedClient;
}

function extractText(message: Anthropic.Message): string {
  return message.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n')
    .trim();
}

function shouldRetry(err: unknown): boolean {
  if (isRetryable(err)) return true;
  if (err instanceof Error) {
    return /timeout|timed out|socket hang up|econnreset|network|aborted|overloaded/i.test(err.message);
  }
  return false;
}

/** Keeps the model's own price only when it is plausible; otherwise ours wins. */
function reconcilePrice(
  parsed: ModelResponse,
  bid: BidComputation,
  warnings: string[],
): { bidAmount: number | null; hourlyRate: number | null } {
  if (bid.jobType === 'HOURLY') {
    const suggested = parsed.suggestedHourlyRate;
    if (suggested === null || suggested <= 0) return { bidAmount: null, hourlyRate: bid.hourlyRate };
    if (bid.hourlyRate !== null && Math.abs(suggested - bid.hourlyRate) / bid.hourlyRate > BID_DRIFT_TOLERANCE) {
      warnings.push(
        `model suggested ${formatMoney(suggested, bid.currency)}/hr against a computed ${formatMoney(bid.hourlyRate, bid.currency)}/hr; kept the computed rate`,
      );
      return { bidAmount: null, hourlyRate: bid.hourlyRate };
    }
    return { bidAmount: null, hourlyRate: suggested };
  }

  const suggested = parsed.suggestedBidAmount;
  if (suggested === null || suggested <= 0) return { bidAmount: bid.bidAmount, hourlyRate: null };
  if (bid.bidAmount !== null && Math.abs(suggested - bid.bidAmount) / bid.bidAmount > BID_DRIFT_TOLERANCE) {
    warnings.push(
      `model suggested ${formatMoney(suggested, bid.currency)} against a computed ${formatMoney(bid.bidAmount, bid.currency)}; kept the computed bid`,
    );
    return { bidAmount: bid.bidAmount, hourlyRate: null };
  }
  return { bidAmount: suggested, hourlyRate: null };
}

function clampConfidence(value: number | null): number {
  if (value === null || !Number.isFinite(value)) return 0.5;
  const normalized = value > 1 && value <= 100 ? value / 100 : value;
  return Math.min(1, Math.max(0, Math.round(normalized * 100) / 100));
}

/* ---------------------------------------------------------------- entrypoint */

/**
 * Turns a matched job into a submission-ready draft. Always resolves: an absent
 * API key, a failing model, or an unparseable response all degrade to the
 * deterministic template path rather than throwing into the worker.
 */
export async function generateProposal(
  job: DraftJob,
  profile: DraftProfile,
  score?: ScoreSummary | null,
): Promise<GeneratedProposal> {
  const startedAt = Date.now();
  const bid = computeBid(job, profile);
  const template = pickTemplate(job, profile);
  const jobRef = { jobId: job.id, externalId: job.externalId, profileId: profile.id };

  const client = getClient();
  if (!client) {
    log.debug(jobRef, 'ANTHROPIC_API_KEY is not set; drafting from templates');
    return buildTemplateProposal(job, profile, bid, template, 'ANTHROPIC_API_KEY is not set', startedAt);
  }

  const model = env.ANTHROPIC_MODEL;
  // Awaits the Template table so an operator template written in the dashboard
  // is followed; `template` stays the built-in floor for the fallback letter.
  const prompts = await buildPromptsForJob({ job, profile, bid, score: score ?? null });
  let lastReason = 'model call failed';

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const message = await client.messages.create(
        {
          model,
          max_tokens: env.ANTHROPIC_MAX_TOKENS,
          temperature: TEMPERATURE,
          system: prompts.system,
          messages: [{ role: 'user', content: prompts.user }],
        },
        { timeout: GENERATION_TIMEOUT_MS },
      );

      const warnings: string[] = [];
      if (message.stop_reason === 'max_tokens') {
        warnings.push('model output hit the token ceiling and may be truncated');
      }

      const parsed = parseModelResponse(extractText(message));
      if (!parsed) {
        lastReason = 'model returned an unparseable response';
        log.warn({ ...jobRef, model, attempt: attempt + 1 }, lastReason);
        if (attempt + 1 < MAX_ATTEMPTS) {
          await sleep(backoffDelay(attempt, 500, 8000));
          continue;
        }
        break;
      }

      const price = reconcilePrice(parsed, bid, warnings);
      const confidence = clampConfidence(parsed.confidence);
      if (confidence < LOW_CONFIDENCE) {
        warnings.push(`model reported low confidence (${confidence})`);
      }

      const validated = validateProposal(
        {
          coverLetter: parsed.coverLetter,
          bidAmount: price.bidAmount,
          hourlyRate: price.hourlyRate,
          estimatedDurationLabel:
            parsed.estimatedDurationLabel === '' ? bid.estimatedDurationLabel : parsed.estimatedDurationLabel,
          questionAnswers: parsed.questionAnswers,
          currency: bid.currency,
        },
        job,
        profile,
      );

      const generated: GeneratedProposal = {
        coverLetter: validated.sanitized.coverLetter,
        bidAmount: validated.sanitized.bidAmount,
        hourlyRate: validated.sanitized.hourlyRate,
        estimatedDurationLabel: validated.sanitized.estimatedDurationLabel,
        questionAnswers: validated.sanitized.questionAnswers,
        model,
        promptTokens: message.usage?.input_tokens ?? 0,
        completionTokens: message.usage?.output_tokens ?? 0,
        warnings: [...warnings, ...validated.warnings],
        generationMs: Date.now() - startedAt,
        source: 'model',
        // The skeleton the model actually followed, which is a Template row id
        // whenever one applied and the built-in id otherwise.
        templateId: prompts.template.id ?? template.id,
        connectsCost: bid.connectsCost,
        confidence,
        errors: validated.errors,
        pricing: bid,
      };

      log.info(
        {
          ...jobRef,
          model,
          jobType: normalizeJobType(job.jobType),
          price: describeBid(bid),
          chars: generated.coverLetter.length,
          warnings: generated.warnings.length,
          errors: generated.errors.length,
          generationMs: generated.generationMs,
        },
        'proposal drafted',
      );

      return generated;
    } catch (err) {
      lastReason = toErrorMessage(err);
      const retry = attempt + 1 < MAX_ATTEMPTS && shouldRetry(err);
      log.warn(
        { err: serializeError(err), ...jobRef, model, attempt: attempt + 1, willRetry: retry },
        'proposal drafting call failed',
      );
      if (!retry) break;
      await sleep(backoffDelay(attempt, 500, 8000));
    }
  }

  return buildTemplateProposal(job, profile, bid, template, lastReason, startedAt);
}
