import { humanizeAge } from '../lib/time';
import type { Decision, ScoreBreakdownItem, ScoreResult } from '../types';
import { applyHardFilters } from './hard-filters';
import { detectRedFlags, hasVetoFlag, redFlagPenalty } from './red-flags';
import {
  DIMENSION_LABELS,
  SCORING_DIMENSIONS,
  type DimensionWeights,
  type ScorableJob,
  type ScoringDimension,
  type ScoringProfile,
  bulletCount,
  clamp,
  clamp01,
  containsTerm,
  effectiveHourlyRate,
  formatCount,
  formatMoney,
  formatPercent,
  isKnownNumber,
  jobAgeMinutes,
  jobText,
  listIncludes,
  normalizeHireRate,
  normalizeJobType,
  normalizeSkills,
  normalizeText,
  resolveWeights,
  round2,
  truncate,
  wordCount,
  type JobText,
} from './weights';

/**
 * The rules engine. scoreJob() is pure and synchronous: same job plus same
 * profile always produces the same result, no I/O, no clock reads beyond the
 * reference date the caller passes in. The optional LLM pass lives in
 * llm-rerank.ts and is blended on top by index.ts.
 *
 * Unknown data scores neutral (roughly half the dimension), never zero. Upwork
 * hides client statistics on a large share of postings and treating "unknown"
 * as "bad" would bias the whole pipeline towards the few clients who publish
 * everything.
 */

/** Reference fixed budget used when a profile sets no floor of its own. */
const DEFAULT_FIXED_TARGET = 500;
/** Reference hourly rate used when a profile sets neither a floor nor a rate. */
const DEFAULT_HOURLY_TARGET = 40;

interface DimensionOutcome {
  fraction: number;
  detail: string;
}

interface KeywordOutcome extends DimensionOutcome {
  matched: string[];
}

function normalizedList(values: string[] | null | undefined): string[] {
  return (values ?? []).map(normalizeText).filter((value) => value !== '');
}

function uniq(values: string[]): string[] {
  return Array.from(new Set(values));
}

/* ----------------------------------------------------------- dimension: keywords */

function scoreKeywords(text: JobText, profile: ScoringProfile): KeywordOutcome {
  const keywords = uniq(normalizedList(profile.includeKeywords));
  if (keywords.length === 0) {
    return { fraction: 0.6, detail: 'no include keywords configured; scored neutral', matched: [] };
  }

  const matched: string[] = [];
  const inTitle: string[] = [];
  for (const keyword of keywords) {
    const titleHit = containsTerm(text.title, keyword);
    if (titleHit) inTitle.push(keyword);
    if (titleHit || containsTerm(text.skills, keyword) || containsTerm(text.description, keyword)) {
      matched.push(keyword);
    }
  }

  const coverage = matched.length / keywords.length;
  const fraction = clamp01(coverage * 0.85 + (inTitle.length > 0 ? 0.15 : 0));
  const sample = matched.slice(0, 5).join(', ');
  const detail =
    matched.length === 0
      ? `none of the ${keywords.length} include keywords appear in the posting`
      : `matched ${matched.length} of ${keywords.length} keywords (${sample}${matched.length > 5 ? ', ...' : ''})` +
        (inTitle.length > 0 ? `; ${inTitle.length} in the title` : '; none in the title');

  return { fraction, detail, matched };
}

/* -------------------------------------------------------------- dimension: skills */

function skillPresent(skill: string, text: JobText, jobSkills: string[]): boolean {
  if (jobSkills.some((jobSkill) => jobSkill === skill || containsTerm(jobSkill, skill))) return true;
  return containsTerm(text.all, skill);
}

