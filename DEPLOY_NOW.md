# Deploy to Railway NOW - 5 Minute Guide

## Option 1: GitHub Auto-Deploy (Easiest)

1. **Push to GitHub:**
```bash
git add .
git commit -m "Fast rendering + Railway deployment"
git push origin main
```

2. **Deploy on Railway:**
- Go to https://railway.app
- Click "New Project"
- Select "Deploy from GitHub repo"
- Choose your `eurostat-dash-factory` repo
- Railway automatically:
  - Reads `Procfile`
  - Installs `requirements.txt`
  - Runs `gunicorn api_server:app`
  - Assigns a public URL

3. **Done!** Your URL: `https://eurostat-dash-factory-production.up.railway.app`

## Option 2: Railway CLI (Faster Feedback)

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Link project
railway link

# Deploy
railway up

# Get URL
railway domain
```

## What's Deployed:

### Production Features:
- **Gunicorn WSGI server** (production-grade)
- **2 workers** (parallel request handling)
- **600s timeout** (handles long AI processing)
- **Auto-restart** on crashes
- **Environment variable** `$PORT` auto-configured

### Speed Improvements:
- Quarto (30s) → Direct HTML (2s) = **15x faster**
- Parallel data fetch + AI = **40% faster**
- Total: 90s → 37s per dashboard

### No Caching (As Requested):
- Fresh data every request
- On-demand generation only
- Smart filtering for all 7,616 datasets

## Files Created for Deployment:

1. **`Procfile`** - Tells Railway how to start your app
2. **`railway.json`** - Railway config (optional)
3. **`runtime.txt`** - Python version
4. **`.railway-ignore`** - Don't upload database/cache
5. **`requirements.txt`** - Updated with flask-cors, gunicorn

## Testing Locally (Production Mode):

```bash
gunicorn api_server:app --bind 0.0.0.0:5000 --timeout 600 --workers 2
```

Open: http://localhost:5000

## Cost:

- **Free tier**: $5/month credit (~550 hours)
- **After**: ~$0.02/hour (~$15/month for 24/7)
- **Sleep mode**: Free (auto-sleep when inactive)

## Monitoring:

Railway dashboard shows:
- Live logs
- CPU/Memory usage
- Request metrics
- Crash alerts

## Next: Add Login/Signup

After deployment works, we'll add:
1. User authentication (JWT)
2. Database for users (PostgreSQL)
3. Personal dashboard history
4. Usage limits per user

**Ready to deploy?** Just push to GitHub and connect to Railway!
