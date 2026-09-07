import { z } from 'zod';
import { minutesSince } from '../lib/time';
import type { JobType, RawJob } from '../types';

/**
 * Shared vocabulary for the scoring package. This module is the leaf: every
 * other file under src/scoring imports from here and nothing here imports them,
 * which keeps the package free of cycles. It holds the dimension weights, the
 * structural views of the Job/Profile rows the rules read, and the small text
 * and number helpers those rules share.
 */

/* -------------------------------------------------------------- dimensions */

/**
 * Point budget, 100 points total. The numbers are "how much of a bid decision
 * this dimension is allowed to move", not a probability.
 *
 *   keywordMatch   16  does the posting talk about the work we want
 *   skillMatch     16  do our required/nice-to-have skills actually appear
 *   budgetFit      12  is the money in our band, or better
 *   clientQuality  12  payment verified, rating, review volume
 *   clientHistory  10  spend, hires, hire rate - do they actually close
 *   competition    10  how crowded the posting already is
 *   freshness      10  minutes-old postings win contracts, six-hour-old ones do not
 *   jobClarity      6  is the brief specific enough to write a real proposal
 *   categoryFit     5  is it in a category we sell into
 *   locationFit     3  client geography vs our allow list and stated restrictions
 *                 ---
 *                 100
 */
export const SCORING_DIMENSIONS = [
  'keywordMatch',
  'skillMatch',
  'budgetFit',
  'clientQuality',
  'clientHistory',
  'competition',
  'freshness',
  'jobClarity',
  'categoryFit',
  'locationFit',
] as const;

export type ScoringDimension = (typeof SCORING_DIMENSIONS)[number];

export type DimensionWeights = Record<ScoringDimension, number>;

export const DEFAULT_WEIGHTS: DimensionWeights = {
  keywordMatch: 16,
  skillMatch: 16,
  budgetFit: 12,
  clientQuality: 12,
  clientHistory: 10,
  competition: 10,
  freshness: 10,
  jobClarity: 6,
  categoryFit: 5,
  locationFit: 3,
};

export const DIMENSION_LABELS: Record<ScoringDimension, string> = {
  keywordMatch: 'Keyword match',
  skillMatch: 'Skill match',
  budgetFit: 'Budget fit',
  clientQuality: 'Client quality',
  clientHistory: 'Client history',
  competition: 'Competition',
  freshness: 'Freshness',
  jobClarity: 'Job clarity',
  categoryFit: 'Category fit',
  locationFit: 'Location fit',
};

/**
 * Weight keys older profiles may carry (they were authored against the generic
 * ScoringWeights shape in src/types). descriptionQuality is this package's
 * jobClarity; experienceFit is folded into categoryFit because the experience
 * level is enforced as a hard filter, not scored; llmRerank is ignored because
 * the LLM pass is blended in afterwards by blendScores(), not weighted here.
 */
const WEIGHT_ALIASES: Record<string, ScoringDimension> = {
  descriptionQuality: 'jobClarity',
  clarity: 'jobClarity',
  experienceFit: 'categoryFit',
  category: 'categoryFit',
  keywords: 'keywordMatch',
  skills: 'skillMatch',
  budget: 'budgetFit',
  client: 'clientQuality',
  history: 'clientHistory',
  location: 'locationFit',
};

const IGNORED_WEIGHT_KEYS = new Set(['llmRerank']);

const weightObjectSchema = z.record(z.string(), z.unknown());
const weightValueSchema = z.number().finite().nonnegative();

function isDimension(key: string): key is ScoringDimension {
  return (SCORING_DIMENSIONS as readonly string[]).includes(key);
}