function scoreSkills(job: ScorableJob, text: JobText, profile: ScoringProfile): KeywordOutcome {
  const jobSkills = normalizeSkills(job.skills);
  const required = uniq(normalizedList(profile.requiredSkills));
  const nice = uniq(normalizedList(profile.niceToHaveSkills)).filter(
    (skill) => !required.includes(skill),
  );

  if (required.length === 0 && nice.length === 0) {
    return { fraction: 0.6, detail: 'no skills configured on the profile; scored neutral', matched: [] };
  }

  const matchedRequired = required.filter((skill) => skillPresent(skill, text, jobSkills));
  const matchedNice = nice.filter((skill) => skillPresent(skill, text, jobSkills));
  const matched = uniq([...matchedRequired, ...matchedNice]);

  const requiredCoverage = required.length > 0 ? matchedRequired.length / required.length : null;
  const niceCoverage = nice.length > 0 ? matchedNice.length / nice.length : null;

  let fraction: number;
  if (requiredCoverage !== null && niceCoverage !== null) {
    fraction = 0.65 * requiredCoverage + 0.35 * niceCoverage;
  } else if (requiredCoverage !== null) {
    fraction = requiredCoverage;
  } else {
    fraction = 0.45 + 0.55 * (niceCoverage ?? 0);
  }

  const parts: string[] = [];
  if (required.length > 0) parts.push(`${matchedRequired.length}/${required.length} required`);
  if (nice.length > 0) parts.push(`${matchedNice.length}/${nice.length} nice-to-have`);
  const sample = matched.slice(0, 5).join(', ');
  const detail = `${parts.join(' and ')} skills present${sample ? ` (${sample})` : ''}`;

  return { fraction: clamp01(fraction), detail, matched };
}

/* -------------------------------------------------------------- dimension: budget */

/** How good is `ratio` = offered / target. 1.0 is "exactly our floor". */
function ratioCurve(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 0;
  if (ratio < 0.5) return 0.1;
  if (ratio < 1) return 0.1 + (0.4 * (ratio - 0.5)) / 0.5;
  if (ratio < 2) return 0.5 + 0.25 * (ratio - 1);
  if (ratio < 5) return 0.75 + (0.25 * (ratio - 2)) / 3;
  return 1;
}

function scoreBudget(job: ScorableJob, profile: ScoringProfile): DimensionOutcome {
  const currency = job.currency;
  const jobType = normalizeJobType(job.jobType);
  const hourly = effectiveHourlyRate(job);
  const budget = isKnownNumber(job.budgetAmount) && job.budgetAmount > 0 ? job.budgetAmount : null;

  const preferHourly = jobType === 'HOURLY' || (jobType === 'UNKNOWN' && budget === null);

  if (preferHourly) {
    if (hourly === null) {
      return {
        fraction: 0.45,
        detail: 'hourly job with no posted rate range; scored neutral',
      };
    }
    const target =
      (isKnownNumber(profile.minHourlyRate) && profile.minHourlyRate > 0
        ? profile.minHourlyRate
        : null) ??
      (isKnownNumber(profile.hourlyRate) && profile.hourlyRate > 0 ? profile.hourlyRate : null) ??
      DEFAULT_HOURLY_TARGET;
    const ratio = hourly / target;
    const range =
      isKnownNumber(job.hourlyMin) && isKnownNumber(job.hourlyMax) && job.hourlyMin !== job.hourlyMax
        ? `${formatMoney(job.hourlyMin, currency)}-${formatMoney(job.hourlyMax, currency)}/hr`
        : `${formatMoney(hourly, currency)}/hr`;
    return {
      fraction: ratioCurve(ratio),
      detail: `${range} is ${ratio.toFixed(2)}x the ${formatMoney(target, currency)}/hr target`,
    };
  }

  if (budget === null) {
    return { fraction: 0.45, detail: 'no budget disclosed; scored neutral' };
  }

  const target =
    (isKnownNumber(profile.minFixedBudget) && profile.minFixedBudget > 0
      ? profile.minFixedBudget
      : null) ??
    (isKnownNumber(profile.hourlyRate) && profile.hourlyRate > 0 ? profile.hourlyRate * 20 : null) ??
    DEFAULT_FIXED_TARGET;
  const ratio = budget / target;
  return {
    fraction: ratioCurve(ratio),
    detail: `fixed budget ${formatMoney(budget, currency)} is ${ratio.toFixed(2)}x the ${formatMoney(target, currency)} target`,
  };
}

/* ------------------------------------------------------ dimension: client quality */

