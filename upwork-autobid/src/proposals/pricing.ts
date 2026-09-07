import {
  clamp,
  effectiveHourlyRate,
  formatMoney,
  isKnownNumber,
  normalizeJobType,
  normalizeText,
  type ScorableJob,
} from '../scoring/weights';
import type { JobType } from '../types';

/**
 * Leaf module of the drafting package: it owns the structural views the rest of
 * src/proposals builds against, plus every number that ends up on a proposal
 * (bid, rate, connects, duration). Nothing here imports another proposals file,
 * which keeps the package acyclic.
 */

/** A Prisma `Job` row is assignable as-is; so is `fromRawJob(raw)`. */
export type DraftJob = ScorableJob;

/** What drafting needs from a profile. A Prisma `Profile` row is assignable. */
export interface DraftProfile {
  id?: string;
  name?: string;
  includeKeywords?: string[];
  requiredSkills?: string[];
  niceToHaveSkills?: string[];
  categories?: string[];
  hourlyRate?: number | null;
  fixedBidStrategy?: string | null;
  fixedBidPercent?: number | null;
  minBid?: number | null;
  maxBid?: number | null;
  maxDailyConnects?: number | null;
  freelancerProfile?: string | null;
  portfolioHighlights?: string[];
  proposalTone?: string | null;
  proposalMaxChars?: number | null;
  proposalLanguage?: string | null;
  customInstructions?: string | null;
}

export const FIXED_BID_STRATEGIES = ['PERCENT_OF_BUDGET', 'FLAT', 'HOURLY_ESTIMATE'] as const;
export type FixedBidStrategy = (typeof FIXED_BID_STRATEGIES)[number];

/** What actually produced the number, which is not always what was requested. */
export type AppliedStrategy = FixedBidStrategy | 'HOURLY_RANGE' | 'UNPRICED';

export const DEFAULT_FIXED_BID_PERCENT = 0.9;
export const DEFAULT_HOURS_PER_WEEK = 20;
export const DEFAULT_CONNECTS = 4;
export const MAX_CONNECTS = 16;

/** Where in the client's posted hourly range we aim when both ends are known. */
export const HOURLY_RANGE_TARGET = 0.8;

export function normalizeFixedBidStrategy(value: string | null | undefined): FixedBidStrategy {
  const normalized = normalizeText(value).replace(/[\s-]+/g, '_');
  const match = FIXED_BID_STRATEGIES.find((strategy) => strategy.toLowerCase() === normalized);
  return match ?? 'PERCENT_OF_BUDGET';
}

export function currencyOf(job: DraftJob): string {
  const code = (job.currency ?? 'USD').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : 'USD';
}

