import { Queue, Worker, Job } from 'bullmq';
import { prisma } from '../lib/prisma';
import { kimdisConnector } from '../lib/connectors/kimdis';

// Redis connection configuration
const connectionOptions = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  maxRetriesPerRequest: null,
};

// ============================================
// QUEUES
// ============================================

export const tenderIngestionQueue = new Queue('tender-ingestion', { connection: connectionOptions });
export const dailyDigestQueue = new Queue('daily-digest', { connection: connectionOptions });
export const deadlineReminderQueue = new Queue('deadline-reminder', { connection: connectionOptions });

// ============================================
// TENDER INGESTION WORKER
// ============================================

const tenderIngestionWorker = new Worker(
  'tender-ingestion',
  async (job: Job) => {
    console.log('🔄 Starting tender ingestion job...');

    try {
      // Fetch active tenders from KIMDIS (last 7 days)
      const tenders = await kimdisConnector.getActiveTenders(7);

      console.log(`📥 Fetched ${tenders.length} tenders from KIMDIS`);

      let newCount = 0;
      let updatedCount = 0;

      for (const tender of tenders) {
        try {
          // Check if tender already exists
          const existing = await prisma.tender.findUnique({
            where: {
              source_externalId: {
                source: 'KIMDIS',
                externalId: tender.id,
              },
            },
          });

          if (existing) {
            // Update existing tender
            await prisma.tender.update({
              where: { id: existing.id },
              data: {
                title: tender.title,
                description: tender.description,
                buyer: tender.contractingAuthorityName,
                buyerAddress: tender.contractingAuthorityAddress,
                cpvCodes: tender.cpvCodes || [],
                value: tender.estimatedValue,
                currency: tender.currency,
                publicationDate: tender.publicationDate ? new Date(tender.publicationDate) : null,
                deadline: tender.submissionDeadline ? new Date(tender.submissionDeadline) : null,
                portalLink: tender.detailsUrl,
                status: tender.status,
                updatedAt: new Date(),
              },
            });

            // Create revision if there were changes
            const revisionCount = await prisma.tenderRevision.count({
              where: { tenderId: existing.id },
            });

            await prisma.tenderRevision.create({
              data: {
                tenderId: existing.id,
                revisionNumber: revisionCount + 1,
                changes: {
                  message: 'Updated from KIMDIS',
                  timestamp: new Date().toISOString(),
                },
              },
            });

            updatedCount++;
          } else {
            // Create new tender
            await prisma.tender.create({
              data: {
                source: 'KIMDIS',
                externalId: tender.id,
                title: tender.title,
                description: tender.description,
                buyer: tender.contractingAuthorityName,
                buyerAddress: tender.contractingAuthorityAddress,
                cpvCodes: tender.cpvCodes || [],
                value: tender.estimatedValue,
                currency: tender.currency,
                publicationDate: tender.publicationDate ? new Date(tender.publicationDate) : null,
                deadline: tender.submissionDeadline ? new Date(tender.submissionDeadline) : null,
                country: 'GR',
                portalLink: tender.detailsUrl,
                status: tender.status || 'ACTIVE',
              },
            });

            newCount++;
          }
        } catch (error: any) {
          console.error(`❌ Error processing tender ${tender.id}:`, error.message);
        }
      }

      console.log(`✅ Tender ingestion completed: ${newCount} new, ${updatedCount} updated`);

      return { newCount, updatedCount };
    } catch (error: any) {
      console.error('❌ Tender ingestion error:', error);
      throw error;
    }
  },
  { connection: connectionOptions }
);

// ============================================
// DAILY DIGEST WORKER
// ============================================