function scoreClientQuality(job: ScorableJob): DimensionOutcome {
  const verified = job.clientPaymentVerified;
  const paymentScore = verified === true ? 1 : verified === false ? 0.05 : 0.5;

  const rating = isKnownNumber(job.clientAvgRating) && job.clientAvgRating > 0 ? job.clientAvgRating : null;
  const ratingScore =
    rating === null ? 0.5 : rating < 3.5 ? 0.05 : clamp01((rating - 3.5) / 1.5);

  const reviews = isKnownNumber(job.clientReviewsCount) ? job.clientReviewsCount : null;
  const reviewScore =
    reviews === null ? 0.5 : 0.3 + 0.7 * clamp01(Math.log10(1 + Math.max(0, reviews)) / Math.log10(21));

  const parts = [
    verified === true ? 'payment verified' : verified === false ? 'payment NOT verified' : 'payment status unknown',
    rating === null ? 'no rating yet' : `${rating.toFixed(2)} stars`,
    reviews === null ? 'review count unknown' : `${formatCount(reviews)} reviews`,
  ];

  return {
    fraction: clamp01(0.45 * paymentScore + 0.35 * ratingScore + 0.2 * reviewScore),
    detail: parts.join(', '),
  };
}

/* ------------------------------------------------------ dimension: client history */

function scoreClientHistory(job: ScorableJob): DimensionOutcome {
  const spent = isKnownNumber(job.clientTotalSpent) ? Math.max(0, job.clientTotalSpent) : null;
  const spendScore =
    spent === null ? 0.5 : spent === 0 ? 0.2 : clamp01(Math.log10(spent) / Math.log10(100000));

  const hires = isKnownNumber(job.clientTotalHires) ? Math.max(0, job.clientTotalHires) : null;
  const hireScore =
    hires === null ? 0.5 : hires === 0 ? 0.25 : 0.3 + 0.7 * clamp01(Math.log10(1 + hires) / Math.log10(51));

  const hireRate = normalizeHireRate(job.clientHireRate);
  const hireRateScore = hireRate === null ? 0.5 : hireRate < 0.1 ? 0.15 : clamp01(hireRate / 0.7);

  const parts: string[] = [];
  parts.push(spent === null ? 'spend unknown' : `client spent ${formatMoney(spent, job.currency)}`);
  parts.push(hires === null ? 'hire count unknown' : `across ${formatCount(hires)} hires`);
  if (hireRate !== null) parts.push(`hire rate ${formatPercent(hireRate)}`);
  if (isKnownNumber(job.clientOpenJobs) && job.clientOpenJobs > 0) {
    parts.push(`${formatCount(job.clientOpenJobs)} open jobs`);
  }

  return {
    fraction: clamp01(0.4 * spendScore + 0.3 * hireScore + 0.3 * hireRateScore),
    detail: parts.join(', '),
  };
}

/* --------------------------------------------------------- dimension: competition */

function scoreCompetition(job: ScorableJob): DimensionOutcome {
  const proposals = isKnownNumber(job.proposalsCount) ? Math.max(0, job.proposalsCount) : null;
  if (proposals === null) {
    return { fraction: 0.55, detail: 'proposal count not disclosed; scored neutral' };
  }

  let fraction = Math.exp(-proposals / 18);
  const interviewing = isKnownNumber(job.interviewingCount) ? Math.max(0, job.interviewingCount) : 0;
  if (interviewing > 0) {
    // The client is already talking to people; a late proposal rarely wins.
    fraction *= clamp(1 - 0.12 * interviewing, 0.4, 1);
  }

  const detail =
    `${formatCount(proposals)} proposal${proposals === 1 ? '' : 's'} already submitted` +
    (interviewing > 0 ? `, ${formatCount(interviewing)} candidate(s) interviewing` : '');

  return { fraction: clamp01(fraction), detail };
}

/* ----------------------------------------------------------- dimension: freshness */

const FRESHNESS_STEPS: { maxMinutes: number; fraction: number }[] = [
  { maxMinutes: 2, fraction: 1 },
  { maxMinutes: 5, fraction: 0.96 },
  { maxMinutes: 10, fraction: 0.9 },
  { maxMinutes: 20, fraction: 0.8 },
  { maxMinutes: 30, fraction: 0.7 },
  { maxMinutes: 45, fraction: 0.6 },
  { maxMinutes: 60, fraction: 0.55 },
  { maxMinutes: 120, fraction: 0.42 },
  { maxMinutes: 240, fraction: 0.3 },
  { maxMinutes: 360, fraction: 0.22 },
  { maxMinutes: 720, fraction: 0.12 },
  { maxMinutes: 1440, fraction: 0.06 },
];

