import { humanizeAge } from '../lib/time';
import {
  type ScorableJob,
  type ScoringProfile,
  containsTerm,
  effectiveHourlyRate,
  formatCount,
  formatMoney,
  formatPercent,
  isKnownNumber,
  jobAgeMinutes,
  jobText,
  listIncludes,
  normalizeExperienceLevel,
  normalizeHireRate,
  normalizeJobType,
  normalizeSkills,
  normalizeText,
  truncate,
} from './weights';

/**
 * Hard filters are veto rules: a single failure means the job is never bid on,
 * whatever the rest of the posting looks like. They run before any scoring so a
 * disqualified job costs nothing.
 *
 * Unknown data never fails a filter. Upwork frequently omits client statistics,
 * budgets and posting times; treating "not disclosed" as "below your floor"
 * would silently discard most of the feed. Unknowns are scored as neutral by
 * the scorer instead.
 */

export interface HardFilterFailure {
  code: string;
  message: string;
}

const NO_FAILURES: readonly HardFilterFailure[] = [];

function normalizedList(values: string[] | null | undefined): string[] {
  return (values ?? []).map(normalizeText).filter((value) => value !== '');
}

function excludedKeywordFailures(job: ScorableJob, profile: ScoringProfile): HardFilterFailure[] {
  const excluded = normalizedList(profile.excludeKeywords);
  if (excluded.length === 0) return [...NO_FAILURES];

  const text = jobText(job);
  const failures: HardFilterFailure[] = [];
  for (const keyword of excluded) {
    let where: string | null = null;
    if (containsTerm(text.title, keyword)) where = 'the title';
    else if (containsTerm(text.skills, keyword)) where = 'the required skills';
    else if (containsTerm(text.description, keyword)) where = 'the description';
    else if (containsTerm(text.questions, keyword)) where = 'a screening question';
    if (where) {
      failures.push({
        code: 'EXCLUDED_KEYWORD',
        message: `excluded keyword "${keyword}" appears in ${where}`,
      });
    }
  }
  return failures;
}

function requiredSkillFailures(job: ScorableJob, profile: ScoringProfile): HardFilterFailure[] {
  const required = normalizedList(profile.requiredSkills);
  if (required.length === 0) return [...NO_FAILURES];

  const text = jobText(job);
  const skills = normalizeSkills(job.skills);
  const missing = required.filter((skill) => {
    if (skills.some((jobSkill) => jobSkill === skill || containsTerm(jobSkill, skill))) return false;
    return !containsTerm(text.all, skill);
  });

  if (missing.length === 0) return [...NO_FAILURES];
  return [
    {
      code: 'REQUIRED_SKILL_MISSING',
      message: `required skill${missing.length > 1 ? 's' : ''} not mentioned anywhere in the posting: ${missing.join(', ')}`,
    },
  ];
}

function jobTypeFailures(job: ScorableJob, profile: ScoringProfile): HardFilterFailure[] {
  const allowed = normalizedList(profile.jobTypes).map((value) => normalizeJobType(value));
  if (allowed.length === 0) return [...NO_FAILURES];

  const jobType = normalizeJobType(job.jobType);
  // UNKNOWN passes: the source did not tell us, so we cannot prove it is wrong.
  if (jobType === 'UNKNOWN' || allowed.includes(jobType)) return [...NO_FAILURES];

  return [
    {
      code: 'JOB_TYPE_NOT_ALLOWED',
      message: `job type ${jobType} is not in the allowed list (${allowed.join(', ')})`,
    },
  ];
}

function experienceLevelFailures(job: ScorableJob, profile: ScoringProfile): HardFilterFailure[] {
  const allowed = normalizedList(profile.experienceLevels)
    .map((value) => normalizeExperienceLevel(value))
    .filter((value): value is string => value !== null);
  if (allowed.length === 0) return [...NO_FAILURES];

  const level = normalizeExperienceLevel(job.experienceLevel);
  if (level === null || allowed.includes(level)) return [...NO_FAILURES];

  return [
    {
      code: 'EXPERIENCE_LEVEL_NOT_ALLOWED',
      message: `experience level ${level} is not in the allowed list (${allowed.join(', ')})`,
    },
  ];
}