const dailyDigestWorker = new Worker(
  'daily-digest',
  async (job: Job) => {
    console.log('📧 Starting daily digest job...');

    try {
      // Get all active monitoring profiles
      const profiles = await prisma.monitoringProfile.findMany({
        where: { isActive: true },
        include: {
          organization: {
            include: {
              memberships: {
                include: {
                  user: true,
                },
              },
            },
          },
          cpvCodes: true,
          keywords: true,
          exclusions: true,
        },
      });

      console.log(`📬 Processing ${profiles.length} monitoring profiles...`);

      for (const profile of profiles) {
        try {
          // Find matching tenders (simplified for MVP)
          const yesterday = new Date();
          yesterday.setDate(yesterday.getDate() - 1);

          const matchingTenders = await prisma.tender.findMany({
            where: {
              status: 'ACTIVE',
              deadline: {
                gte: new Date(),
              },
              publicationDate: {
                gte: yesterday,
              },
              OR: [
                {
                  cpvCodes: {
                    hasSome: profile.cpvCodes.map((c) => c.cpvCode),
                  },
                },
                {
                  title: {
                    contains: profile.keywords[0]?.keyword || '',
                    mode: 'insensitive',
                  },
                },
              ],
            },
            take: 10,
          });

          if (matchingTenders.length > 0) {
            // Send digest email to organization users
            const adminsAndManagers = profile.organization.memberships.filter(
              (m) => m.role === 'ORG_ADMIN' || m.role === 'BID_MANAGER'
            );

            for (const member of adminsAndManagers) {
              // TODO: Send email using nodemailer
              console.log(`📨 Sending digest to ${member.user.email}: ${matchingTenders.length} new tenders`);
            }
          }
        } catch (error: any) {
          console.error(`❌ Error processing profile ${profile.id}:`, error.message);
        }
      }

      console.log('✅ Daily digest completed');
      return { profilesProcessed: profiles.length };
    } catch (error: any) {
      console.error('❌ Daily digest error:', error);
      throw error;
    }
  },
  { connection: connectionOptions }
);

// ============================================
// DEADLINE REMINDER WORKER
// ============================================

const deadlineReminderWorker = new Worker(
  'deadline-reminder',
  async (job: Job) => {
    console.log('⏰ Starting deadline reminder job...');

    try {
      const now = new Date();
      const deadlines = [
        { days: 7, label: '7 days' },
        { days: 2, label: '48 hours' },
        { days: 1, label: '24 hours' },
      ];

      for (const { days, label } of deadlines) {
        const targetDate = new Date(now);
        targetDate.setDate(targetDate.getDate() + days);
        targetDate.setHours(0, 0, 0, 0);

        const nextDay = new Date(targetDate);
        nextDay.setDate(nextDay.getDate() + 1);

        // Find bid rooms with approaching deadlines
        const bidRooms = await prisma.bidRoom.findMany({
          where: {
            status: {
              in: ['DRAFT', 'IN_REVIEW', 'READY_TO_PACKAGE'],
            },
            tender: {
              deadline: {
                gte: targetDate,
                lt: nextDay,
              },
            },
          },
          include: {
            tender: true,
            organization: {
              include: {
                memberships: {
                  include: {
                    user: true,
                  },
                },
              },
            },
          },
        });

        console.log(`⏰ Found ${bidRooms.length} bid rooms with ${label} deadline`);

        for (const bidRoom of bidRooms) {
          // Send reminder to organization members
          const members = bidRoom.organization.memberships;

          for (const member of members) {
            // TODO: Send email using nodemailer
            console.log(
              `📨 Sending ${label} reminder to ${member.user.email} for tender: ${bidRoom.tender.title}`
            );
          }
        }
      }

      console.log('✅ Deadline reminder completed');
      return { success: true };
    } catch (error: any) {
      console.error('❌ Deadline reminder error:', error);
      throw error;
    }
  },
  { connection: connectionOptions }
);

// ============================================
// SCHEDULER
// ============================================

async function setupScheduler() {
  // Schedule tender ingestion (daily at 6 AM)
  await tenderIngestionQueue.add(
    'daily-ingestion',
    {},
    {
      repeat: {
        pattern: '0 6 * * *', // Cron: 6 AM daily
      },
    }
  );

  // Schedule daily digest (daily at 9 AM)
  await dailyDigestQueue.add(
    'daily-digest',
    {},
    {
      repeat: {
        pattern: '0 9 * * *', // Cron: 9 AM daily
      },
    }
  );

  // Schedule deadline reminders (daily at 8 AM)
  await deadlineReminderQueue.add(
    'deadline-reminder',
    {},
    {
      repeat: {
        pattern: '0 8 * * *', // Cron: 8 AM daily
      },
    }
  );

  console.log('✅ Scheduled jobs set up');
}

// ============================================
// STARTUP
// ============================================

async function start() {
  console.log('🚀 Starting BullMQ workers...');

  await setupScheduler();

  console.log('✅ Workers are running. Press Ctrl+C to stop.');

  // Trigger initial ingestion
  await tenderIngestionQueue.add('initial-ingestion', {});
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down workers...');
  await tenderIngestionWorker.close();
  await dailyDigestWorker.close();
  await deadlineReminderWorker.close();
  process.exit(0);
});

// Start if this file is run directly
if (require.main === module) {
  start().catch((error) => {
    console.error('❌ Worker startup error:', error);
    process.exit(1);
  });
}

export { tenderIngestionWorker, dailyDigestWorker, deadlineReminderWorker };
