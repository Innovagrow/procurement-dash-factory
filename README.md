# BidRoom GR - Greek Public Tender Bidding Platform

**Complete end-to-end solution for bidding on Greek public tenders through NEPPS/ESIDIS**

## 🎯 Features

- **No CPV Knowledge Required**: Sector-based onboarding (Facilities, PPE, Medical, IT, etc.)
- **Tender Discovery**: Search, filter, and alerts for Greek procurement (KHMDHS/KIMDIS, Diavgeia)
- **Qualification Scoring**: Explainable fit scores (0-100) based on your profile
- **Bid Room**: Complete workspace with documents, versioning, tasks, checklist, signatures
- **Packaging Engine**: Automatic ZIP generation with naming conventions and manifest.json
- **Compliance Gating**: Mandatory checks before packaging (documents, signatures, checklist)
- **Submission Assistant**: Step-by-step guide for NEPPS/ESIDIS upload with validations
- **Multi-Tenancy**: Organizations, RBAC (Org Admin, Bid Manager, Contributor, Viewer)
- **Audit Log**: Complete audit trail of all actions
- **Background Jobs**: Daily tender ingestion, alerts, deadline reminders (BullMQ + Redis)

## 🏗️ Tech Stack

- **Frontend**: Next.js 14 (App Router) + React + TypeScript + Tailwind + shadcn/ui
- **Backend**: Next.js Server Actions + API Routes
- **Database**: PostgreSQL + Prisma
- **Jobs**: BullMQ + Redis
- **Storage**: S3-compatible (MinIO)
- **Auth**: NextAuth (email/password + Google OAuth)
- **Deployment**: Railway

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- Docker & Docker Compose
- Git

### 1. Clone Repository

```bash
git clone https://github.com/yourusername/procurement-dash-factory.git
cd procurement-dash-factory
```

### 2. Start Infrastructure (Postgres, Redis, MinIO)

```bash
docker-compose up -d
```

This starts:
- PostgreSQL on port 5432
- Redis on port 6379
- MinIO on ports 9000 (API) and 9001 (Console)

### 3. Environment Setup

```bash
cp .env.example .env
```

Edit `.env` and set:
- `DATABASE_URL` (already configured for local Docker)
- `NEXTAUTH_SECRET` (generate with: `openssl rand -base64 32`)
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (optional, for Google OAuth)

### 4. Install Dependencies

```bash
npm install
```

### 5. Database Setup

```bash
# Push schema to database
npm run db:push

# Seed demo data
npm run db:seed
```

This creates:
- Demo organization
- 3 demo users (admin, manager, contributor)
- 2 monitoring profiles
- 20 sample tenders
- 2 sample bid rooms

### 6. Start Development Server

```bash
npm run dev
```

Visit: `http://localhost:3000`

### 7. Start Background Worker (Optional)

In a separate terminal:

```bash
npm run worker
```

This starts the BullMQ worker for:
- Tender ingestion
- Daily digests
- Deadline reminders

## 👤 Demo Credentials

| Role        | Email                | Password     |
|-------------|----------------------|--------------|
| Org Admin   | admin@demo.gr        | password123  |
| Bid Manager | manager@demo.gr      | password123  |
| Contributor | contributor@demo.gr  | password123  |

## 📦 Deployment to Railway

### 1. Install Railway CLI

```bash
npm install -g @railway/cli
```

### 2. Login to Railway

```bash
railway login
```

### 3. Create New Project

```bash
railway init
```

### 4. Add Services

```bash
# Add PostgreSQL
railway add --database postgres

# Add Redis
railway add --database redis
```

### 5. Set Environment Variables

```bash
railway variables set NEXTAUTH_SECRET=your-secret-here
railway variables set GOOGLE_CLIENT_ID=your-google-client-id
railway variables set GOOGLE_CLIENT_SECRET=your-google-client-secret
railway variables set NEXTAUTH_URL=https://your-app.up.railway.app
```

### 6. Deploy

```bash
railway up
```

Railway will automatically:
- Detect Next.js
- Install dependencies
- Run `prisma generate`
- Build the app
- Start it

### 7. Run Database Migration

```bash
railway run npm run db:push
railway run npm run db:seed
```

### 8. Access Your App

Your app will be available at: `https://your-app.up.railway.app`

## 📂 Project Structure

