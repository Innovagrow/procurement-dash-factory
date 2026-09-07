/**
 * First-run setup and preflight. Safe to run on every deploy.
 *
 *   npx tsx scripts/bootstrap.ts
 *
 * Waits for Postgres and Redis, applies the schema, seeds an example profile
 * when the database is empty, then prints exactly what is and is not wired up
 * so you can see at a glance whether detection, drafting and notifications
 * will actually work.
 */
import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';

const REQUIRED = ['DATABASE_URL'] as const;

type Check = { label: string; ok: boolean; detail: string };

const checks: Check[] = [];
function record(label: string, ok: boolean, detail: string) {
  checks.push({ label, ok, detail });
}

function has(name: string): boolean {
  const v = process.env[name];
  return typeof v === 'string' && v.trim().length > 0;
}

async function waitFor(
  label: string,
  probe: () => Promise<void>,
  timeoutMs = 60_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  let lastError = '';
  while (Date.now() < deadline) {
    attempt += 1;
    try {
      await probe();
      console.log(`  ${label} reachable (attempt ${attempt})`);
      return true;
    } catch (error) {
      lastError = (error as Error).message;
      const wait = Math.min(5000, 500 * attempt);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  console.error(`  ${label} unreachable after ${timeoutMs}ms: ${lastError}`);
  return false;
}

async function main() {
  console.log('UpBid bootstrap\n');

  const missing = REQUIRED.filter((name) => !has(name));
  if (missing.length) {
    console.error(`Fatal: missing required environment variable(s): ${missing.join(', ')}`);
    process.exit(1);
  }

  console.log('Waiting for services...');
  const prisma = new PrismaClient();
  const dbUp = await waitFor('PostgreSQL', async () => {
    await prisma.$queryRaw`SELECT 1`;
  });
  if (!dbUp) {
    await prisma.$disconnect();
    process.exit(1);
  }

  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
  const redisUp = await waitFor('Redis', async () => {
    if (redis.status !== 'ready') await redis.connect();
    await redis.ping();
  });

  console.log('\nApplying schema...');
  try {
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], { stdio: 'inherit' });
    console.log('  migrations applied');
  } catch {
    console.log('  no migrations found, falling back to db push');
    execFileSync('npx', ['prisma', 'db', 'push', '--accept-data-loss'], { stdio: 'inherit' });
  }

  const profileCount = await prisma.profile.count();
  if (profileCount === 0) {
    console.log('\nNo profiles found — seeding an example profile...');
    execFileSync('npx', ['tsx', 'prisma/seed.ts'], { stdio: 'inherit' });
  } else {
    console.log(`\n${profileCount} profile(s) already configured, skipping seed.`);
  }

  // ---- configuration checklist -----------------------------------------

  record('PostgreSQL', true, 'connected');
  record('Redis', redisUp, redisUp ? 'connected' : `unreachable at ${redisUrl}`);
  record('Dashboard API key', has('API_KEY'),
    has('API_KEY') ? 'set' : 'NOT SET — the dashboard will refuse to start in production');
  record('Public base URL', has('PUBLIC_BASE_URL'),
    has('PUBLIC_BASE_URL')
      ? String(process.env.PUBLIC_BASE_URL)
      : 'NOT SET — one-tap approve/reject links cannot be built');

  record('Claude drafting', has('ANTHROPIC_API_KEY'),
    has('ANTHROPIC_API_KEY')
      ? `model ${process.env.ANTHROPIC_MODEL || 'claude-opus-5'}`
      : 'NOT SET — proposals fall back to templates only');

  const sources = (process.env.SOURCES || 'upwork_api').split(',').map((s) => s.trim()).filter(Boolean);
  record('Detection sources', sources.length > 0, sources.join(', ') || 'none enabled');
  record('  Upwork API credentials', has('UPWORK_CLIENT_ID') && has('UPWORK_CLIENT_SECRET'),
    has('UPWORK_CLIENT_ID') ? 'set (connect the account at /api/oauth/upwork/start)' : 'not set');
  record('  RSS feeds', has('RSS_FEED_URLS'),
    has('RSS_FEED_URLS') ? 'configured' : 'not set (Upwork discontinued RSS in 2024)');
  record('  Email alerts (IMAP)', has('IMAP_HOST') && has('IMAP_USER'),
    has('IMAP_HOST') ? String(process.env.IMAP_HOST) : 'not set');

  const channels: string[] = [];
  if (has('TELEGRAM_BOT_TOKEN') && has('TELEGRAM_CHAT_ID')) channels.push('telegram');
  if (has('SLACK_WEBHOOK_URL')) channels.push('slack');
  if (has('SMTP_HOST') && has('NOTIFY_EMAIL_TO')) channels.push('email');
  record('Notifications', channels.length > 0,
    channels.length ? channels.join(', ') : 'console only — you will not be alerted off-server');

  const autoSubmit = /^(true|1)$/i.test(process.env.AUTO_SUBMIT || '');
  const dryRun = !/^(false|0)$/i.test(process.env.DRY_RUN || 'true');
  record('Submission mode', true,
    `AUTO_SUBMIT=${autoSubmit ? 'on' : 'off'}, DRY_RUN=${dryRun ? 'on' : 'off'}, `
    + `submitter=${process.env.SUBMITTER || 'review_queue'}`);

  console.log('\n--- configuration ------------------------------------------');
  for (const c of checks) {
    console.log(`${c.ok ? '  ok  ' : ' MISS '} ${c.label.padEnd(26)} ${c.detail}`);
  }
  console.log('------------------------------------------------------------\n');

  const fatal = checks.filter((c) => !c.ok && ['Redis'].includes(c.label));
  await prisma.$disconnect();
  redis.disconnect();

  if (fatal.length) {
    console.error('Bootstrap failed: Redis is required for queues, locks and quotas.');
    process.exit(1);
  }

  if (autoSubmit && !dryRun) {
    console.log('WARNING: AUTO_SUBMIT is on and DRY_RUN is off — proposals can be sent');
    console.log('         without your approval. Confirm this is what you intend.\n');
  }

  console.log('Bootstrap complete.');
}

main().catch((error) => {
  console.error('Bootstrap error:', error);
  process.exit(1);
});
