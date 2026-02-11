# Connect to Railway - Step by Step

## Your code is now on GitHub! ✓

**Repository:** https://github.com/Innovagrow/eurostat-dash-factory

## Deploy to Railway (5 Minutes):

### Step 1: Go to Railway
https://railway.app

### Step 2: Sign in with GitHub
- Click "Login"
- Choose "Login with GitHub"
- Authorize Railway

### Step 3: Create New Project
1. Click "New Project"
2. Select "Deploy from GitHub repo"
3. Choose `Innovagrow/eurostat-dash-factory`
4. Click "Deploy Now"

### Step 4: Railway Auto-Detects Everything
Railway automatically:
- Reads `Procfile` → Starts Gunicorn
- Installs `requirements.txt` → All dependencies
- Assigns `$PORT` → Your public URL
- Deploys in ~2 minutes

### Step 5: Get Your Live URL
- Click on your project
- Go to "Settings" → "Domains"
- Railway provides: `eurostat-dash-factory-production.up.railway.app`
- Or add custom domain

## Configuration (Automatic):

Railway uses these files:
- `Procfile` → `gunicorn api_server:app --bind 0.0.0.0:$PORT --timeout 600`
- `runtime.txt` → Python 3.12
- `railway.json` → Deployment settings
- `requirements.txt` → Dependencies

## Monitor Your Deployment:

### Live Logs:
- Click "Deployments" tab
- See real-time server logs
- Watch for errors

### Metrics:
- CPU usage
- Memory usage
- Request count
- Response times

## After Deployment:

1. **Test your live URL:**
   - Open `https://your-app.railway.app`
   - Click a dataset
   - Verify dashboard generation works

2. **Check logs for errors:**
   - Railway dashboard → "Logs" tab
   - Look for Python errors
   - Verify Gunicorn starts correctly

3. **Environment Variables (if needed):**
   - Railway dashboard → "Variables" tab
   - Add any secrets/API keys
   - Railway auto-restarts on changes

## Troubleshooting:

### Build Failed?
- Check Railway logs for errors
- Verify `requirements.txt` has all dependencies
- Ensure Python version matches `runtime.txt`

### App Crashes?
- Check "Logs" tab for Python errors
- Verify Gunicorn command in `Procfile`
- Check timeout settings (600s)

### No Data in Dashboards?
- Eurostat API might be slow from Railway servers
- Check smart filtering is working
- Verify database permissions

## Cost Management:

### Free Tier:
- $5/month credit
- ~550 hours uptime
- Perfect for testing

### Add Sleep Mode:
- Railway dashboard → "Settings"
- Enable "Sleep on idle"
- App auto-sleeps after 5min inactivity
- Wakes up on first request
- **Makes free tier last longer!**

### Upgrade Later:
- $20/month for 24/7 uptime
- Better performance
- More resources

## Next: Add Login/Signup

After Railway deployment works, you'll add:
1. User authentication (JWT tokens)
2. User database (PostgreSQL on Railway)
3. Protected dashboards
4. Usage tracking

**Ready? Go to https://railway.app and deploy!** 🚀
