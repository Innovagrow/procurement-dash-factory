# Railway Deployment Instructions

## ✅ Code Successfully Pushed to GitHub!

Repository: https://github.com/Innovagrow/eurostat-dash-factory

## 🚀 Deploy to Railway at https://web-production-7a78a.up.railway.app

### Option 1: Deploy via Railway Dashboard (Recommended - No CLI needed)

1. **Go to Railway Dashboard**
   - Visit: https://railway.app/project/web-production-7a78a

2. **Connect GitHub Repository**
   - Click "New Service" → "GitHub Repo"
   - Select: `Innovagrow/eurostat-dash-factory`
   - Branch: `main`
   - Railway will auto-deploy on every push

3. **Add PostgreSQL Database**
   - Click "New Service" → "Database" → "PostgreSQL"
   - Railway will auto-configure `DATABASE_URL`

4. **Add Redis**
   - Click "New Service" → "Database" → "Redis"
   - Railway will auto-configure `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`

5. **Set Environment Variables**
   In your web service settings → Variables, add:

   ```env
   # NextAuth (REQUIRED - generate secret)
   NEXTAUTH_SECRET=<run: openssl rand -base64 32>
   NEXTAUTH_URL=https://web-production-7a78a.up.railway.app
   
   # Database (auto-set by Railway)
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   
   # Redis (auto-set by Railway)
   REDIS_HOST=${{Redis.REDIS_HOST}}
   REDIS_PORT=${{Redis.REDIS_PORT}}
   REDIS_PASSWORD=${{Redis.REDIS_PASSWORD}}
   
   # Google OAuth (Optional)
   GOOGLE_CLIENT_ID=your-client-id
   GOOGLE_CLIENT_SECRET=your-client-secret
   
   # S3 Storage (use AWS S3, Cloudflare R2, or DigitalOcean Spaces)
   S3_ENDPOINT=https://s3.amazonaws.com
   S3_ACCESS_KEY=your-access-key
   S3_SECRET_KEY=your-secret-key
   S3_BUCKET=bidroom-documents
   S3_REGION=us-east-1
   
   # Email SMTP (Optional for MVP)
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_USER=your-email@gmail.com
   SMTP_PASSWORD=your-app-password
   SMTP_FROM=BidRoom GR <noreply@bidroomgr.com>
   
   # Application
   NODE_ENV=production
   PORT=3000
   ```

6. **Configure Build Settings**
   - Railway should auto-detect the `railway.toml`
   - Build Command: `npm install && npm run db:generate && npm run build`
   - Start Command: `npm start`

7. **Deploy**
   - Railway will automatically build and deploy
   - Watch the deployment logs

8. **Run Database Migrations**
   Once deployed, in Railway dashboard:
   - Go to your web service
   - Click "Shell" or use Railway CLI:
   
   ```bash
   railway run npm run db:push
   railway run npm run db:seed
   ```

9. **Verify Deployment**
   - Visit: https://web-production-7a78a.up.railway.app
   - You should see the login page!
   - Login with: `admin@demo.com` / `password123`

### Option 2: Deploy via Railway CLI

If Railway CLI is installed:

```bash
# Login to Railway
railway login

# Link to existing project
railway link web-production-7a78a

# Deploy
railway up

# Run migrations
railway run npm run db:push
railway run npm run db:seed
```

## 📋 Post-Deployment Checklist

- [ ] PostgreSQL database added
- [ ] Redis cache added
- [ ] Environment variables set (especially NEXTAUTH_SECRET)
- [ ] Database migrations run
- [ ] Seed data loaded
- [ ] Application accessible at https://web-production-7a78a.up.railway.app
- [ ] Login tested with demo account
- [ ] Google OAuth tested (if configured)

## 🔑 Generate NEXTAUTH_SECRET

On Windows (PowerShell):
```powershell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
```

On Mac/Linux:
```bash
openssl rand -base64 32
```

Or use Node.js:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## 🌐 Custom Domain (Optional)

1. In Railway dashboard → Settings → Domains
2. Click "Add Domain"
3. Enter your custom domain (e.g., `bidroomgr.com`)
4. Add DNS records as shown by Railway
5. Update `NEXTAUTH_URL` to your custom domain

## 📊 Monitoring

- View logs: Railway Dashboard → Deployments → View Logs
- Monitor resources: Railway Dashboard → Metrics
- Set up alerts: Railway Dashboard → Settings → Notifications

## 🆘 Troubleshooting

### Build Fails
- Check Railway logs for specific error
- Verify all dependencies in package.json
- Ensure Node.js version compatibility

### Database Connection Issues
- Verify `DATABASE_URL` is set
- Check PostgreSQL service is running
- Test connection: `railway run npm run db:push`

### Application Not Starting
- Check `PORT` environment variable
- Verify start command in railway.toml
- Review application logs

## 📞 Support

- Railway Docs: https://docs.railway.app
- GitHub Issues: https://github.com/Innovagrow/eurostat-dash-factory/issues
- Railway Discord: https://discord.gg/railway

## 🎉 Success!

Once deployed, your BidRoom GR platform will be live at:
**https://web-production-7a78a.up.railway.app**

Demo login:
- Email: `admin@demo.com`
- Password: `password123`

---

**Next Steps After Deployment:**
1. Test all authentication flows
2. Verify database connection
3. Test file upload (requires S3 setup)
4. Configure Google OAuth (optional)
5. Set up monitoring and alerts
6. Implement remaining feature modules