function scoreFreshness(job: ScorableJob, reference: Date): DimensionOutcome {
  const age = jobAgeMinutes(job, reference);
  if (age === null) {
    return { fraction: 0.4, detail: 'posting time unknown; scored neutral' };
  }

  const step = FRESHNESS_STEPS.find((entry) => age <= entry.maxMinutes);
  const fraction = step ? step.fraction : 0.02;
  const posted = job.postedAt ?? job.firstSeenAt ?? null;
  const note =
    age <= 10
      ? ' - inside the first-ten-minutes window where bids actually get read'
      : age <= 60
        ? ' - still early'
        : age <= 360
          ? ' - the shortlist is probably forming'
          : ' - almost certainly too late';

  return { fraction, detail: `posted ${humanizeAge(posted, reference)}${note}` };
}

/* --------------------------------------------------------------- dimension: clarity */

const SPECIFICITY_SIGNALS = [
  'deadline',
  'timeline',
  'milestone',
  'deliverable',
  'acceptance criteria',
  'scope',
  'figma',
  'repository',
  'documentation',
  'api',
  'stack',
  'budget',
];

function scoreClarity(job: ScorableJob, text: JobText): DimensionOutcome {
  const words = wordCount(job.description);
  const lengthScore =
    words < 30
      ? 0.1
      : words < 60
        ? 0.4
        : words < 120
          ? 0.65
          : words < 200
            ? 0.85
            : words <= 800
              ? 1
              : words <= 1500
                ? 0.85
                : 0.7;

  const bullets = bulletCount(job.description);
  const questions = (job.screeningQuestions ?? []).filter((q) => normalizeText(q) !== '').length;
  const signals = SPECIFICITY_SIGNALS.filter((signal) => containsTerm(text.description, signal));
  const budgetDisclosed = isKnownNumber(job.budgetAmount) || effectiveHourlyRate(job) !== null;

  const fraction = clamp01(
    0.65 * lengthScore +
      (bullets >= 3 ? 0.12 : bullets > 0 ? 0.06 : 0) +
      (questions > 0 ? 0.1 : 0) +
      Math.min(0.12, signals.length * 0.03) +
      (budgetDisclosed ? 0.06 : 0),
  );

  const parts = [`${words} words`];
  if (bullets > 0) parts.push(`${bullets} bullet points`);
  if (questions > 0) parts.push(`${questions} screening question${questions === 1 ? '' : 's'}`);
  if (signals.length > 0) parts.push(`mentions ${signals.slice(0, 3).join('/')}`);
  if (!budgetDisclosed) parts.push('no budget stated');

  return { fraction, detail: parts.join(', ') };
}

/* -------------------------------------------------------------- dimension: category */

