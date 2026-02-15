# BidRoom GR - Complete Deployment Guide

## 🚀 Railway Deployment (Recommended)

### Prerequisites
- Railway account (sign up at https://railway.app)
- GitHub repository with your code
- Google OAuth credentials (optional but recommended)

### Step 1: Prepare Your Environment

1. **Generate NextAuth Secret**
```bash
openssl rand -base64 32
```
Save this for later.

2. **Google OAuth Setup** (Optional but recommended)
   - Go to https://console.cloud.google.com/
   - Create a new project or select existing
   - Enable "Google+ API"
   - Go to "Credentials" → "Create Credentials" → "OAuth client ID"
   - Application type: "Web application"
   - Add Authorized redirect URIs:
     - `https://your-app-name.up.railway.app/api/auth/callback/google`
   - Save Client ID and Client Secret

### Step 2: Deploy to Railway

1. **Connect Repository**
   - Go to https://railway.app/new
   - Click "Deploy from GitHub repo"
   - Select your repository
   - Railway will auto-detect Next.js

2. **Add PostgreSQL Database**
   - In your Railway project, click "New"
   - Select "Database" → "PostgreSQL"
   - Railway automatically creates `DATABASE_URL` variable

3. **Add Redis**
   - Click "New" → "Database" → "Redis"
   - Railway automatically creates `REDIS_URL` variable

4. **Set Environment Variables**
   - Go to your service → "Variables"
   - Add the following:

```bash
# Required
NEXTAUTH_SECRET=<your-generated-secret>
NEXTAUTH_URL=https://your-app-name.up.railway.app

# Google OAuth (Optional)
GOOGLE_CLIENT_ID=<your-google-client-id>
GOOGLE_CLIENT_SECRET=<your-google-client-secret>

# S3/MinIO (For file uploads - use Railway S3 or external)
S3_ENDPOINT=https://your-minio-instance.com
S3_ACCESS_KEY=your-access-key
S3_SECRET_KEY=your-secret-key
S3_BUCKET=bidroom-documents
S3_REGION=us-east-1

# SMTP Email (Optional)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
SMTP_FROM=noreply@bidroom.gr

# APIs
KIMDIS_API_URL=https://cerpp.eprocurement.gov.gr/khmdhs-opendata
DIAVGEIA_API_URL=https://diavgeia.gov.gr/api
```

5. **Deploy**
   - Railway will automatically build and deploy
   - Wait for deployment to complete (check Deployments tab)

### Step 3: Database Setup

After first deployment, run migrations and seed:

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Link to your project
railway link

# Run database migrations
railway run npm run db:push

# Seed demo data
railway run npm run db:seed
```

### Step 4: Setup File Storage (MinIO or S3)

**Option A: Railway-hosted MinIO**
1. Add new service in Railway
2. Use MinIO Docker image
3. Set ports and environment
4. Update S3 variables in your app

**Option B: AWS S3**
1. Create S3 bucket
2. Create IAM user with S3 permissions
3. Update S3 variables with AWS credentials

**Option C: Skip for MVP**
- File uploads will fail but app will work
- Implement later when needed

### Step 5: Custom Domain (Optional)

1. Go to service Settings → "Domains"
2. Click "Generate Domain" or add custom domain
3. Update `NEXTAUTH_URL` to match your domain
4. Update Google OAuth redirect URI if using OAuth

### Step 6: Background Worker (Optional)

For tender ingestion and daily digests:

1. **Add Worker Service**
   - Click "New" in your Railway project
   - Select "Empty Service"
   - Connect same GitHub repo
   - Name it "worker"

2. **Configure Worker**
   - Settings → Start Command: `npm run worker`
   - Add same environment variables as main app

## 🐳 Docker Deployment (Alternative)

### Full Docker Compose Setup

```bash
# Clone repo
git clone <your-repo>
cd procurement-dash-factory

# Copy environment
cp .env.example .env
# Edit .env with your settings

# Start all services
docker-compose -f docker-compose.full.yml up -d

# Run migrations
docker-compose exec app npm run db:push
docker-compose exec app npm run db:seed
```

Create `docker-compose.full.yml`:

```yaml
version: '3.8'

services:
  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      - DATABASE_URL=postgresql://bidroom:password@postgres:5432/bidroom_gr
      - REDIS_URL=redis://redis:6379
      - S3_ENDPOINT=http://minio:9000
    depends_on:
      - postgres
      - redis
      - minio
    restart: unless-stopped

  worker:
    build: .
    command: npm run worker
    environment:
      - DATABASE_URL=postgresql://bidroom:password@postgres:5432/bidroom_gr
      - REDIS_URL=redis://redis:6379
    depends_on:
      - postgres
      - redis
    restart: unless-stopped

  postgres:
    image: postgres:15
    environment:
      POSTGRES_USER: bidroom
      POSTGRES_PASSWORD: password
      POSTGRES_DB: bidroom_gr
    volumes:
      - postgres_data:/var/lib/postgresql/data
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    volumes:
      - redis_data:/data
    restart: unless-stopped

  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    ports:
      - "9000:9000"
      - "9001:9001"
    volumes:
      - minio_data:/data
    restart: unless-stopped

volumes:
  postgres_data:
  redis_data:
  minio_data:
```

## 🔧 Post-Deployment Checklist

- [ ] App is accessible at your URL
- [ ] Login/signup works
- [ ] Google OAuth works (if configured)
- [ ] Database is populated with seed data
- [ ] Tenders page loads
- [ ] Can create bid room
- [ ] Health check passes: `/api/health`

## 📊 Monitoring

### Check Application Health

```bash
curl https://your-app.up.railway.app/api/health
```

Should return:
```json
{
  "status": "healthy",
  "timestamp": "2026-02-15T...",
  "database": "connected"
}
```

### Railway Logs

```bash
railway logs
```

### Check Background Worker

```bash
railway logs --service worker
```

## 🐛 Troubleshooting

### Build Fails

**Issue**: `Prisma Client not generated`

**Solution**:
```bash
# In railway.toml, ensure build command includes prisma generate
[build]
buildCommand = "npm run build"
# package.json scripts already has: "build": "prisma generate && next build"
```

### Database Connection Fails

**Issue**: Cannot connect to database

**Solution**:
- Verify `DATABASE_URL` in Railway variables
- Check PostgreSQL service is running
- Run `railway run npm run db:push`

### Google OAuth Fails

**Issue**: OAuth redirect error

**Solution**:
- Check `NEXTAUTH_URL` matches your actual URL
- Verify Google Console has correct redirect URI
- Check `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`

### File Uploads Fail

**Issue**: Cannot upload documents

**Solution**:
- S3/MinIO must be configured
- Check `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`
- For MVP, file uploads can be skipped

## 🚦 What's Working After Deployment

### ✅ Core Features
- User authentication (email/password + Google OAuth)
- Organization management
- Onboarding wizard
- Tender discovery and search
- Monitoring profiles
- Bid room creation
- Dashboard and navigation
- Health checks

### 🔄 Features Needing Configuration
- **File uploads**: Need S3/MinIO setup
- **Email alerts**: Need SMTP configuration
- **Background jobs**: Need worker service
- **Real tender data**: KIMDIS API integration (may need auth)

### 📝 MVP Limitations
- Sample tender data (seed script)
- No actual KIMDIS ingestion (API may require authentication)
- File uploads disabled without S3
- Email alerts disabled without SMTP
- Background worker optional for MVP

## 🎯 Next Steps After Deployment

1. **Test Core Flow**
   - Sign up → Onboarding → View Tenders → Create Bid Room

2. **Configure File Storage**
   - Set up MinIO or S3
   - Test document uploads

3. **Set Up Background Jobs**
   - Deploy worker service
   - Configure KIMDIS API access

4. **Configure Alerts**
   - Set up SMTP
   - Test email sending

5. **Production Hardening**
   - Add custom domain
   - Configure SSL
   - Set up monitoring
   - Add error tracking (Sentry)

## 📞 Support

If you encounter issues:
1. Check Railway logs
2. Verify environment variables
3. Check database connection
4. Review this guide
5. Open GitHub issue

---

**Your BidRoom GR platform is now live!** 🎉

Access at: `https://your-app.up.railway.app`

Demo credentials:
- Email: `admin@demo.gr`
- Password: `password123`
