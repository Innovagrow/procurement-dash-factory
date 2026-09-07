import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { env, hasAnthropic } from '../config/env';
import { isRetryable, serializeError } from '../lib/errors';
import { backoffDelay, sleep } from '../lib/http';
import { child } from '../lib/logger';
import {
  type ScorableJob,
  type ScoringProfile,
  clamp,
  effectiveHourlyRate,
  formatMoney,
  isKnownNumber,
  normalizeJobType,
  truncate,
} from './weights';

const log = child('scoring.llm');

/** Hard ceiling on one rerank call. The pipeline must stay fast at 24/7 volume. */
export const LLM_TIMEOUT_MS = 20000;
/** Rationale plus a score fits comfortably; capping it caps the cost. */
export const LLM_MAX_TOKENS = 400;
const MAX_DESCRIPTION_CHARS = 2500;
const MAX_PROFILE_CHARS = 1200;
const MAX_PORTFOLIO_ITEMS = 5;
const MAX_PORTFOLIO_CHARS = 200;
const MAX_SKILLS = 15;
const MAX_QUESTIONS = 5;
const MAX_ATTEMPTS = 2;

export interface LlmRerankResult {
  score: number;
  rationale: string;
  model: string;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface LlmRerankOptions {
  model?: string;
  timeoutMs?: number;
  maxTokens?: number;
}

const responseSchema = z.object({
  score: z.coerce.number().finite(),
  rationale: z.string().min(1),
});

let cachedClient: Anthropic | null = null;

function getClient(timeoutMs: number): Anthropic | null {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  if (!cachedClient) {
    // maxRetries: 0 - retries are handled here so the timeout budget is ours.
    cachedClient = new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 0 });
  }
  return cachedClient;
}

export function isLlmRerankAvailable(): boolean {
  return hasAnthropic();
}

const SYSTEM_PROMPT = [
  'You qualify Upwork job postings for a freelancer who is about to spend connects on a proposal.',
  'You judge semantic fit only: does this freelancer credibly win and deliver this specific job?',
  'Reward postings that match the freelancer stated expertise and portfolio evidence.',
  'Penalise vague briefs, mismatched domains, and work the freelancer has no evidence of doing.',
  'Respond with JSON only. No prose, no markdown, no code fences.',
].join(' ');

function budgetLine(job: ScorableJob): string {
  const type = normalizeJobType(job.jobType);
  if (type === 'HOURLY') {
    const rate = effectiveHourlyRate(job);
    return rate === null ? 'Hourly, rate not posted' : `Hourly, up to ${formatMoney(rate, job.currency)}/hr`;
  }
  if (isKnownNumber(job.budgetAmount)) {
    return `Fixed price, ${formatMoney(job.budgetAmount, job.currency)}`;
  }
  return 'Budget not disclosed';
}

export function buildRerankPrompt(job: ScorableJob, profile: ScoringProfile): string {
  const skills = (job.skills ?? []).slice(0, MAX_SKILLS).join(', ') || 'none listed';
  const questions = (job.screeningQuestions ?? []).slice(0, MAX_QUESTIONS);
  const portfolio = (profile.portfolioHighlights ?? [])
    .slice(0, MAX_PORTFOLIO_ITEMS)
    .map((item) => `- ${truncate(item, MAX_PORTFOLIO_CHARS)}`)
    .join('\n');

  const sections = [
    '<job>',
    `Title: ${truncate(job.title ?? '', 200)}`,
    `Category: ${job.category ?? 'unknown'}${job.subcategory ? ` / ${job.subcategory}` : ''}`,
    `Type: ${budgetLine(job)}`,
    `Skills requested: ${skills}`,
    `Experience level: ${job.experienceLevel ?? 'unspecified'}`,
    'Description:',
    truncate(job.description ?? '', MAX_DESCRIPTION_CHARS),
    questions.length > 0 ? `Screening questions:\n${questions.map((q) => `- ${truncate(q, 200)}`).join('\n')}` : '',
    '</job>',
    '',
    '<freelancer>',
    truncate(profile.freelancerProfile ?? 'No profile summary provided.', MAX_PROFILE_CHARS),
    portfolio ? `\nPortfolio highlights:\n${portfolio}` : '',
    '</freelancer>',
    '',
    'Rate the fit from 0 to 100, where 0 means "this freelancer should not bid" and 100 means',
    '"this is exactly their work and they are a top-three candidate".',
    'Answer with this JSON object and nothing else:',
    '{"score": <integer 0-100>, "rationale": "<one paragraph, at most three sentences>"}',
  ];

  return sections.filter((section) => section !== '').join('\n');
}