function positive(value: number | null | undefined): number | null {
  return isKnownNumber(value) && value > 0 ? value : null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/* ------------------------------------------------------------------ effort */

export interface EffortEstimate {
  /** The Upwork duration bucket we matched, or null when nothing was posted. */
  bucket: string | null;
  label: string;
  weeks: number;
  hoursPerWeek: number;
  /** Hours across the horizon for an hourly engagement. */
  hourlyHours: number;
  /** Hours a fixed-price deliverable of this size plausibly takes. */
  fixedHours: number;
}

interface DurationBucket {
  id: string;
  label: string;
  test: RegExp;
  weeks: number;
  fixedHours: number;
}

/**
 * Ordered longest-first so "more than 6 months" is not swallowed by the
 * "6 months" fragment inside the 3-6 bucket.
 */
const DURATION_BUCKETS: readonly DurationBucket[] = [
  {
    id: 'gt6m',
    label: 'More than 6 months',
    test: /more than 6 months|over 6 months|6\+\s*months|long[- ]term|ongoing|indefinite/,
    weeks: 26,
    fixedHours: 200,
  },
  {
    id: '3to6m',
    label: '3 to 6 months',
    test: /3 to 6 months|3-6 months|three to six months|quarter/,
    weeks: 18,
    fixedHours: 120,
  },
  {
    id: '1to3m',
    label: '1 to 3 months',
    test: /1 to 3 months|1-3 months|one to three months|couple of months|two months/,
    weeks: 8,
    fixedHours: 60,
  },
  {
    id: 'lt1m',
    label: 'Less than 1 month',
    test: /less than (?:1|a|one) month|under (?:1|a|one) month|within (?:1|a|one) month|30 days|few weeks|2-4 weeks/,
    weeks: 3,
    fixedHours: 20,
  },
  {
    id: 'lt1w',
    label: 'Less than 1 week',
    test: /less than (?:1|a|one) week|under (?:1|a|one) week|(?:this|next) week|few days|couple of days|asap|urgent/,
    weeks: 1,
    fixedHours: 8,
  },
];

const BUCKET_BY_ID = new Map<string, DurationBucket>(
  DURATION_BUCKETS.map((bucket) => [bucket.id, bucket]),
);

function bucketOrDefault(id: string): DurationBucket {
  return BUCKET_BY_ID.get(id) ?? DURATION_BUCKETS[2];
}

function matchDurationBucket(job: DraftJob): DurationBucket | null {
  const posted = normalizeText(job.durationLabel);
  const haystacks = posted === '' ? [normalizeText(job.description).slice(0, 600)] : [posted];
  for (const haystack of haystacks) {
    if (haystack === '') continue;
    for (const bucket of DURATION_BUCKETS) {
      if (bucket.test.test(haystack)) return bucket;
    }
  }
  return null;
}

/** Budget stands in for scope when the posting carries no duration at all. */
function bucketFromBudget(job: DraftJob): DurationBucket {
  const budget = positive(job.budgetAmount);
  if (budget === null) return bucketOrDefault(normalizeJobType(job.jobType) === 'HOURLY' ? '1to3m' : 'lt1m');
  if (budget < 300) return bucketOrDefault('lt1w');
  if (budget < 1500) return bucketOrDefault('lt1m');
  if (budget < 6000) return bucketOrDefault('1to3m');
  return bucketOrDefault('3to6m');
}

export function hoursPerWeekFor(job: DraftJob): number {
  const workload = normalizeText(job.workload);
  if (workload !== '') {
    if (/more than 30|over 30|full[- ]?time|40\+|40 hrs/.test(workload)) return 35;
    if (/less than 30|under 30|part[- ]?time|10-30|hrs\/week/.test(workload)) return 15;
    const explicit = /(\d{1,2})\s*(?:\+)?\s*hrs?/.exec(workload);
    if (explicit) {
      const hours = Number(explicit[1]);
      if (Number.isFinite(hours) && hours > 0) return clamp(hours, 4, 45);
    }
  }
  return DEFAULT_HOURS_PER_WEEK;
}

/** Weeks, weekly load and total hours behind the human duration label. */
export function estimateEffort(job: DraftJob): EffortEstimate {
  const matched = matchDurationBucket(job);
  const bucket = matched ?? bucketFromBudget(job);
  const hoursPerWeek = hoursPerWeekFor(job);
  return {
    bucket: matched ? matched.id : null,
    label: bucket.label,
    weeks: bucket.weeks,
    hoursPerWeek,
    hourlyHours: Math.round(bucket.weeks * hoursPerWeek),
    fixedHours: bucket.fixedHours,
  };
}

/**
 * Human duration label for the proposal. Prefers what the client posted and
 * appends the weekly load for hourly work, because "1 to 3 months" alone tells
 * the client nothing about the commitment they are buying.
 */
export function estimateDuration(job: DraftJob): string {
  const effort = estimateEffort(job);
  const posted = (job.durationLabel ?? '').trim();
  const base = posted !== '' ? posted : effort.label;

  if (normalizeJobType(job.jobType) === 'HOURLY') {
    return `${base}, about ${effort.hoursPerWeek} hrs/week`;
  }
  return base;
}

/* ---------------------------------------------------------------- connects */

interface ConnectsRung {
  maxValue: number;
  connects: number;
}

/**
 * Upwork prices connects by job value and does not publish the table, so this
 * ladder is an estimate used only for quota accounting. `connectsRequired` from
 * the source always wins when present.
 */
export const CONNECTS_LADDER: readonly ConnectsRung[] = [
  { maxValue: 50, connects: 2 },
  { maxValue: 200, connects: 4 },
  { maxValue: 1000, connects: 6 },
  { maxValue: 5000, connects: 8 },
  { maxValue: Number.POSITIVE_INFINITY, connects: 10 },
];

/** Money the engagement is worth, used only to pick a connects rung. */
function jobValueProxy(job: DraftJob): number | null {
  if (normalizeJobType(job.jobType) === 'HOURLY') {
    const rate = effectiveHourlyRate(job);
    return rate === null ? null : rate * 40;
  }
  return positive(job.budgetAmount);
}

export function estimateConnects(job: DraftJob): number {
  const required = job.connectsRequired;
  if (isKnownNumber(required) && required > 0) {
    return Math.min(MAX_CONNECTS, Math.round(required));
  }

  const value = jobValueProxy(job);
  if (value === null) return DEFAULT_CONNECTS;

  for (const rung of CONNECTS_LADDER) {
    if (value <= rung.maxValue) return rung.connects;
  }
  return DEFAULT_CONNECTS;
}

/* ----------------------------------------------------------------- rounding */

/** Bid granularity by magnitude: nobody quotes $1,743 for a $1,750 job. */
export function bidStep(amount: number): number {
  const value = Math.abs(amount);
  if (value < 200) return 5;
  if (value < 1000) return 25;
  if (value < 5000) return 50;
  return 100;
}

/**
 * Rounds to the nearest sane step, then pulls back inside [min, max]. When the
 * two bounds contradict each other (min > max, a misconfigured profile) the
 * floor wins: we would rather skip the job than work below the stated minimum.
 */
export function roundBid(amount: number, min: number | null = null, max: number | null = null): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const step = bidStep(amount);
  let rounded = Math.round(amount / step) * step;
  if (max !== null && rounded > max) rounded = Math.floor(max / step) * step;
  if (min !== null && rounded < min) rounded = Math.ceil(min / step) * step;
  if (max !== null && (min === null || min <= max) && rounded > max) rounded = max;
  if (min !== null && rounded < min) rounded = min;
  return round2(Math.max(step, rounded));
}

