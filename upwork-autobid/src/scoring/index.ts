import type { ScoreResult } from '../types';
import { child } from '../lib/logger';
import { blendScores, isLlmRerankAvailable, llmRerank } from './llm-rerank';
import { hasVetoFlag } from './red-flags';
import { decisionFor, resolveThresholds, scoreJob } from './scorer';
import { type ScorableJob, type ScoringProfile, resolveWeights, truncate } from './weights';

const log = child('scoring');

/**
 * How far below the review threshold a rule score may sit and still be worth an
 * LLM call. The blend is 70/30, so a job more than ~30 points short can never
 * be lifted into review by the model - paying for that token spend is waste.
 */
export const LLM_SCORE_MARGIN = 12;

export interface EvaluateOptions {
  /** Clock injection for deterministic tests. */
  reference?: Date;
  /** Skip the semantic pass entirely, whatever the profile says. */
  skipLlm?: boolean;
  /** Run the semantic pass even when the rule score is far from the threshold. */
  forceLlm?: boolean;
  model?: string;
}

function shouldRerank(rules: ScoreResult, profile: ScoringProfile, options: EvaluateOptions): boolean {
  if (options.skipLlm) return false;
  if (!isLlmRerankAvailable()) return false;
  if (profile.useLlmRerank === false) return false;
  if (rules.hardFilterFailures.length > 0) return false;
  if (hasVetoFlag(rules.redFlags)) return false;
  if (options.forceLlm) return true;

  const { review } = resolveThresholds(profile);
  return rules.score >= review - LLM_SCORE_MARGIN;
}

/**
 * Full evaluation of one job against one profile: hard filters and the rules
 * engine, then an optional Claude rerank blended 70/30 into the final score.
 * Never throws for LLM reasons - a failed or absent rerank degrades to the
 * rule score, which is what keeps the 24/7 pipeline running unattended.
 */
export async function evaluate(
  job: ScorableJob,
  profile: ScoringProfile,
  options: EvaluateOptions = {},
): Promise<ScoreResult> {
  const weights = resolveWeights(profile.weights);
  const rules = scoreJob(job, profile, {
    weights,
    ...(options.reference ? { reference: options.reference } : {}),
  });

  if (!shouldRerank(rules, profile, options)) return rules;

  const rerank = await llmRerank(job, profile, options.model ? { model: options.model } : {});
  if (!rerank) return rules;

  const score = blendScores(rules.score, rerank.score);
  const direction = rerank.score >= rules.score ? '+' : '-';
  const reasons = [
    ...rules.reasons,
    truncate(`${direction} LLM fit ${rerank.score}/100: ${rerank.rationale}`, 240),
  ];

  log.debug(
    {
      jobId: job.id,
      externalId: job.externalId,
      profileId: profile.id,
      ruleScore: rules.score,
      llmScore: rerank.score,
      blended: score,
      latencyMs: rerank.latencyMs,
    },
    'llm rerank applied',
  );

  return {
    ...rules,
    score,
    decision: decisionFor(score, profile),
    reasons,
    llmScore: rerank.score,
    llmRationale: rerank.rationale,
  };
}

export {
  DEFAULT_WEIGHTS,
  DIMENSION_LABELS,
  SCORING_DIMENSIONS,
  bulletCount,
  clamp,
  clamp01,
  containsTerm,
  effectiveHourlyRate,
  formatCount,
  formatMoney,
  formatPercent,
  fromRawJob,
  isKnownNumber,
  jobAgeMinutes,
  jobText,
  listIncludes,
  normalizeExperienceLevel,
  normalizeHireRate,
  normalizeJobType,
  normalizeSkills,
  normalizeText,
  renormalizeWeights,
  resolveWeights,
  round2,
  toDate,
  truncate,
  wordCount,
} from './weights';
export type {
  DimensionWeights,
  JobText,
  ScorableJob,
  ScoringDimension,
  ScoringProfile,
} from './weights';

export {
  applyHardFilters,
  applyHardFiltersDetailed,
  passesHardFilters,
} from './hard-filters';
export type { HardFilterFailure } from './hard-filters';

export {
  MAX_SOFT_PENALTY,
  RED_FLAG_PENALTIES,
  describeRedFlags,
  detectRedFlags,
  hasVetoFlag,
  redFlagPenalty,
} from './red-flags';

export { decisionFor, resolveThresholds, scoreJob } from './scorer';
export type { DecisionThresholds, ScoreJobOptions } from './scorer';

export {
  LLM_MAX_TOKENS,
  LLM_TIMEOUT_MS,
  blendScores,
  buildRerankPrompt,
  isLlmRerankAvailable,
  llmRerank,
  parseRerankResponse,
} from './llm-rerank';
export type { LlmRerankOptions, LlmRerankResult } from './llm-rerank';
