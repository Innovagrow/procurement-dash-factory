import { Worker, Queue } from 'bullmq'
import Redis from 'ioredis'

// Redis connection
const connection = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
})

// Define queues
export const tenderQueue = new Queue('tender-ingestion', { connection })
export const emailQueue = new Queue('email-digest', { connection })
export const reminderQueue = new Queue('deadline-reminders', { connection })

// Tender Ingestion Worker
const tenderWorker = new Worker(
  'tender-ingestion',
  async (job) => {
    console.log(`[Tender Worker] Processing job ${job.id}`)
    
    try {
      // TODO: Implement tender ingestion logic
      // - Fetch from KHMDHS/KIMDIS API
      // - Fetch from Diavgeia API
      // - Fetch from TED API (optional)
      // - Normalize data
      // - Create/update tenders
      // - Create TenderRevision for changes
      // - Match against monitoring profiles
      
      console.log('[Tender Worker] Tender ingestion completed')
      return { success: true, imported: 0 }
    } catch (error) {
      console.error('[Tender Worker] Error:', error)
      throw error
    }
  },
  { connection }
)

// Email Digest Worker
const emailWorker = new Worker(
  'email-digest',
  async (job) => {
    console.log(`[Email Worker] Processing job ${job.id}`)
    
    try {
      // TODO: Implement email digest logic
      // - Get organizations with active profiles
      // - Find new matching tenders since last digest
      // - Find updated tenders (deadline/value changes)
      // - Find upcoming deadlines (7d, 48h, 24h)
      // - Generate email HTML
      // - Send via nodemailer
      
      console.log('[Email Worker] Email digest sent')
      return { success: true, sent: 0 }
    } catch (error) {
      console.error('[Email Worker] Error:', error)
      throw error
    }
  },
  { connection }
)

// Deadline Reminder Worker
const reminderWorker = new Worker(
  'deadline-reminders',
  async (job) => {
    console.log(`[Reminder Worker] Processing job ${job.id}`)
    
    try {
      // TODO: Implement reminder logic
      // - Find bid rooms with approaching deadlines
      // - Send reminder emails to bid managers
      // - Create notifications
      
      console.log('[Reminder Worker] Reminders sent')
      return { success: true, sent: 0 }
    } catch (error) {
      console.error('[Reminder Worker] Error:', error)
      throw error
    }
  },
  { connection }
)

// Error handlers
tenderWorker.on('failed', (job, err) => {
  console.error(`[Tender Worker] Job ${job?.id} failed:`, err)
})

emailWorker.on('failed', (job, err) => {
  console.error(`[Email Worker] Job ${job?.id} failed:`, err)
})

reminderWorker.on('failed', (job, err) => {
  console.error(`[Reminder Worker] Job ${job?.id} failed:`, err)
})

// Schedule recurring jobs
async function scheduleJobs() {
  // Tender ingestion - daily at 2 AM
  await tenderQueue.add(
    'daily-ingestion',
    {},
    {
      repeat: {
        pattern: '0 2 * * *', // Cron: 2 AM daily
      },
    }
  )

  // Email digest - daily at 8 AM
  await emailQueue.add(
    'daily-digest',
    {},
    {
      repeat: {
        pattern: '0 8 * * *', // Cron: 8 AM daily
      },
    }
  )

  // Deadline reminders - every 6 hours
  await reminderQueue.add(
    'deadline-check',
    {},
    {
      repeat: {
        pattern: '0 */6 * * *', // Cron: Every 6 hours
      },
    }
  )

  console.log('✅ Recurring jobs scheduled')
}

// Start
async function start() {
  console.log('🚀 Starting BullMQ workers...')
  console.log(`  - Redis: ${process.env.REDIS_HOST}:${process.env.REDIS_PORT}`)
  console.log('  - Workers: tender-ingestion, email-digest, deadline-reminders')
  
  await scheduleJobs()
  
  console.log('✅ Workers running')
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing workers...')
  await tenderWorker.close()
  await emailWorker.close()
  await reminderWorker.close()
  await connection.quit()
  process.exit(0)
})

start().catch(console.error)
