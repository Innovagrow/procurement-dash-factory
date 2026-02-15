# BidRoom GR - Greek Public Tender Bid Management Platform

A comprehensive MVP web platform for suppliers bidding on public tenders in Greece. The platform provides everything a bidder needs: tender discovery, alerts, bid room management, document versioning, packaging, and submission guidance.

## Features

### 🎯 Core Capabilities

- **Onboarding Without CPV**: Sector-based onboarding that automatically suggests CPV packs
- **Tender Discovery**: Search and filter Greek public tenders with advanced matching
- **Qualification Scoring**: Explainable fit scores (0-100) based on profile match
- **Bid Room Management**: Complete workspace per tender with workflow states
- **Document Vault**: Versioned uploads with hash-based deduplication
- **Signature Workflow**: Support for AdES/QES with signed/unsigned version tracking
- **Checklist System**: Customizable templates by sector with completion tracking
- **Task Management**: Collaborative task assignment and tracking
- **Packaging Engine**: ZIP generation with folder structure and manifest.json
- **Submission Assistant**: Step-by-step guidance for NEPPS/ESIDIS portal upload
- **Audit Logging**: Append-only audit trail for all key actions

### 🏢 Multi-Tenancy & RBAC

- **Organizations**: Complete tenant isolation
- **Roles**: Org Admin, Bid Manager, Contributor, Viewer
- **Plans**: Starter, Growth, Pro with configurable limits

### 📊 Data Sources (MVP)

- **KHMDHS/KIMDIS**: Greek public procurement data
- **Diavgeia**: Greek transparency portal
- **TED (Optional)**: EU-wide tender data

## Tech Stack

### Frontend
- Next.js 14 (App Router)
- React 18 + TypeScript
- Tailwind CSS + shadcn/ui
- Lucide Icons

### Backend
- Next.js Server Actions & API Routes
- Prisma ORM
- PostgreSQL
- NextAuth (email/password + Google OAuth)

### Background Jobs
- BullMQ + Redis
- Daily tender ingestion
- Email alerts and digests
- Deadline reminders

### File Storage
- S3-compatible (MinIO for local dev)
- Signed URLs for secure access
- Hash-based deduplication

### Infrastructure
- Docker Compose (Postgres + Redis + MinIO)
- Railway deployment ready

## Quick Start

### 1. Prerequisites

- Node.js 18+ and npm
- Docker and Docker Compose
- Git

### 2. Clone and Install

```bash
# Clone the repository
git clone <your-repo-url>
cd eurostat-dash-factory

# Install dependencies
npm install

# Copy environment variables
cp .env.example .env
```

### 3. Configure Environment

Edit `.env` and set at minimum:

```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/bidroom_gr"
NEXTAUTH_SECRET="generate-with: openssl rand -base64 32"
NEXTAUTH_URL="http://localhost:3000"
```

For Google OAuth (optional):
```env
GOOGLE_CLIENT_ID="your-google-client-id"
GOOGLE_CLIENT_SECRET="your-google-client-secret"
```

### 4. Start Infrastructure

```bash
# Start Postgres, Redis, and MinIO
docker-compose up -d

# Wait for services to be healthy
docker-compose ps
```

### 5. Initialize Database

```bash
# Generate Prisma client
npm run db:generate

# Push schema to database
npm run db:push

# Seed demo data
npm run db:seed
```

### 6. Run Development Server

```bash
# Start Next.js dev server
npm run dev

# In a separate terminal, start background worker
npm run worker
```

