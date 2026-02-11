# Connect Railway to GitHub - Step by Step

## Your Repository:
**GitHub URL:** https://github.com/Innovagrow/eurostat-dash-factory

---

## Step 1: Go to Railway

Open: **https://railway.app**

## Step 2: Sign Up / Login

- Click "Login" (top right)
- Choose "Login with GitHub"
- Authorize Railway to access your repositories

## Step 3: Create New Project

1. Click **"New Project"** button
2. Select **"Deploy from GitHub repo"**
3. Find and select: **`Innovagrow/eurostat-dash-factory`**

## Step 4: Railway Auto-Deploys

Railway will automatically:
- ✓ Detect Python project
- ✓ Read `Procfile` for start command
- ✓ Install dependencies from `requirements.txt`
- ✓ Set `$PORT` environment variable
- ✓ Build and deploy your app

**Build time:** ~3-5 minutes

## Step 5: Get Your URL

After deployment completes:
1. Click on your service
2. Go to **"Settings"** tab
3. Scroll to **"Domains"** section
4. Click **"Generate Domain"**

Your app will be live at:
```
https://eurostat-dash-factory-production.up.railway.app
```

---

## What's Running:

### Start Command (from Procfile):
```bash
gunicorn api_server:app --bind 0.0.0.0:$PORT --timeout 600 --workers 2
```

### Features Deployed:
- Fast rendering (2s instead of 30s)
- Parallel processing
- Smart filtering for all 7,616 datasets
- On-demand generation
- Production WSGI server

### Environment:
- Python 3.12
- Gunicorn (production server)
- 2 workers for parallel requests
- 600s timeout for long AI processing

---

## Monitoring Your App:

### View Logs:
1. Click on your service in Railway dashboard
2. Go to **"Deployments"** tab
3. Click on latest deployment
4. See live logs

### Check Metrics:
- CPU usage
- Memory usage
- Request count
- Response times

### Set Alerts:
- Go to **"Settings"**
- Add **"Notifications"**
- Get alerts for crashes/errors

---

## Cost Management:

### Free Tier:
- $5 credit/month
- ~550 hours of uptime
- Perfect for testing

### Usage Limits:
1. Go to **"Settings"**
2. Click **"Usage"**
3. Set spending limits
4. Enable sleep mode (auto-sleep when inactive)

### After Free Tier:
- ~$0.02/hour
- ~$15/month for 24/7 uptime
- Can pause/delete anytime

---

## Testing Your Deployed App:

### 1. Open Your URL:
```
https://your-app.up.railway.app
```

### 2. Test Dashboard Generation:
- Click any dataset from catalog
- Watch generation progress
- Verify it completes in ~37 seconds
- Check that dashboard renders correctly

### 3. Verify Features:
- ✓ Catalog shows all 7,616 datasets
- ✓ Smart filtering works
- ✓ Dashboards generate on-demand
- ✓ Charts are interactive
- ✓ Purple gradient theme

---

## Troubleshooting:

### Build Failed?
- Check Railway logs for errors
- Verify `requirements.txt` is valid
- Ensure all imports are correct

### App Crashes?
- Check logs for Python errors
- Verify database files aren't missing
- Increase memory if needed (Settings > Resources)

### Timeout Errors?
- Already set to 600s in Procfile
- If still timing out, increase in Procfile:
  ```
  --timeout 900
  ```

### Can't Access URL?
- Wait 5 minutes after deployment
- Clear browser cache
- Try incognito mode

---

## Next Steps After Deployment:

1. **Test thoroughly** - Try generating multiple dashboards
2. **Monitor performance** - Check response times
3. **Add custom domain** (optional) - Your own domain like `dashboard.yourdomain.com`
4. **Implement login/signup** - User authentication system

---

## Quick Reference:

| Task | Action |
|------|--------|
| View logs | Railway Dashboard → Deployments → Latest |
| Restart app | Deployments → Redeploy |
| Change settings | Settings tab |
| Add environment variables | Settings → Variables |
| Scale up | Settings → Resources |
| Add database | New → Database → PostgreSQL |

---

**Ready?** Go to https://railway.app and connect your GitHub repo!