function coerceWeight(value: unknown): number | null {
  const candidate = typeof value === 'string' ? Number(value.trim()) : value;
  const parsed = weightValueSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Rescales any set of relative weights so the dimensions sum to exactly 100. */
export function renormalizeWeights(weights: DimensionWeights): DimensionWeights {
  const total = SCORING_DIMENSIONS.reduce((sum, key) => sum + (weights[key] || 0), 0);
  if (!(total > 0)) return { ...DEFAULT_WEIGHTS };

  const scale = 100 / total;
  const out = {} as DimensionWeights;
  let running = 0;
  for (const key of SCORING_DIMENSIONS) {
    const value = round2(Math.max(0, weights[key] || 0) * scale);
    out[key] = value;
    running += value;
  }

  // Absorb the rounding residual into the heaviest dimension so the budget is
  // exactly 100 and a perfect job can actually reach a score of 100.
  let heaviest: ScoringDimension = SCORING_DIMENSIONS[0];
  for (const key of SCORING_DIMENSIONS) {
    if (out[key] > out[heaviest]) heaviest = key;
  }
  out[heaviest] = Math.max(0, round2(out[heaviest] + (100 - running)));
  return out;
}

/**
 * Merges a profile's `weights` JSON over DEFAULT_WEIGHTS and renormalises the
 * result to 100. Junk (strings that are not numbers, negatives, unknown keys,
 * arrays, null) is ignored rather than throwing: a bad override must never take
 * the pipeline down, it just falls back to the defaults for that dimension.
 */
export function resolveWeights(profileWeights: unknown): DimensionWeights {
  const merged: DimensionWeights = { ...DEFAULT_WEIGHTS };

  let source: unknown = profileWeights;
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source) as unknown;
    } catch {
      return renormalizeWeights(merged);
    }
  }

  const parsed = weightObjectSchema.safeParse(source);
  if (!parsed.success) return renormalizeWeights(merged);

  const entries = Object.entries(parsed.data);

  // Aliases first, canonical keys second, so an explicit `jobClarity` always
  // beats a legacy `descriptionQuality` in the same object.
  for (const [key, value] of entries) {
    if (IGNORED_WEIGHT_KEYS.has(key) || isDimension(key)) continue;
    const target = WEIGHT_ALIASES[key];
    if (!target) continue;
    const weight = coerceWeight(value);
    if (weight !== null) merged[target] = weight;
  }
  for (const [key, value] of entries) {
    if (!isDimension(key)) continue;
    const weight = coerceWeight(value);
    if (weight !== null) merged[key] = weight;
  }

  return renormalizeWeights(merged);
}

/* ---------------------------------------------------------- structural views */

/**
 * What the scorer needs from a job. Shaped so a Prisma `Job` row is assignable
 * as-is (flat client columns, string jobType) while staying usable in unit
 * tests without a database. Use fromRawJob() for a not-yet-persisted RawJob.
 */
export interface ScorableJob {
  id?: string;
  source?: string;
  externalId?: string;
  url?: string;
  title: string;
  description: string;
  skills: string[];
  category?: string | null;
  subcategory?: string | null;
  jobType: string;
  budgetAmount?: number | null;
  hourlyMin?: number | null;
  hourlyMax?: number | null;
  currency?: string | null;
  durationLabel?: string | null;
  experienceLevel?: string | null;
  workload?: string | null;
  connectsRequired?: number | null;
  proposalsCount?: number | null;
  interviewingCount?: number | null;
  clientCountry?: string | null;
  clientCity?: string | null;
  clientPaymentVerified?: boolean | null;
  clientTotalSpent?: number | null;
  clientTotalHires?: number | null;
  clientHireRate?: number | null;
  clientAvgRating?: number | null;
  clientReviewsCount?: number | null;
  clientMemberSince?: Date | string | null;
  clientOpenJobs?: number | null;
  /** Not columns on the Job table; present when a source could resolve them. */
  clientCompanyName?: string | null;
  clientId?: string | null;
  screeningQuestions?: string[];
  postedAt?: Date | string | null;
  firstSeenAt?: Date | string | null;
}

/** What the scorer needs from a profile. A Prisma `Profile` row is assignable. */
export interface ScoringProfile {
  id?: string;
  name?: string;
  includeKeywords: string[];
  excludeKeywords: string[];
  requiredSkills: string[];
  niceToHaveSkills: string[];
  categories: string[];
  jobTypes: string[];
  experienceLevels: string[];
  minFixedBudget?: number | null;
  maxFixedBudget?: number | null;
  minHourlyRate?: number | null;
  maxProposals?: number | null;
  maxJobAgeMinutes?: number | null;
  requirePaymentVerified?: boolean | null;
  minClientSpend?: number | null;
  minClientRating?: number | null;
  minClientHireRate?: number | null;
  minClientReviews?: number | null;
  allowedCountries: string[];
  blockedCountries: string[];
  blockedClients: string[];
  autoBidThreshold?: number | null;
  reviewThreshold?: number | null;
  weights?: unknown;
  useLlmRerank?: boolean | null;
  hourlyRate?: number | null;
  freelancerProfile?: string | null;
  portfolioHighlights?: string[];
}

