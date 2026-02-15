# 🚀 BidRoom GR - Quick Start Guide

## Welcome!

You now have a complete **foundational MVP** of BidRoom GR ready to run and deploy. This guide will get you up and running in 10 minutes.

## What's Been Built

✅ **Complete Infrastructure**
- Next.js 14 with TypeScript
- Full Prisma database schema (23 tables)
- Docker setup (Postgres + Redis + MinIO)
- Authentication (email/password + Google OAuth)
- Background job system (BullMQ)
- File storage (S3/MinIO)

✅ **Working Features**
- User signup and login
- Dashboard with stats
- Demo data (3 users, 3 tenders, 2 bid rooms)
- Seed script for quick setup

🚧 **Ready to Implement**
- Onboarding wizard
- Tender search
- Bid room management
- Document upload
- Packaging engine
- Submission assistant

## Step 1: Install Dependencies

```bash
npm install
```

## Step 2: Start Infrastructure

```bash
# Start Postgres, Redis, and MinIO
docker-compose up -d

# Verify services are running
docker-compose ps
```

You should see:
- ✅ bidroom_postgres
- ✅ bidroom_redis
- ✅ bidroom_minio

## Step 3: Copy Environment File

```bash
# Windows
copy .env.example .env

# Mac/Linux
cp .env.example .env
```

**Important**: Open `.env` and set `NEXTAUTH_SECRET`:

```bash
# Generate a secret (run this in terminal):
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# Copy the output to .env:
NEXTAUTH_SECRET="your-generated-secret-here"
```

## Step 4: Setup Database

```bash
# Generate Prisma client
npm run db:generate

# Push schema to database
npm run db:push

# Seed demo data
npm run db:seed
```

You should see:
```
✅ Seed completed successfully!

📊 Summary:
  - Organizations: 1
  - Users: 3
  - Monitoring Profiles: 2
  - Tenders: 3
  - Bid Rooms: 2
  - Checklist Templates: 1

🔑 Demo Login Credentials:
  Email: admin@demo.com
  Password: password123
```

## Step 5: Start Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

## Step 6: Login

Use the demo credentials:
- **Email**: `admin@demo.com`
- **Password**: `password123`

You should see the dashboard with:
- Active bid rooms
- Recent tenders
- Quick actions

## Step 7 (Optional): Start Background Worker

In a **new terminal**:

```bash
npm run worker
```

This starts the background job system for:
- Daily tender ingestion
- Email digests
- Deadline reminders

## 🎉 You're Ready!

Your BidRoom GR platform is now running locally. Here's what you can do next:

### Explore the Platform

1. **Dashboard** - See overview and quick stats
2. **Tenders** - Browse available tenders (stub page)
3. **Bid Rooms** - View active bid rooms (stub page)
4. **Admin** - Manage settings (stub page)

### Check the Database

```bash
# Open Prisma Studio to view data
npx prisma studio
```

Visit [http://localhost:5555](http://localhost:5555) to browse your database.

### Access MinIO Console

Visit [http://localhost:9001](http://localhost:9001)
- Username: `minioadmin`
- Password: `minioadmin`

## Next Steps for Development

### 1. Implement Onboarding Wizard

File: `src/app/onboarding/page.tsx`

**TODO**:
- Create multi-step form
- Add sector selection
- Map sectors to CPV codes
- Save MonitoringProfile

### 2. Build Tender Discovery

Files:
- `src/app/tenders/page.tsx` (list)
- `src/app/tenders/[id]/page.tsx` (detail)
- `src/app/api/tenders/route.ts` (API)

**TODO**:
- Search UI with filters
- Tender cards
- Qualification scoring
- Create bid room button

### 3. Complete Bid Room Management

Files:
- `src/app/bidrooms/[id]/page.tsx` (overview)
- `src/app/bidrooms/[id]/documents/page.tsx` (vault)
- `src/app/bidrooms/[id]/checklist/page.tsx`
- `src/app/bidrooms/[id]/tasks/page.tsx`

**TODO**:
- Document upload with S3
- Version management
- Checklist completion
- Task board

### 4. Build Packaging Engine

File: `src/lib/packaging.ts`

**TODO**:
- ZIP generation with archiver
- Folder structure
- Manifest.json
- Compliance checks

### 5. Create Submission Assistant

File: `src/app/bidrooms/[id]/submit/page.tsx`

**TODO**:
- Portal deep link
- Step-by-step guide
- Proof upload
- Status update

## Deploy to Railway

When ready to deploy:

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Link project
railway link web-production-7a78a

# Deploy
railway up
```

See `DEPLOYMENT_GUIDE.md` for complete Railway setup instructions.

## Project Structure

```
eurostat-dash-factory/
├── prisma/              Database schema & seed
├── src/
│   ├── app/            Next.js pages & API routes
│   ├── components/     React components
│   ├── lib/            Utilities & config
│   └── workers/        Background jobs
├── docker-compose.yml  Local services
├── README.md           Full documentation
├── DEPLOYMENT_GUIDE.md Railway deployment
├── PROJECT_STATUS.md   Feature status
└── START_HERE.md       This file
```

## Common Issues

### Port Already in Use

If port 3000 is taken:
```bash
PORT=3001 npm run dev
```

### Database Connection Error

Check Docker services:
```bash
docker-compose ps
docker-compose logs postgres
```

Restart if needed:
```bash
docker-compose restart postgres
```

### Prisma Client Not Generated

```bash
npm run db:generate
```

### Seed Data Already Exists

To reset:
```bash
npm run db:push -- --force-reset
npm run db:seed
```

## Resources

- **README.md** - Complete platform documentation
- **DEPLOYMENT_GUIDE.md** - Railway deployment steps
- **PROJECT_STATUS.md** - Feature implementation status
- **Prisma Schema** - `prisma/schema.prisma` (all entities)
- **Seed Data** - `prisma/seed.ts` (demo data)

## Support

Questions? Check:
1. `README.md` for setup and features
2. `PROJECT_STATUS.md` for what's implemented
3. `DEPLOYMENT_GUIDE.md` for deployment
4. Code comments for inline documentation

## Demo Users

After seeding, you have 3 demo users:

| Email | Password | Role |
|-------|----------|------|
| admin@demo.com | password123 | Org Admin |
| manager@demo.com | password123 | Bid Manager |
| contributor@demo.com | password123 | Contributor |

## What's Next?

1. ✅ **Foundation Complete** - Everything works locally
2. 🚧 **Features In Progress** - Implement core modules
3. 🚀 **Deploy to Railway** - Go live at your domain

Check `PROJECT_STATUS.md` for detailed feature status and implementation priorities.

---

**Ready to build?** Start with the onboarding wizard or tender discovery module!

**Ready to deploy?** Follow `DEPLOYMENT_GUIDE.md` for Railway setup.

**Questions?** Review the comprehensive `README.md`.