function budgetFailures(job: ScorableJob, profile: ScoringProfile): HardFilterFailure[] {
  const failures: HardFilterFailure[] = [];
  const currency = job.currency;

  if (isKnownNumber(job.budgetAmount)) {
    if (isKnownNumber(profile.minFixedBudget) && job.budgetAmount < profile.minFixedBudget) {
      failures.push({
        code: 'BUDGET_BELOW_FLOOR',
        message: `fixed budget ${formatMoney(job.budgetAmount, currency)} is below the floor of ${formatMoney(profile.minFixedBudget, currency)}`,
      });
    }
    if (isKnownNumber(profile.maxFixedBudget) && job.budgetAmount > profile.maxFixedBudget) {
      failures.push({
        code: 'BUDGET_ABOVE_CAP',
        message: `fixed budget ${formatMoney(job.budgetAmount, currency)} is above the cap of ${formatMoney(profile.maxFixedBudget, currency)}`,
      });
    }
  }

  const hourly = effectiveHourlyRate(job);
  if (hourly !== null && isKnownNumber(profile.minHourlyRate) && hourly < profile.minHourlyRate) {
    failures.push({
      code: 'HOURLY_BELOW_FLOOR',
      message: `posted hourly rate ${formatMoney(hourly, currency)}/hr is below the floor of ${formatMoney(profile.minHourlyRate, currency)}/hr`,
    });
  }

  return failures;
}

function competitionFailures(job: ScorableJob, profile: ScoringProfile): HardFilterFailure[] {
  if (!isKnownNumber(profile.maxProposals) || profile.maxProposals <= 0) return [...NO_FAILURES];
  if (!isKnownNumber(job.proposalsCount)) return [...NO_FAILURES];
  if (job.proposalsCount <= profile.maxProposals) return [...NO_FAILURES];

  return [
    {
      code: 'TOO_MANY_PROPOSALS',
      message: `${formatCount(job.proposalsCount)} proposals already submitted, over the limit of ${formatCount(profile.maxProposals)}`,
    },
  ];
}

function ageFailures(
  job: ScorableJob,
  profile: ScoringProfile,
  reference: Date,
): HardFilterFailure[] {
  const maxAge = profile.maxJobAgeMinutes;
  if (!isKnownNumber(maxAge) || maxAge <= 0) return [...NO_FAILURES];

  const age = jobAgeMinutes(job, reference);
  if (age === null || age <= maxAge) return [...NO_FAILURES];

  const posted = job.postedAt ?? job.firstSeenAt ?? null;
  return [
    {
      code: 'JOB_TOO_OLD',
      message: `posted ${humanizeAge(posted, reference)} (${Math.round(age)}m), over the ${formatCount(maxAge)}m freshness limit`,
    },
  ];
}

function clientFailures(job: ScorableJob, profile: ScoringProfile): HardFilterFailure[] {
  const failures: HardFilterFailure[] = [];

  if (profile.requirePaymentVerified !== false && job.clientPaymentVerified === false) {
    failures.push({
      code: 'PAYMENT_NOT_VERIFIED',
      message: 'client payment method is not verified',
    });
  }

  if (
    isKnownNumber(profile.minClientSpend) &&
    isKnownNumber(job.clientTotalSpent) &&
    job.clientTotalSpent < profile.minClientSpend
  ) {
    failures.push({
      code: 'CLIENT_SPEND_TOO_LOW',
      message: `client has spent ${formatMoney(job.clientTotalSpent, job.currency)}, below the floor of ${formatMoney(profile.minClientSpend, job.currency)}`,
    });
  }

  if (
    isKnownNumber(profile.minClientRating) &&
    isKnownNumber(job.clientAvgRating) &&
    job.clientAvgRating > 0 &&
    job.clientAvgRating < profile.minClientRating
  ) {
    failures.push({
      code: 'CLIENT_RATING_TOO_LOW',
      message: `client rating ${job.clientAvgRating.toFixed(2)} is below the floor of ${profile.minClientRating.toFixed(2)}`,
    });
  }

  const minHireRate = normalizeHireRate(profile.minClientHireRate);
  const hireRate = normalizeHireRate(job.clientHireRate);
  if (minHireRate !== null && hireRate !== null && hireRate < minHireRate) {
    failures.push({
      code: 'CLIENT_HIRE_RATE_TOO_LOW',
      message: `client hire rate ${formatPercent(hireRate)} is below the floor of ${formatPercent(minHireRate)}`,
    });
  }

  if (
    isKnownNumber(profile.minClientReviews) &&
    isKnownNumber(job.clientReviewsCount) &&
    job.clientReviewsCount < profile.minClientReviews
  ) {
    failures.push({
      code: 'CLIENT_REVIEWS_TOO_FEW',
      message: `client has ${formatCount(job.clientReviewsCount)} reviews, below the floor of ${formatCount(profile.minClientReviews)}`,
    });
  }

  return failures;
}