/** Hourly rates round to whole dollars, or to $5 once the rate is senior-level. */
export function roundRate(rate: number, floor: number | null = null, ceiling: number | null = null): number {
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  const step = rate < 30 ? 1 : 5;
  let rounded = Math.round(rate / step) * step;
  if (ceiling !== null && rounded > ceiling) rounded = Math.floor(ceiling / step) * step;
  if (floor !== null && rounded < floor) rounded = Math.ceil(floor / step) * step;
  if (ceiling !== null && (floor === null || floor <= ceiling) && rounded > ceiling) rounded = ceiling;
  if (floor !== null && rounded < floor) rounded = floor;
  return round2(Math.max(1, rounded));
}

/* --------------------------------------------------------------------- bid */

export interface BidComputation {
  jobType: JobType;
  currency: string;
  /** What produced the number, which can differ from the requested strategy. */
  strategy: AppliedStrategy;
  /** Fixed-price total. Null for hourly jobs and for unpriceable postings. */
  bidAmount: number | null;
  /** Hourly rate. Null for fixed-price jobs. */
  hourlyRate: number | null;
  estimatedDurationLabel: string;
  /** Hours behind an HOURLY_ESTIMATE fixed bid, or the hourly horizon. */
  estimatedHours: number | null;
  estimatedWeeklyHours: number | null;
  connectsCost: number;
  /** True when a profile or client bound moved the raw number. */
  clamped: boolean;
  rationale: string;
}