/** Adapts a freshly fetched RawJob (nested client) to the flat scorer view. */
export function fromRawJob(raw: RawJob): ScorableJob {
  return {
    source: raw.source,
    externalId: raw.externalId,
    url: raw.url,
    title: raw.title,
    description: raw.description,
    skills: raw.skills,
    category: raw.category,
    subcategory: raw.subcategory,
    jobType: raw.jobType,
    budgetAmount: raw.budgetAmount,
    hourlyMin: raw.hourlyMin,
    hourlyMax: raw.hourlyMax,
    currency: raw.currency,
    durationLabel: raw.durationLabel,
    experienceLevel: raw.experienceLevel,
    workload: raw.workload,
    connectsRequired: raw.connectsRequired,
    proposalsCount: raw.proposalsCount,
    interviewingCount: raw.interviewingCount,
    clientCountry: raw.client.country,
    clientCity: raw.client.city,
    clientPaymentVerified: raw.client.paymentVerified,
    clientTotalSpent: raw.client.totalSpent,
    clientTotalHires: raw.client.totalHires,
    clientHireRate: raw.client.hireRate,
    clientAvgRating: raw.client.avgRating,
    clientReviewsCount: raw.client.reviewsCount,
    clientMemberSince: raw.client.memberSince,
    clientOpenJobs: raw.client.openJobs,
    clientCompanyName: raw.client.companyName ?? null,
    clientId: raw.client.clientId ?? null,
    screeningQuestions: raw.screeningQuestions,
    postedAt: raw.postedAt,
  };
}

/* ------------------------------------------------------------ text helpers */

export function normalizeText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

export function escapeRegex(value: string): string {
  return value.replace(REGEX_SPECIALS, '\\$&');
}

// Term regexes are rebuilt constantly (every job x every keyword), so cache
// them. Bounded so a pathological profile cannot grow the map without limit.
const TERM_PATTERNS = new Map<string, RegExp>();
const TERM_PATTERN_LIMIT = 2000;

function termPattern(term: string): RegExp | null {
  const needle = normalizeText(term);
  if (needle === '') return null;

  const cached = TERM_PATTERNS.get(needle);
  if (cached) return cached;

  // Word boundaries only where the term itself starts/ends alphanumerically,
  // so "c++", ".net" and "node.js" still match.
  const prefix = /^[a-z0-9]/.test(needle) ? '(?<![a-z0-9])' : '';
  const suffix = /[a-z0-9]$/.test(needle) ? '(?![a-z0-9])' : '';
  const pattern = new RegExp(`${prefix}${escapeRegex(needle)}${suffix}`);

  if (TERM_PATTERNS.size >= TERM_PATTERN_LIMIT) TERM_PATTERNS.clear();
  TERM_PATTERNS.set(needle, pattern);
  return pattern;
}

/** Whole-term containment on already-normalised text. */
export function containsTerm(haystack: string, term: string): boolean {
  const pattern = termPattern(term);
  if (!pattern) return false;
  return pattern.test(haystack);
}

export function normalizeSkills(skills: string[] | null | undefined): string[] {
  return (skills ?? []).map(normalizeText).filter((skill) => skill !== '');
}

export interface JobText {
  title: string;
  description: string;
  skills: string;
  questions: string;
  /** title + description + skills + screening questions, normalised. */
  all: string;
}

/** Pre-normalised text buckets so rules do not re-lowercase the description. */
export function jobText(job: ScorableJob): JobText {
  const title = normalizeText(job.title);
  const description = normalizeText(job.description);
  const skills = normalizeSkills(job.skills).join(' | ');
  const questions = (job.screeningQuestions ?? []).map(normalizeText).join(' | ');
  return {
    title,
    description,
    skills,
    questions,
    all: [title, description, skills, questions].filter(Boolean).join(' \n '),
  };
}