Open [http://localhost:3000](http://localhost:3000)

### 7. Demo Login

After seeding, you can log in with:

- **Email**: `admin@demo.com`
- **Password**: `password123`

## Project Structure

```
eurostat-dash-factory/
├── prisma/
│   ├── schema.prisma          # Database schema
│   └── seed.ts                # Demo data seeding
├── src/
│   ├── app/                   # Next.js App Router
│   │   ├── api/              # API routes
│   │   │   └── auth/         # Authentication endpoints
│   │   ├── dashboard/        # Main dashboard
│   │   ├── tenders/          # Tender discovery
│   │   ├── bidrooms/         # Bid room management
│   │   ├── admin/            # Admin panel
│   │   ├── onboarding/       # User onboarding wizard
│   │   ├── login/            # Login page
│   │   └── signup/           # Signup page
│   ├── components/
│   │   ├── ui/               # shadcn/ui components
│   │   └── ...               # Feature components
│   ├── lib/
│   │   ├── prisma.ts         # Prisma client
│   │   ├── auth.ts           # NextAuth configuration
│   │   ├── s3.ts             # S3 file operations
│   │   ├── cpv-sectors.ts    # CPV code mappings
│   │   └── utils.ts          # Utility functions
│   ├── workers/
│   │   ├── index.ts          # BullMQ worker setup
│   │   ├── tender-ingest.ts  # Tender ingestion job
│   │   └── email-digest.ts   # Email digest job
│   └── types/                # TypeScript type definitions
├── docker-compose.yml         # Local infrastructure
├── package.json
├── tsconfig.json
├── tailwind.config.ts
└── README.md
```

## Key Entities

### Organization
Multi-tenant isolation with plan-based limits

### User & Membership
Users belong to organizations with role-based access

### MonitoringProfile
Sector-based tender matching configuration with CPV codes, keywords, and exclusions

### Tender & TenderRevision
Normalized tender data with change tracking

### BidRoom
Per-tender workspace with status workflow:
- Draft → In Review → Ready to Package → Ready to Submit → Submitted → Archived

### DocumentSlot & DocumentVersion
Versioned document storage with signature support (None/AdES/QES)

### ChecklistTemplate & ChecklistItem
Sector-specific checklist templates with completion tracking

### Task & Comment
Collaborative task management within bid rooms

### Package
ZIP packages with manifest.json for submission

### SubmissionProof
Evidence of submission with receipts/screenshots

### AuditEvent
Append-only audit log

## Modules

### 1. Onboarding
Wizard-based onboarding that collects:
- Sectors (Facilities, Security, PPE, Medical, IT, etc.)
- Geographic regions
- Budget range
- Certifications
- Exclusions

Auto-generates CPV packs and keywords based on sector selection.

### 2. Tender Discovery
- Full-text search with Postgres
- Filters: CPV, sector tags, region, buyer, value range, deadline
- Watchlists and saved searches
- De-duplication and change tracking
- Daily digest emails

### 3. Qualification Scoring
Explainable fit scores based on:
- CPV match
- Keyword match
- Region match
- Budget fit
- Deadline availability

### 4. Bid Room
Complete bid management workspace:
- **Document Vault**: Upload, version, tag, sign documents
- **Checklist**: Track mandatory and optional requirements
- **Tasks**: Assign and track bid preparation tasks
- **Comments**: Team collaboration
- **Audit Log**: Complete activity trail

### 5. Packaging Engine
Generates submission-ready ZIP with:
- Structured folder layout (Eligibility/Technical/Financial/Forms/Annexes)
- Naming conventions
- Manifest.json with file metadata
- Compliance checks (mandatory items, signatures)
- Admin override capability

### 6. Submission Assistant
**Does NOT submit automatically** - guides user through NEPPS/ESIDIS portal:
- Deep link to tender in portal
- Step-by-step upload checklist
- Pre-submit validations
- Proof upload (receipt/screenshot)
- Final "Submitted" status with bid room lock

### 7. Admin Panel
Organization management:
- User management and invitations
- Sector packs configuration
- Checklist templates
- Plan limits and billing

## Background Jobs

### Tender Ingestion
Runs daily to fetch new tenders from:
- KHMDHS/KIMDIS API
- Diavgeia API
- TED API (optional)

Creates TenderRevision records for change tracking.

### Email Digest
Daily digest email with:
- New matching tenders
- Updated tenders (deadline/value changes)
- Upcoming deadlines (7d, 48h, 24h)

### Deadline Reminders
Automated reminders for approaching deadlines.

## Data Sources Integration

### KHMDHS/KIMDIS (Greece)
Primary source for Greek public procurement.

**API Documentation**: https://cerpp.eprocurement.gov.gr/khmdhs-opendata/help

**Swagger**: https://cerpp.eprocurement.gov.gr/khmdhs-opendata/swagger-ui/

### Diavgeia (Greece)
Greek transparency portal with all government decisions.

**API Documentation**: https://diavgeia.gov.gr/api/help

### TED (EU - Optional)
EU-wide tender data.

**API Documentation**: https://docs.ted.europa.eu/api/latest/

## Deployment to Railway

### 1. Prepare Railway

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Link to project (or create new)
railway init
```

### 2. Add Services

In Railway dashboard, add:
- **Postgres** (built-in addon)
- **Redis** (built-in addon)
- **MinIO** (or use external S3)

### 3. Set Environment Variables

In Railway project settings, add all variables from `.env.example`:

```env
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_HOST=${{Redis.REDIS_HOST}}
REDIS_PORT=${{Redis.REDIS_PORT}}
NEXTAUTH_SECRET=<generate-new-secret>
NEXTAUTH_URL=https://your-app.railway.app
# ... rest of variables
```

### 4. Deploy

```bash
# Deploy to Railway
railway up

# Run migrations
railway run npm run db:push

# Seed data (optional)
railway run npm run db:seed
```

### 5. Configure Custom Domain

In Railway dashboard:
- Settings → Domains
- Add your custom domain
- Update `NEXTAUTH_URL` to match

## API Documentation

### Authentication

#### POST /api/auth/signup
Register new user and organization.

**Body**:
```json
{
  "name": "John Doe",
  "email": "john@company.com",
  "password": "password123",
  "organizationName": "My Company"
}
```

#### POST /api/auth/signin (NextAuth)
Login with credentials or OAuth.

### Tenders

Tender search, watchlist, and scoring endpoints (to be implemented).

### Bid Rooms

Bid room CRUD, document upload, checklist, tasks endpoints (to be implemented).

### Packages

Package generation and download endpoints (to be implemented).

## Development Guidelines

### Adding a New Page

1. Create route in `src/app/`
2. Add server/client components in `src/components/`
3. Add API routes in `src/app/api/` if needed
4. Update sidebar navigation

### Adding a New Background Job

1. Create job processor in `src/workers/`
2. Register in `src/workers/index.ts`
3. Add job scheduling logic

### Database Changes

```bash
# After editing schema.prisma
npm run db:generate  # Regenerate Prisma client
npm run db:push      # Push to database
```

For production:
```bash
npm run db:migrate   # Create migration
```

## Testing

```bash
# Run tests (to be added)
npm test

# E2E tests (to be added)
npm run test:e2e
```

## Security Considerations

- **Never store portal credentials**: We do NOT integrate with NEPPS/ESIDIS submission APIs
- **Signed URLs**: All S3 files accessed via time-limited signed URLs
- **RBAC**: Strict role-based access control with tenant isolation
- **Password hashing**: bcrypt with 12 rounds
- **Audit logging**: All sensitive actions logged
- **Environment variables**: Never commit `.env` files

## Roadmap

### Phase 1 (MVP - Current)
- ✅ Multi-tenant architecture
- ✅ Authentication (email/password + Google)
- ✅ Database schema and ORM
- ✅ Basic UI components
- 🚧 Onboarding wizard
- 🚧 Tender discovery
- 🚧 Bid room management
- 🚧 Packaging engine
- 🚧 Submission assistant

### Phase 2
- Advanced search with full-text indexing
- Email notifications
- Real-time tender alerts
- PDF text extraction
- Collaborative editing

### Phase 3
- AI-powered tender matching
- Automated checklist generation
- Tender similarity detection
- Predictive scoring
- Market intelligence

## Support

For issues and questions:
- GitHub Issues: <your-repo-url>/issues
- Email: support@bidroomgr.com
- Documentation: <docs-url>

## License

Proprietary - All rights reserved

## Contributing

This is a proprietary MVP. For enterprise licensing or custom development, contact us.

---

Built with ❤️ for Greek suppliers pursuing public procurement opportunities.