function extractText(message: Anthropic.Message): string {
  return message.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n')
    .trim();
}

function tryParseJson(candidate: string): unknown {
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Models occasionally wrap JSON in prose or a code fence despite the
 * instruction. Try the whole response, then a fenced block, then the widest
 * brace span, and validate whatever comes back.
 */
export function parseRerankResponse(text: string): { score: number; rationale: string } | null {
  const trimmed = (text ?? '').trim();
  if (trimmed === '') return null;

  const candidates: unknown[] = [];
  const direct = tryParseJson(trimmed);
  if (direct !== undefined) candidates.push(direct);

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced) {
    const parsed = tryParseJson(fenced[1].trim());
    if (parsed !== undefined) candidates.push(parsed);
  }

  const braced = /\{[\s\S]*\}/.exec(trimmed);
  if (braced) {
    const parsed = tryParseJson(braced[0]);
    if (parsed !== undefined) candidates.push(parsed);
  }

  for (const candidate of candidates) {
    const result = responseSchema.safeParse(candidate);
    if (result.success) {
      return {
        score: Math.round(clamp(result.data.score, 0, 100)),
        rationale: truncate(result.data.rationale.replace(/\s+/g, ' ').trim(), 900),
      };
    }
  }

  return null;
}

function shouldRetry(err: unknown): boolean {
  if (isRetryable(err)) return true;
  if (err instanceof Error) {
    return /timeout|timed out|socket hang up|econnreset|network|aborted/i.test(err.message);
  }
  return false;
}

/**
 * Optional semantic pass over a job that already survived the rules engine.
 * Returns null - never throws - when no API key is configured, the call fails,
 * or the model returns something that is not a usable score. Callers fall back
 * to the rule score.
 */
export async function llmRerank(
  job: ScorableJob,
  profile: ScoringProfile,
  options: LlmRerankOptions = {},
): Promise<LlmRerankResult | null> {
  const timeoutMs = options.timeoutMs ?? LLM_TIMEOUT_MS;
  const client = getClient(timeoutMs);
  if (!client) {
    log.debug('ANTHROPIC_API_KEY is not set; skipping llm rerank');
    return null;
  }

  const model = options.model ?? env.ANTHROPIC_MODEL;
  const maxTokens = Math.min(options.maxTokens ?? LLM_MAX_TOKENS, env.ANTHROPIC_MAX_TOKENS);
  const prompt = buildRerankPrompt(job, profile);
  const started = Date.now();

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const message = await client.messages.create(
        {
          model,
          max_tokens: maxTokens,
          temperature: 0,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: prompt }],
        },
        { timeout: timeoutMs },
      );

      const parsed = parseRerankResponse(extractText(message));
      if (!parsed) {
        log.warn(
          { jobId: job.id, externalId: job.externalId, model, attempt },
          'llm rerank returned an unparseable response',
        );
        return null;
      }

      return {
        score: parsed.score,
        rationale: parsed.rationale,
        model,
        latencyMs: Date.now() - started,
        inputTokens: message.usage?.input_tokens ?? null,
        outputTokens: message.usage?.output_tokens ?? null,
      };
    } catch (err) {
      const retry = attempt + 1 < MAX_ATTEMPTS && shouldRetry(err);
      log.warn(
        {
          err: serializeError(err),
          jobId: job.id,
          externalId: job.externalId,
          model,
          attempt: attempt + 1,
          willRetry: retry,
        },
        'llm rerank call failed',
      );
      if (!retry) return null;
      await sleep(backoffDelay(attempt, 400, 4000));
    }
  }

  return null;
}

/**
 * Final score = 70% rules, 30% model. The rules engine owns the decision; the
 * model only nudges it, so one bad generation cannot push a junk job to BID.
 */
export function blendScores(ruleScore: number, llmScore: number | null | undefined): number {
  const rule = clamp(Number.isFinite(ruleScore) ? ruleScore : 0, 0, 100);
  if (llmScore === null || llmScore === undefined || !Number.isFinite(llmScore)) {
    return Math.round(rule);
  }
  const llm = clamp(llmScore, 0, 100);
  return Math.round(clamp(0.7 * rule + 0.3 * llm, 0, 100));
}