/* ---------------------------------------------------------- number helpers */

export function formatMoney(amount: number | null | undefined, currency?: string | null): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return 'unknown';
  const code = (currency ?? 'USD').trim().toUpperCase();
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: /^[A-Z]{3}$/.test(code) ? code : 'USD',
      maximumFractionDigits: amount >= 100 ? 0 : 2,
    }).format(amount);
  } catch {
    return `${Math.round(amount)} ${code}`;
  }
}

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'unknown';
  return new Intl.NumberFormat('en-US').format(Math.round(value));
}

/** Accepts a 0..1 fraction or an already-percentage 0..100 value. */
export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'unknown';
  const percent = value <= 1 ? value * 100 : value;
  return `${Math.round(percent)}%`;
}

export function isKnownNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Normalises the hire rate to a 0..1 fraction (sources send both shapes). */
export function normalizeHireRate(value: number | null | undefined): number | null {
  if (!isKnownNumber(value)) return null;
  if (value < 0) return null;
  return value > 1 ? clamp01(value / 100) : clamp01(value);
}

/* -------------------------------------------------------------- job shapes */

export function normalizeJobType(value: string | null | undefined): JobType {
  const normalized = normalizeText(value).replace(/[\s_-]+/g, '');
  if (normalized === 'hourly' || normalized === 'hourlyrate') return 'HOURLY';
  if (normalized === 'fixed' || normalized === 'fixedprice' || normalized === 'fixedbudget') {
    return 'FIXED';
  }
  return 'UNKNOWN';
}

export function normalizeExperienceLevel(value: string | null | undefined): string | null {
  const normalized = normalizeText(value).replace(/[\s_-]+/g, '');
  if (normalized === '') return null;
  if (normalized.startsWith('entry') || normalized === 'beginner' || normalized === 'junior') {
    return 'ENTRY';
  }
  if (normalized.startsWith('intermediate') || normalized === 'mid' || normalized === 'midlevel') {
    return 'INTERMEDIATE';
  }
  if (normalized.startsWith('expert') || normalized === 'senior' || normalized === 'advanced') {
    return 'EXPERT';
  }
  return normalized.toUpperCase();
}

/** Top of the posted hourly range, falling back to the bottom. Null if absent. */
export function effectiveHourlyRate(job: ScorableJob): number | null {
  if (isKnownNumber(job.hourlyMax) && job.hourlyMax > 0) return job.hourlyMax;
  if (isKnownNumber(job.hourlyMin) && job.hourlyMin > 0) return job.hourlyMin;
  return null;
}

export function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Minutes since the posting went live. Falls back to firstSeenAt (when we saw
 * it) and returns null when neither timestamp is usable, so callers can treat
 * an unknown age as neutral instead of infinitely old.
 */
export function jobAgeMinutes(job: ScorableJob, reference: Date = new Date()): number | null {
  const posted = toDate(job.postedAt) ?? toDate(job.firstSeenAt);
  if (!posted) return null;
  const age = minutesSince(posted, reference);
  if (!Number.isFinite(age)) return null;
  return Math.max(0, age);
}

export function countryEquals(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizeText(a);
  const right = normalizeText(b);
  return left !== '' && left === right;
}

/** Case-insensitive membership for country allow/block lists. */
export function listIncludes(list: string[] | null | undefined, value: string | null | undefined): boolean {
  const needle = normalizeText(value);
  if (needle === '') return false;
  return (list ?? []).some((entry) => normalizeText(entry) === needle);
}

export function wordCount(text: string | null | undefined): number {
  const trimmed = (text ?? '').trim();
  if (trimmed === '') return 0;
  return trimmed.split(/\s+/).length;
}

/** Number of "-", "*", "1." style list lines - a proxy for a structured brief. */
export function bulletCount(text: string | null | undefined): number {
  const lines = (text ?? '').split(/\r?\n/);
  let bullets = 0;
  for (const line of lines) {
    if (/^\s*(?:[-*\u2022\u00b7>]|\d{1,2}[.)])\s+\S/.test(line)) bullets += 1;
  }
  return bullets;
}

export function truncate(value: string, maxLength: number): string {
  const text = value ?? '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}
