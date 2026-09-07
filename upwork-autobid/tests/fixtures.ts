import type { ScorableJob, ScoringProfile } from '../src/scoring/weights';
import type { DraftProfile } from '../src/proposals/pricing';

/** A strong, clean, freshly posted job from a good client. */
export function makeJob(overrides: Partial<ScorableJob> = {}): ScorableJob {
  return {
    id: 'job_test',
    source: 'upwork_api',
    externalId: '~01test',
    url: 'https://www.upwork.com/jobs/~01test',
    title: 'Senior TypeScript engineer for a Node.js data pipeline',
    description:
      'We need an experienced TypeScript and Node.js engineer to build a data pipeline '
      + 'moving events into PostgreSQL. The scope is well defined: ingest, transform, and '
      + 'load, with tests and monitoring. Deliverables and acceptance criteria are attached.',
    skills: ['TypeScript', 'Node.js', 'PostgreSQL'],
    category: 'Web Development',
    subcategory: null,
    jobType: 'HOURLY',
    budgetAmount: null,
    hourlyMin: 60,
    hourlyMax: 90,
    currency: 'USD',
    durationLabel: '1 to 3 months',
    experienceLevel: 'EXPERT',
    workload: 'Part time',
    connectsRequired: 16,
    proposalsCount: 3,
    interviewingCount: 0,
    clientCountry: 'United States',
    clientCity: 'Austin',
    clientPaymentVerified: true,
    clientTotalSpent: 214000,
    clientTotalHires: 47,
    clientHireRate: 0.88,
    clientAvgRating: 5,
    clientReviewsCount: 41,
    clientMemberSince: new Date('2019-04-02T00:00:00Z'),
    clientOpenJobs: 1,
    screeningQuestions: [],
    postedAt: new Date(Date.now() - 2 * 60_000),
    firstSeenAt: new Date(),
    ...overrides,
  };
}

export function makeProfile(overrides: Partial<ScoringProfile> = {}): ScoringProfile {
  return {
    id: 'profile_test',
    name: 'Test profile',
    includeKeywords: ['typescript', 'node.js', 'postgresql', 'pipeline'],
    excludeKeywords: ['wordpress', 'data entry'],
    requiredSkills: ['TypeScript', 'Node.js'],
    niceToHaveSkills: ['PostgreSQL', 'AWS'],
    categories: ['Web Development'],
    jobTypes: ['HOURLY', 'FIXED'],
    experienceLevels: ['INTERMEDIATE', 'EXPERT'],
    minFixedBudget: 1200,
    maxFixedBudget: null,
    minHourlyRate: 55,
    maxProposals: 15,
    maxJobAgeMinutes: 180,
    requirePaymentVerified: true,
    minClientSpend: 1000,
    minClientRating: 4.5,
    minClientHireRate: 0.4,
    minClientReviews: 1,
    allowedCountries: [],
    blockedCountries: [],
    blockedClients: [],
    autoBidThreshold: 85,
    reviewThreshold: 60,
    weights: null,
    useLlmRerank: false,
    hourlyRate: 65,
    freelancerProfile: 'Full-stack engineer, 9 years, TypeScript and Node.js.',
    portfolioHighlights: ['Built a 1.2B events/day pipeline'],
    ...overrides,
  };
}

export function makeDraftProfile(overrides: Partial<DraftProfile> = {}): DraftProfile {
  return {
    id: 'profile_test',
    name: 'Test profile',
    hourlyRate: 65,
    fixedBidStrategy: 'PERCENT_OF_BUDGET',
    fixedBidPercent: 0.9,
    minBid: 500,
    maxBid: 15000,
    freelancerProfile: 'Full-stack engineer, 9 years, TypeScript and Node.js.',
    portfolioHighlights: ['Built a 1.2B events/day pipeline'],
    proposalTone: 'professional',
    proposalMaxChars: 1500,
    ...overrides,
  };
}