function hourlyEstimateFor(job: DraftJob, profile: DraftProfile, effort: EffortEstimate): number | null {
  const rate = positive(profile.hourlyRate) ?? effectiveHourlyRate(job);
  if (rate === null) return null;
  return rate * effort.fixedHours;
}

function computeFixedBid(
  job: DraftJob,
  profile: DraftProfile,
  effort: EffortEstimate,
): { amount: number | null; strategy: AppliedStrategy; basis: string } {
  const requested = normalizeFixedBidStrategy(profile.fixedBidStrategy);
  const budget = positive(job.budgetAmount);
  const percent = clamp(
    isKnownNumber(profile.fixedBidPercent) ? profile.fixedBidPercent : DEFAULT_FIXED_BID_PERCENT,
    0.1,
    1.5,
  );
  const currency = currencyOf(job);

  if (requested === 'PERCENT_OF_BUDGET' && budget !== null) {
    return {
      amount: budget * percent,
      strategy: 'PERCENT_OF_BUDGET',
      basis: `${Math.round(percent * 100)}% of the posted ${formatMoney(budget, currency)} budget`,
    };
  }

  if (requested === 'FLAT') {
    const flat = positive(profile.minBid) ?? positive(profile.maxBid);
    if (flat !== null) {
      return { amount: flat, strategy: 'FLAT', basis: `flat package price of ${formatMoney(flat, currency)}` };
    }
  }

  if (requested === 'HOURLY_ESTIMATE' || requested === 'FLAT' || budget === null) {
    const estimate = hourlyEstimateFor(job, profile, effort);
    if (estimate !== null) {
      const rate = positive(profile.hourlyRate) ?? effectiveHourlyRate(job) ?? 0;
      return {
        amount: estimate,
        strategy: 'HOURLY_ESTIMATE',
        basis: `${effort.fixedHours}h of work at ${formatMoney(rate, currency)}/hr`,
      };
    }
  }

  if (budget !== null) {
    return {
      amount: budget * percent,
      strategy: 'PERCENT_OF_BUDGET',
      basis: `${Math.round(percent * 100)}% of the posted ${formatMoney(budget, currency)} budget`,
    };
  }

  return { amount: null, strategy: 'UNPRICED', basis: 'no posted budget and no rate on the profile' };
}

function computeHourlyRate(
  job: DraftJob,
  profile: DraftProfile,
): { rate: number | null; basis: string; belowFloor: boolean } {
  const floor = positive(profile.hourlyRate);
  const ceiling = positive(job.hourlyMax);
  const bottom = positive(job.hourlyMin);
  const currency = currencyOf(job);

  let target: number | null = null;
  let basis: string;

  if (bottom !== null && ceiling !== null && ceiling > bottom) {
    // Aim high inside the posted band: clients anchor on the top, not the mid.
    target = bottom + (ceiling - bottom) * HOURLY_RANGE_TARGET;
    basis = `${Math.round(HOURLY_RANGE_TARGET * 100)}% into the posted ${formatMoney(bottom, currency)}-${formatMoney(ceiling, currency)} range`;
  } else if (ceiling !== null) {
    target = ceiling;
    basis = `the top of the posted range (${formatMoney(ceiling, currency)}/hr)`;
  } else if (bottom !== null) {
    target = Math.max(bottom, floor ?? bottom);
    basis = `the posted floor of ${formatMoney(bottom, currency)}/hr`;
  } else if (floor !== null) {
    target = floor;
    basis = 'the profile rate (the client posted no range)';
  } else {
    return { rate: null, basis: 'no posted range and no rate on the profile', belowFloor: false };
  }

  const belowFloor = floor !== null && ceiling !== null && floor > ceiling;
  const rate = roundRate(target, floor, belowFloor ? null : ceiling);
  return { rate, basis, belowFloor };
}

