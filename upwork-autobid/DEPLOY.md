# Deploying UpBid

The service must never sleep — a stopped machine means undetected jobs. Every option below is
configured accordingly.

Three pieces have to be online: the app, Postgres, and Redis.

## Railway (fastest — one project, all three)

1. Push this repo to GitHub.
2. **New Project → Deploy from GitHub repo**, pick the repo.
3. Set the service **Root Directory** to `upwork-autobid` (Settings → Source).
4. **+ New → Database → Add PostgreSQL**, then again for **Redis**. Railway injects
   `DATABASE_URL` and `REDIS_URL` automatically.
5. Add the rest of the variables (Settings → Variables):

   ```
   API_KEY=<openssl rand -hex 24>
   PUBLIC_BASE_URL=https://<your-service>.up.railway.app
   ANTHROPIC_API_KEY=sk-ant-...
   SOURCES=email
   IMAP_HOST=imap.gmail.com
   IMAP_USER=you@example.com
   IMAP_PASSWORD=<app password>
   TELEGRAM_BOT_TOKEN=...
   TELEGRAM_CHAT_ID=...
   DRY_RUN=true
   AUTO_SUBMIT=false
   ```

6. Settings → **Networking → Generate Domain**. That URL is your dashboard.
7. `railway.json` already sets the health check to `/api/health` and restart to `ON_FAILURE`
   with 10 retries. Confirm **no** sleep/autostop setting is enabled.

The default start command runs `prisma db push` then `dist/bootstrap/all-in-one.js`, which serves
the API and runs the workers in one container — fine up to a few hundred jobs a day. To split
them, add a second service from the same repo with start command `node dist/workers/index.js`.

Open the URL, paste your `API_KEY`, and run through the Status screen — every row should be green.

## Fly.io

```bash
cd upwork-autobid
fly launch --no-deploy          # fly.toml is already committed; keep it
fly postgres create --name upbid-db && fly postgres attach upbid-db
fly redis create                # then set REDIS_URL from the output

fly secrets set API_KEY=$(openssl rand -hex 24) \
  PUBLIC_BASE_URL=https://upbid.fly.dev \
  ANTHROPIC_API_KEY=sk-ant-... \
  REDIS_URL=redis://...

fly deploy
fly scale count web=1 worker=1
```

`fly.toml` sets `auto_stop_machines = false` and `min_machines_running = 1` — do not change these,
they are what keeps detection alive.

## Render

`render.yaml` at the repo root defines the web service, the background worker, Postgres and a
key-value store. **New → Blueprint**, point it at the repo, then fill the `sync: false` secrets
(`ANTHROPIC_API_KEY`, `PUBLIC_BASE_URL`) in the dashboard.

## Docker / your own VPS

```bash
cd upwork-autobid
cp .env.example .env            # fill it in
docker compose up -d            # postgres, redis, schema push, api, worker
docker compose logs -f worker
```

Behind a reverse proxy with TLS — Caddy is two lines:

```
upbid.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

Without Docker, run it under systemd:

```ini
[Unit]
Description=UpBid
After=network-online.target postgresql.service redis.service

[Service]
Type=simple
User=upbid
WorkingDirectory=/opt/upbid/upwork-autobid
EnvironmentFile=/opt/upbid/upwork-autobid/.env
ExecStart=/usr/bin/node dist/bootstrap/all-in-one.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## The never-sleeps checklist

Run through this after any deploy:

- [ ] No autosleep / scale-to-zero on the host (Railway sleep off, Fly `auto_stop_machines = false`,
      Render paid instance — the free tier sleeps).
- [ ] Restart policy is `always` or `on-failure` with retries.
- [ ] Health check points at `/api/health/live` and the platform actually restarts on failure.
- [ ] An **external** uptime monitor hits `https://<your-url>/api/health/live` every 5 minutes.
      The host's own check cannot tell you the host is down.
- [ ] At least one notification channel is configured — otherwise a dead worker is silent.
- [ ] Status screen shows every source fresh and every heartbeat under a minute old.
- [ ] `PUBLIC_BASE_URL` matches the real URL, or the one-tap approve links will 404.
- [ ] Postgres has automated backups on.
- [ ] `DRY_RUN=true` for the first day. Watch what it drafts before it can send anything.

## After it is up

1. Open the dashboard, go to **Profile**, and put your real skills, rates and floors in.
2. Use **Test against recent jobs** to set thresholds.
3. Connect Upwork at `/api/oauth/upwork/start` if you are using the API source.
4. Send yourself a test notification and confirm the Approve button in Telegram actually works.
5. Leave `DRY_RUN=true` until you have read twenty drafts and would have sent at least fifteen.