function tokens(value: string): string[] {
  return value.split(/[^a-z0-9+#.]+/).filter((token) => token.length >= 4);
}

function scoreCategory(job: ScorableJob, text: JobText, profile: ScoringProfile): DimensionOutcome {
  const categories = uniq(normalizedList(profile.categories));
  if (categories.length === 0) {
    return { fraction: 0.6, detail: 'no categories configured; scored neutral' };
  }

  const jobCategories = [normalizeText(job.category), normalizeText(job.subcategory)].filter(
    (value) => value !== '',
  );

  if (jobCategories.length === 0) {
    const inferred = categories.find((category) => containsTerm(text.all, category));
    return inferred
      ? { fraction: 0.7, detail: `no category on the posting; text mentions "${inferred}"` }
      : { fraction: 0.45, detail: 'no category on the posting; scored neutral' };
  }

  for (const category of categories) {
    for (const jobCategory of jobCategories) {
      if (jobCategory === category) {
        return { fraction: 1, detail: `category "${jobCategory}" is an exact profile match` };
      }
    }
  }

  for (const category of categories) {
    for (const jobCategory of jobCategories) {
      if (containsTerm(jobCategory, category) || containsTerm(category, jobCategory)) {
        return { fraction: 0.8, detail: `category "${jobCategory}" overlaps profile category "${category}"` };
      }
    }
  }

  const profileTokens = new Set(categories.flatMap(tokens));
  const shared = jobCategories.flatMap(tokens).filter((token) => profileTokens.has(token));
  if (shared.length > 0) {
    return {
      fraction: 0.6,
      detail: `category "${jobCategories[0]}" shares "${uniq(shared).slice(0, 3).join(', ')}" with the profile`,
    };
  }

  return {
    fraction: 0.15,
    detail: `category "${jobCategories[0]}" is outside the configured categories`,
  };
}

/* -------------------------------------------------------------- dimension: location */

const LOCATION_RESTRICTION = [
  /\b(?:u\.?s\.?a?|usa|uk|canada|canadian|australia|europe|eu|german|dach|nordic)[- ]?(?:based\s+)?(?:candidates?\s+|freelancers?\s+|applicants?\s+)?only\b/,
  /\bmust be (?:located|based|residing) in\b/,
  /\bonly (?:candidates|freelancers|applicants|developers) (?:from|in|located in|based in)\b/,
  /\bno (?:offshore|outsourcing|agencies from)\b/,
  /\b(?:native|fluent) (?:english|german|french|spanish) speakers? only\b/,
];

function scoreLocation(job: ScorableJob, text: JobText, profile: ScoringProfile): DimensionOutcome {
  const country = normalizeText(job.clientCountry);
  const allowed = normalizedList(profile.allowedCountries);

  let fraction: number;
  let detail: string;

  if (country === '') {
    fraction = 0.5;
    detail = 'client country not disclosed; scored neutral';
  } else if (listIncludes(profile.blockedCountries, job.clientCountry)) {
    fraction = 0;
    detail = `client country "${job.clientCountry}" is on the block list`;
  } else if (allowed.length > 0) {
    const onList = listIncludes(allowed, job.clientCountry);
    fraction = onList ? 1 : 0.3;
    detail = onList
      ? `client is in ${job.clientCountry}, on the allow list`
      : `client is in ${job.clientCountry}, not on the allow list`;
  } else {
    fraction = 0.75;
    detail = `client is in ${job.clientCountry}; no country preference configured`;
  }

  const restricted = LOCATION_RESTRICTION.some((pattern) => pattern.test(text.all));
  if (restricted) {
    // We cannot verify the freelancer's location from here, so a stated
    // restriction is a discount rather than a veto.
    fraction *= 0.6;
    detail += '; posting restricts applicants by location or language';
  }

  return { fraction: clamp01(fraction), detail };
}

/* -------------------------------------------------------------------- assembly */

export interface DecisionThresholds {
  autoBid: number;
  review: number;
}

export function resolveThresholds(profile: ScoringProfile): DecisionThresholds {
  const autoBid = clamp(isKnownNumber(profile.autoBidThreshold) ? profile.autoBidThreshold : 85, 0, 100);
  const rawReview = isKnownNumber(profile.reviewThreshold) ? profile.reviewThreshold : 60;
  // An inverted configuration must not make every job auto-biddable.
  const review = clamp(Math.min(rawReview, autoBid), 0, 100);
  return { autoBid, review };
}

export function decisionFor(score: number, profile: ScoringProfile): Decision {
  const { autoBid, review } = resolveThresholds(profile);
  if (score >= autoBid) return 'BID';
  if (score >= review) return 'REVIEW';
  return 'SKIP';
}

function formatMax(max: number): string {
  return Number.isInteger(max) ? String(max) : max.toFixed(1);
}

function buildReasons(breakdown: ScoreBreakdownItem[], redFlagLines: string[]): string[] {
  const scored = breakdown.filter((item) => item.max >= 1);

  const strongest = [...scored]
    .filter((item) => item.max > 0 && item.points / item.max >= 0.6)
    .sort((a, b) => b.points - a.points)
    .slice(0, 3);
  const claimed = new Set(strongest.map((item) => item.key));

  const positives = strongest.map(
    (item) => `+ ${item.label} ${item.points.toFixed(1)}/${formatMax(item.max)}: ${item.detail}`,
  );

  // A dimension already named as a strength is not also reported as a weakness.
  const shortfalls = [...scored]
    .filter((item) => !claimed.has(item.key) && item.max - item.points >= 1.5 && item.points / item.max < 0.8)
    .sort((a, b) => b.max - b.points - (a.max - a.points))
    .slice(0, 3)
    .map((item) => `- ${item.label} ${item.points.toFixed(1)}/${formatMax(item.max)}: ${item.detail}`);

  const negatives = [...redFlagLines.map((line) => `- ${line}`), ...shortfalls].slice(0, 3);
  return [...positives, ...negatives].map((reason) => truncate(reason, 240));
}

export interface ScoreJobOptions {
  /** Clock injection point; defaults to now. Keeps freshness scoring testable. */
  reference?: Date;
  /** Pre-resolved weights, when the caller already merged the profile override. */
  weights?: DimensionWeights;
}

/**
 * Rules-only score for one job against one profile.
 *
 * Hard filters run first: any failure short-circuits to SKIP with a score of 0
 * and the reasons in hardFilterFailures. Otherwise every dimension is scored to
 * a fraction of its weight, red flags subtract points (a HIGH flag vetoes), and
 * the clamped 0..100 total is mapped to a decision through the profile's
 * autoBidThreshold and reviewThreshold.
 */
export function scoreJob(
  job: ScorableJob,
  profile: ScoringProfile,
  options: ScoreJobOptions = {},
): ScoreResult {
  const reference = options.reference ?? new Date();
  const weights = options.weights ?? resolveWeights(profile.weights);
  const redFlags = detectRedFlags(job);

  const hardFilterFailures = applyHardFilters(job, profile, reference);
  if (hardFilterFailures.length > 0) {
    return {
      score: 0,
      decision: 'SKIP',
      breakdown: [],
      redFlags,
      reasons: hardFilterFailures.slice(0, 3).map((failure) => `- hard filter: ${failure}`),
      matchedKeywords: [],
      matchedSkills: [],
      hardFilterFailures,
      llmScore: null,
      llmRationale: null,
    };
  }

  const text = jobText(job);
  const keywords = scoreKeywords(text, profile);
  const skills = scoreSkills(job, text, profile);

  const outcomes: Record<ScoringDimension, DimensionOutcome> = {
    keywordMatch: keywords,
    skillMatch: skills,
    budgetFit: scoreBudget(job, profile),
    clientQuality: scoreClientQuality(job),
    clientHistory: scoreClientHistory(job),
    competition: scoreCompetition(job),
    freshness: scoreFreshness(job, reference),
    jobClarity: scoreClarity(job, text),
    categoryFit: scoreCategory(job, text, profile),
    locationFit: scoreLocation(job, text, profile),
  };

  const breakdown: ScoreBreakdownItem[] = SCORING_DIMENSIONS.map((key) => {
    const outcome = outcomes[key];
    const max = round2(weights[key]);
    return {
      key,
      label: DIMENSION_LABELS[key],
      points: round2(clamp01(outcome.fraction) * max),
      max,
      detail: outcome.detail,
    };
  });

  const rawTotal = breakdown.reduce((total, item) => total + item.points, 0);
  const penalty = redFlagPenalty(redFlags);
  const veto = hasVetoFlag(redFlags);
  const score = veto ? 0 : Math.round(clamp(rawTotal - penalty, 0, 100));

  const redFlagLines = redFlags
    .slice(0, 3)
    .map((flag) => `${flag.severity} red flag: ${flag.message}`);

  const reasons = buildReasons(breakdown, redFlagLines);
  if (penalty > 0) {
    reasons.push(
      veto
        ? 'vetoed by a HIGH severity red flag'
        : `red flag penalty: -${penalty} points`,
    );
  }

  return {
    score,
    decision: veto ? 'SKIP' : decisionFor(score, profile),
    breakdown,
    redFlags,
    reasons,
    matchedKeywords: keywords.matched,
    matchedSkills: skills.matched,
    hardFilterFailures: [],
    llmScore: null,
    llmRationale: null,
  };
}