```
procurement-dash-factory/
├── prisma/
│   ├── schema.prisma        # Database schema
│   └── seed.ts              # Seed script
├── src/
│   ├── app/                 # Next.js app directory
│   │   ├── api/             # API routes
│   │   ├── login/           # Login page
│   │   ├── signup/          # Signup page
│   │   ├── onboarding/      # Onboarding wizard
│   │   ├── dashboard/       # Dashboard
│   │   ├── tenders/         # Tender discovery
│   │   ├── bidrooms/        # Bid rooms
│   │   └── admin/           # Admin panel
│   ├── components/          # React components
│   │   └── ui/              # shadcn/ui components
│   ├── lib/                 # Utilities
│   │   ├── prisma.ts        # Prisma client
│   │   ├── auth.ts          # NextAuth config
│   │   ├── s3.ts            # S3 storage
│   │   ├── utils.ts         # Helpers
│   │   ├── cpv-sectors.ts   # CPV sector packs
│   │   └── connectors/      # API connectors
│   │       └── kimdis.ts    # KHMDHS/KIMDIS
│   ├── workers/             # Background jobs
│   │   └── index.ts         # BullMQ workers
│   └── types/               # TypeScript types
├── docker-compose.yml       # Local infrastructure
├── package.json             # Dependencies
└── README.md                # This file
```

## 🔐 Authentication

### Manual Login/Signup
- Email/password with bcrypt hashing
- JWT sessions via NextAuth
- Automatic organization creation on signup

### Google OAuth
1. Create OAuth credentials at [Google Cloud Console](https://console.cloud.google.com/)
2. Add to Authorized redirect URIs:
   - `http://localhost:3000/api/auth/callback/google` (local)
   - `https://your-app.up.railway.app/api/auth/callback/google` (production)
3. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`

## 📊 Data Sources

### KHMDHS/KIMDIS (Greece)
- **API**: https://cerpp.eprocurement.gov.gr/khmdhs-opendata/swagger-ui/index.html
- **Coverage**: 30,000+ Greek tenders/year
- **Data**: Tenders, contracts, buyers, CPV codes

### Diavgeia (Greece)
- **API**: https://diavgeia.gov.gr/api/help
- **Coverage**: 2M+ public decisions/year
- **Data**: All Greek public sector decisions

### TED (EU) - Optional
- **API**: https://docs.ted.europa.eu/api/latest/index.html
- **Coverage**: EU-wide tenders
- **Data**: 500,000+ EU tenders/year

## 🛠️ Development Commands

```bash
# Development
npm run dev           # Start Next.js dev server
npm run worker        # Start BullMQ worker

# Database
npm run db:push       # Push schema changes
npm run db:seed       # Seed demo data

# Production
npm run build         # Build for production
npm run start         # Start production server

# Utilities
npm run lint          # Run ESLint
```

## 🎯 MVP Scope

### ✅ Completed
- [x] Multi-tenancy with organizations
- [x] Authentication (email/password + Google OAuth)
- [x] Onboarding without CPV knowledge
- [x] Monitoring profiles with sector packs
- [x] Dashboard
- [x] KHMDHS/KIMDIS connector
- [x] Docker Compose setup
- [x] Seed data

### 🚧 In Progress
- [ ] Tender search & filters
- [ ] Qualification/scoring
- [ ] Bid Room (documents, checklist, tasks)
- [ ] Packaging engine
- [ ] Submission assistant
- [ ] Background jobs (BullMQ)
- [ ] Admin panel
- [ ] Audit logging

## 📝 Notes

### Important: We Do NOT Submit Bids
BidRoom GR prepares bids but does NOT submit them automatically. Legal submission must happen through official government portals (NEPPS/ESIDIS). We provide:
- Bid preparation workspace
- Package generation (ZIP + manifest)
- Submission checklist
- Portal deep links
- Submission proof upload

### NEPPS/ESIDIS Links
- **NEPPS Search**: https://nepps-search.eprocurement.gov.gr/actSearch/faces/active_search_main.jspx
- **Portal Entry**: https://www.eprocurement.gov.gr/
- **ESPD Tool**: https://espd.eprocurement.gov.gr/

## 🤝 Contributing

Contributions welcome! Please open an issue first to discuss changes.

## 📄 License

MIT License - see LICENSE file for details.

## 🆘 Support

For issues or questions:
- GitHub Issues: https://github.com/yourusername/procurement-dash-factory/issues
- Email: support@bidroom.gr (example)

---

**Built with ❤️ for Greek procurement transparency**
