/**
 * Seeds one realistic monitoring profile so a fresh deploy has something to
 * detect against. Idempotent: re-running updates the example profile rather
 * than creating duplicates, and never touches profiles you have added.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const EXAMPLE_PROFILE_NAME = 'Full-stack & automation';

const FREELANCER_PROFILE = [
  'Full-stack engineer, 9 years. TypeScript/Node, Next.js, PostgreSQL, and event',
  'pipelines (Kafka, ClickHouse). I ship production systems rather than prototypes,',
  'and I write the evaluation harness before the feature.',
  '',
  'Recent work: a fulfilment dashboard for a 3PL handling 40k orders/month; a',
  'Claude-based support bot running ~4,000 conversations/month at a 61% full',
  'deflection rate; Prisma and query performance work on a 400 GB Postgres database.',
].join('\n');

async function main() {
  const existing = await prisma.profile.findUnique({
    where: { name: EXAMPLE_PROFILE_NAME },
  });

  const data = {
    name: EXAMPLE_PROFILE_NAME,
    isActive: true,

    includeKeywords: [
      'typescript', 'node.js', 'next.js', 'postgresql', 'prisma',
      'api integration', 'automation', 'data pipeline', 'claude', 'llm',
    ],
    excludeKeywords: [
      'wordpress', 'data entry', 'virtual assistant', 'seo backlinks',
      'logo design', 'academic writing', 'crypto trading bot',
    ],
    requiredSkills: ['TypeScript', 'Node.js'],
    niceToHaveSkills: ['Next.js', 'PostgreSQL', 'AWS', 'Prisma', 'Python'],
    categories: ['Web Development', 'Scripts & Utilities', 'AI & Machine Learning'],
    searchQueries: [
      'typescript node backend',
      'next.js dashboard',
      'api integration automation',
      'claude api integration',
    ],

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
    allowedCountries: [] as string[],
    blockedCountries: [] as string[],
    blockedClients: [] as string[],

    autoBidThreshold: 85,
    reviewThreshold: 60,
    useLlmRerank: true,

    // Submission stays manual until the operator has watched enough drafts.
    autoSubmit: false,
    hourlyRate: 65,
    fixedBidStrategy: 'PERCENT_OF_BUDGET',
    fixedBidPercent: 0.9,
    minBid: 500,
    maxBid: 15000,
    maxDailySubmissions: 15,
    maxHourlySubmissions: 5,
    maxDailyConnects: 120,

    freelancerProfile: FREELANCER_PROFILE,
    portfolioHighlights: [
      '3PL fulfilment dashboard — Next.js + Postgres materialised views, p95 under 400 ms',
      'Claude support bot — 4k conversations/month, 61% deflection, graded eval suite in CI',
      'Kafka to ClickHouse pipeline — 1.2B events/day, idempotent replay-safe ingest',
    ],
    proposalTone: 'professional',
    proposalMaxChars: 1500,
    proposalLanguage: 'en',
    customInstructions:
      'Open by naming the specific technical risk in their brief. Never claim experience '
      + 'that is not in the profile above. Always end with one concrete question.',
  };

  if (existing) {
    await prisma.profile.update({ where: { id: existing.id }, data });
    console.log(`Updated example profile "${EXAMPLE_PROFILE_NAME}" (${existing.id})`);
  } else {
    const created = await prisma.profile.create({ data });
    console.log(`Created example profile "${EXAMPLE_PROFILE_NAME}" (${created.id})`);
  }

  const total = await prisma.profile.count();
  console.log(`${total} profile(s) in the database.`);
}

main()
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