function locationFailures(job: ScorableJob, profile: ScoringProfile): HardFilterFailure[] {
  const failures: HardFilterFailure[] = [];
  const country = job.clientCountry;

  if (listIncludes(profile.blockedCountries, country)) {
    failures.push({
      code: 'COUNTRY_BLOCKED',
      message: `client country "${country}" is on the block list`,
    });
  }

  const allowed = normalizedList(profile.allowedCountries);
  if (allowed.length > 0 && normalizeText(country) !== '' && !listIncludes(allowed, country)) {
    failures.push({
      code: 'COUNTRY_NOT_ALLOWED',
      message: `client country "${country}" is not on the allow list (${profile.allowedCountries.join(', ')})`,
    });
  }

  return failures;
}

function blockedClientFailures(job: ScorableJob, profile: ScoringProfile): HardFilterFailure[] {
  const blocked = normalizedList(profile.blockedClients);
  if (blocked.length === 0) return [...NO_FAILURES];

  const company = normalizeText(job.clientCompanyName);
  const clientId = normalizeText(job.clientId);
  const text = jobText(job);
  const failures: HardFilterFailure[] = [];

  for (const entry of blocked) {
    if (company !== '' && (company === entry || containsTerm(company, entry))) {
      failures.push({
        code: 'CLIENT_BLOCKED',
        message: `client "${job.clientCompanyName}" matches block list entry "${entry}"`,
      });
      continue;
    }
    if (clientId !== '' && clientId === entry) {
      failures.push({
        code: 'CLIENT_BLOCKED',
        message: `client id ${entry} is on the block list`,
      });
      continue;
    }
    // Fallback for sources that expose no client identity: a distinctive name
    // spelled out in the posting itself. Short entries are skipped to avoid
    // matching common words.
    if (entry.length >= 5 && (containsTerm(text.title, entry) || containsTerm(text.description, entry))) {
      failures.push({
        code: 'CLIENT_BLOCKED',
        message: `blocked client name "${entry}" appears in the posting text`,
      });
    }
  }

  return failures;
}

/** Structured variant; applyHardFilters() renders these to strings. */
export function applyHardFiltersDetailed(
  job: ScorableJob,
  profile: ScoringProfile,
  reference: Date = new Date(),
): HardFilterFailure[] {
  return [
    ...excludedKeywordFailures(job, profile),
    ...requiredSkillFailures(job, profile),
    ...jobTypeFailures(job, profile),
    ...experienceLevelFailures(job, profile),
    ...budgetFailures(job, profile),
    ...competitionFailures(job, profile),
    ...ageFailures(job, profile, reference),
    ...clientFailures(job, profile),
    ...locationFailures(job, profile),
    ...blockedClientFailures(job, profile),
  ];
}

/**
 * Every reason this job must not be bid on. Empty array means the job passed
 * and is worth scoring.
 */
export function applyHardFilters(
  job: ScorableJob,
  profile: ScoringProfile,
  reference: Date = new Date(),
): string[] {
  return applyHardFiltersDetailed(job, profile, reference).map((failure) =>
    truncate(failure.message, 300),
  );
}

export function passesHardFilters(
  job: ScorableJob,
  profile: ScoringProfile,
  reference: Date = new Date(),
): boolean {
  return applyHardFiltersDetailed(job, profile, reference).length === 0;
}