/**
 * Turns a job plus a profile into the numbers that go on the proposal. Pure and
 * synchronous: the model may later suggest its own figures, but these are the
 * ones the pipeline falls back to and the ones guardrails clamp against.
 */
export function computeBid(job: DraftJob, profile: DraftProfile): BidComputation {
  const jobType = normalizeJobType(job.jobType);
  const currency = currencyOf(job);
  const effort = estimateEffort(job);
  const connectsCost = estimateConnects(job);
  const estimatedDurationLabel = estimateDuration(job);

  if (jobType === 'HOURLY') {
    const { rate, basis, belowFloor } = computeHourlyRate(job, profile);
    const notes = [
      rate === null ? 'No rate could be derived' : `Bidding ${formatMoney(rate, currency)}/hr based on ${basis}`,
      `Expecting about ${effort.hoursPerWeek} hrs/week over ${effort.label.toLowerCase()}`,
      belowFloor
        ? 'The posted ceiling is below the profile rate, so the profile floor was kept'
        : '',
      `${connectsCost} connects`,
    ].filter((note) => note !== '');

    return {
      jobType,
      currency,
      strategy: rate === null ? 'UNPRICED' : 'HOURLY_RANGE',
      bidAmount: null,
      hourlyRate: rate,
      estimatedDurationLabel,
      estimatedHours: effort.hourlyHours,
      estimatedWeeklyHours: effort.hoursPerWeek,
      connectsCost,
      clamped: belowFloor,
      rationale: notes.join('. ') + '.',
    };
  }

  const { amount, strategy, basis } = computeFixedBid(job, profile, effort);
  const min = positive(profile.minBid);
  const max = positive(profile.maxBid);

  if (amount === null) {
    return {
      jobType,
      currency,
      strategy: 'UNPRICED',
      bidAmount: null,
      hourlyRate: null,
      estimatedDurationLabel,
      estimatedHours: effort.fixedHours,
      estimatedWeeklyHours: null,
      connectsCost,
      clamped: false,
      rationale: `No bid could be computed: ${basis}. ${connectsCost} connects.`,
    };
  }

  const bounded = clamp(amount, min ?? 0, max ?? Number.MAX_SAFE_INTEGER);
  const rounded = roundBid(bounded, min, max);
  const clamped = Math.abs(rounded - amount) > bidStep(amount) / 2;

  const notes = [
    `Bidding ${formatMoney(rounded, currency)} from ${basis}`,
    strategy === 'HOURLY_ESTIMATE' ? `Scope estimated at ${effort.fixedHours}h over ${effort.label.toLowerCase()}` : '',
    min !== null && rounded <= min ? `Held at the profile minimum of ${formatMoney(min, currency)}` : '',
    max !== null && rounded >= max ? `Held at the profile maximum of ${formatMoney(max, currency)}` : '',
    `${connectsCost} connects`,
  ].filter((note) => note !== '');

  return {
    jobType,
    currency,
    strategy,
    bidAmount: rounded,
    hourlyRate: null,
    estimatedDurationLabel,
    estimatedHours: effort.fixedHours,
    estimatedWeeklyHours: null,
    connectsCost,
    clamped,
    rationale: notes.join('. ') + '.',
  };
}

/** One-line money summary reused by templates, prompts and notifications. */
export function describeBid(bid: BidComputation): string {
  if (bid.hourlyRate !== null) {
    const weekly = bid.estimatedWeeklyHours === null ? '' : `, about ${bid.estimatedWeeklyHours} hrs/week`;
    return `${formatMoney(bid.hourlyRate, bid.currency)}/hr${weekly}`;
  }
  if (bid.bidAmount !== null) {
    return `${formatMoney(bid.bidAmount, bid.currency)} fixed`;
  }
  return 'no price computed';
}
