# BidRoom GR - Deployment Guide to Railway

This guide will walk you through deploying BidRoom GR to Railway at https://web-production-7a78a.up.railway.app/

## Prerequisites

1. Railway account (sign up at https://railway.app)
2. Railway CLI installed: `npm install -g @railway/cli`
3. Git repository with your code

## Step-by-Step Deployment

### 1. Connect to Railway

```bash
# Login to Railway
railway login

# Link to your existing project
railway link web-production-7a78a
```

### 2. Add Required Services

In your Railway dashboard (https://railway.app/project/web-production-7a78a):

#### Add PostgreSQL Database
1. Click "New Service" → "Database" → "PostgreSQL"
2. Railway will automatically provision and connect it
3. The `DATABASE_URL` variable will be auto-set

#### Add Redis
1. Click "New Service" → "Database" → "Redis"
2. Railway will automatically provision and connect it
3. The `REDIS_HOST`, `REDIS_PORT`, and `REDIS_PASSWORD` variables will be auto-set

#### For File Storage (Choose One):

**Option A: Use Railway Volume + MinIO**
1. Add MinIO as a Docker service
2. Configure persistent volume

**Option B: Use External S3 (Recommended for Production)**
1. Sign up for AWS S3, Cloudflare R2, or DigitalOcean Spaces
2. Create a bucket named `bidroom-documents`
3. Get access keys

### 3. Set Environment Variables

In Railway dashboard → Your Project → Variables, add:

```env
# Database (auto-set by Railway)
DATABASE_URL=${{Postgres.DATABASE_URL}}

# Redis (auto-set by Railway)
REDIS_HOST=${{Redis.REDIS_HOST}}
REDIS_PORT=${{Redis.REDIS_PORT}}
REDIS_PASSWORD=${{Redis.REDIS_PASSWORD}}

# NextAuth
NEXTAUTH_SECRET=<generate-with: openssl rand -base64 32>
NEXTAUTH_URL=https://web-production-7a78a.up.railway.app

# Google OAuth (Optional - get from Google Cloud Console)
GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-google-client-secret

# S3 Storage (use your provider's values)
S3_ENDPOINT=https://s3.eu-west-1.amazonaws.com
S3_ACCESS_KEY=your-s3-access-key
S3_SECRET_KEY=your-s3-secret-key
S3_BUCKET=bidroom-documents
S3_REGION=eu-west-1

# Email (SMTP)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASSWORD=your-app-password
SMTP_FROM=BidRoom GR <noreply@bidroomgr.com>

# API Keys (Optional for MVP)
KHMDHS_API_URL=https://cerpp.eprocurement.gov.gr/khmdhs-opendata/api
KHMDHS_API_KEY=
DIAVGEIA_API_URL=https://diavgeia.gov.gr/api
DIAVGEIA_API_KEY=
TED_API_URL=https://api.ted.europa.eu/v3
TED_API_KEY=

# Application
NODE_ENV=production
PORT=3000
```

### 4. Configure Google OAuth (Optional)

If you want Google Sign-In:

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project or select existing
3. Enable "Google+ API"
4. Go to "Credentials" → "Create Credentials" → "OAuth 2.0 Client ID"
5. Application type: "Web application"
6. Authorized JavaScript origins:
   - `https://web-production-7a78a.up.railway.app`
7. Authorized redirect URIs:
   - `https://web-production-7a78a.up.railway.app/api/auth/callback/google`
8. Copy Client ID and Client Secret to Railway environment variables

### 5. Deploy Application

```bash
# From your project directory
railway up

# Railway will:
# - Build your Next.js application
# - Install dependencies
# - Generate Prisma client
# - Start the application
```

### 6. Run Database Migrations

```bash
# Push Prisma schema to database
railway run npm run db:push

# Seed demo data (optional)
railway run npm run db:seed
```

### 7. Start Background Worker

You have two options:

**Option A: Run worker in same service (simpler)**
Update your `package.json` start script:
```json
"start": "node -r ts-node/register/transpile-only src/workers/index.ts & next start"
```

**Option B: Separate worker service (recommended)**
1. In Railway, duplicate your web service
2. Name it "worker"
3. Change the start command to: `npm run worker`
4. Use same environment variables

### 8. Verify Deployment

Visit: https://web-production-7a78a.up.railway.app

You should see the login page!

**Demo Login**:
- Email: `admin@demo.com`
- Password: `password123`

### 9. Configure Custom Domain (Optional)

1. In Railway dashboard → Settings → Domains
2. Click "Add Domain"
3. Enter your domain (e.g., `bidroomgr.com`)
4. Add DNS records as shown by Railway
5. Wait for DNS propagation (5-60 minutes)
6. Update `NEXTAUTH_URL` in Railway variables to your new domain

## Monitoring & Logs

### View Logs
```bash
# Real-time logs
railway logs

# Or in Railway dashboard → Deployments → View Logs
```

### Check Service Health
```bash
# Connect to Railway shell
railway run bash

# Check database connection
railway run npm run db:push
```

## Troubleshooting

### Build Fails

**Error: Prisma Client not generated**
```bash
# Add to railway.toml
[build]
buildCommand = "npm install && npm run db:generate && npm run build"
```

**Error: Out of memory**
- Upgrade Railway plan for more RAM
- Or optimize build process

### Runtime Errors

**Database connection issues**
```bash
# Verify DATABASE_URL is set
railway variables

# Test connection
railway run npm run db:push
```

**Redis connection issues**
```bash
# Check Redis variables are set
railway variables | grep REDIS

# Restart Redis service in Railway dashboard
```

### Migration Issues

```bash
# Reset database (CAUTION: deletes all data)
railway run npx prisma migrate reset

# Re-run migrations
railway run npm run db:push

# Re-seed
railway run npm run db:seed
```

## Scaling

### Horizontal Scaling
Railway Pro plan allows:
- Multiple replicas
- Auto-scaling based on traffic

### Database
- Upgrade PostgreSQL plan for more storage/connections
- Consider read replicas for heavy read workloads

### File Storage
- Use CDN for static assets
- Consider object storage migration to AWS S3/Cloudflare R2

## Cost Optimization

### Railway Pricing
- **Hobby**: $5/month (500 hours)
- **Pro**: $20/month + usage

### Tips
1. Use Railway sleep mode for non-production environments
2. Optimize container size
3. Use external object storage (cheaper than Railway volumes)
4. Set up monitoring to track resource usage

## CI/CD Setup

### Automatic Deployments

Railway can auto-deploy on git push:

1. Connect GitHub repository in Railway dashboard
2. Select branch (e.g., `main`)
3. Railway will auto-deploy on every push

### Environment-based Deployments

- `main` branch → Production
- `staging` branch → Staging environment
- `dev` branch → Development environment

## Security Checklist

- [ ] `NEXTAUTH_SECRET` is strong and unique
- [ ] Google OAuth credentials are from production project
- [ ] S3 bucket has proper access policies
- [ ] SMTP credentials are secure (use app passwords)
- [ ] Environment variables are set in Railway (not in code)
- [ ] Database has strong password
- [ ] Regular backups are configured

## Backup Strategy

### Database Backups

Railway Pro includes automatic backups. To manually backup:

```bash
# Export database
railway run pg_dump $DATABASE_URL > backup.sql

# Import
railway run psql $DATABASE_URL < backup.sql
```

### File Backups

Set up S3 bucket versioning and lifecycle policies.

## Support

- Railway Documentation: https://docs.railway.app
- Railway Discord: https://discord.gg/railway
- BidRoom GR Issues: <your-repo-url>/issues

## Production Checklist

Before going live:

- [ ] SSL certificate is active
- [ ] Custom domain configured
- [ ] Environment variables verified
- [ ] Database migrations applied
- [ ] Worker service running
- [ ] Email sending tested
- [ ] Google OAuth tested (if enabled)
- [ ] File upload tested
- [ ] Monitoring set up
- [ ] Backups configured
- [ ] Load testing performed
- [ ] Security audit completed

## Next Steps

After successful deployment:

1. **Set up monitoring**: Use Railway metrics or integrate external tools
2. **Configure alerts**: Set up error notifications
3. **Implement CI/CD**: Automate deployments from GitHub
4. **Optimize performance**: Add caching, CDN
5. **Scale as needed**: Add replicas, upgrade plans

---

Your BidRoom GR platform is now live at https://web-production-7a78a.up.railway.app! 🚀
