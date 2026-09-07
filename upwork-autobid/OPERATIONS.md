# Runbook

## Daily

Open the **Status** screen. Every heartbeat should be under a minute old and every source fresh.
The two badges to glance at are `AUTO_SUBMIT` and `DRY_RUN` — know which mode you are in.

Then work the **Approvals** queue. Drafts expire after 24 hours because the job is gone by then;
an approval you get to tomorrow is wasted connects.

## Weekly

- Check the stats tiles: reply rate is the number that matters. Under ~10% means your letters are
  generic or your bids are wrong, not that you need more volume.
- Look at the score distribution on the Profile screen. If nothing crosses your threshold, your
  filters are too tight; if forty things do, they are too loose.
- Review the connects ledger against what you won.

## Reading `/api/metrics`

Prometheus text format. The useful series:

- `upbid_jobs_total{status=...}` — pipeline depth by stage. A pile-up at one status names the
  broken stage.
- `upbid_matches_total{decision=...}` — how selective the profile actually is.
- `upbid_proposals_total{status=...}` — `PENDING_APPROVAL` climbing means you are the bottleneck.
- `upbid_queue_depth{queue=...}` — non-zero and rising means workers are down or too slow.
- `upbid_source_age_seconds{source=...}` — the leading indicator of silent detection failure.
- `upbid_heartbeat_age_seconds{component=...}` — over 120 means that component is dead.

## Tuning thresholds

Use `POST /api/profiles/:id/test` (the **Test against recent jobs** button). It scores the last 50
jobs against a candidate profile without persisting anything. Move one number at a time and watch
the distribution. Aim for a handful of `BID` decisions a day that you would genuinely send.

## Enabling AUTO_SUBMIT safely

Do not skip steps here. Read [COMPLIANCE.md](COMPLIANCE.md) first — this is a decision about your
account, not a config change.

1. Run with `DRY_RUN=true` for at least a week. Read every draft.
2. Only proceed if you would have sent 15 of the last 20 unedited.
3. Set `SUBMITTER` to a submitter that can actually send (`api` with the scope granted, or
   `webhook` pointed at your own system). Confirm the Status screen shows it configured.
4. Turn `DRY_RUN=false` while `AUTO_SUBMIT` stays `false`. Approve manually for a few days and
   confirm real submissions land on Upwork.
5. Raise `autoBidThreshold` a few points above where you think it belongs.
6. Drop `maxDailySubmissions` to 3 and `maxHourlySubmissions` to 1.
7. Set `profile.autoSubmit = true`, then `AUTO_SUBMIT=true`. Watch the first day closely.
8. Raise quotas only after a week of clean results.

Reverse it instantly by setting `AUTO_SUBMIT=false` — the gate fails closed to the review queue.

## When a source starts failing

1. Status screen names the source and its last success.
2. `docker compose logs -f worker` (or the platform's logs) — the source logs its own errors.
3. IMAP: usually an expired app password or a provider security block.
4. Upwork API: a 401 means the token needs reconnecting at `/api/oauth/upwork/start`; a 429 means
   you are polling too hard — raise `POLL_INTERVAL_SECONDS`.
5. The checkpoint's `disabledUntil` clears itself. To force a retry, clear the field on the
   `SourceCheckpoint` row.

Other sources keep working throughout — this is why running two is worth it.

## Rotating the Upwork token

Visit `/api/oauth/upwork/start` and reconnect. The new token replaces the stored one; nothing else
needs restarting.

## Backup and restore

```bash
pg_dump "$DATABASE_URL" -Fc -f upbid-$(date +%F).dump
pg_restore -d "$DATABASE_URL" --clean --if-exists upbid-2026-09-07.dump
```

Back up daily. The audit trail and connects ledger are the parts you cannot reconstruct.

## Incident checklist

1. Is the dashboard reachable? If not, the host is down — check the platform status page.
2. `/api/health` — which row is red?
3. Heartbeat ages: which component stopped?
4. Queue depths: rising means workers are down; zero everywhere with no new jobs means detection
   stopped.
5. Source ages: if all sources are stale but the workers are alive, it is upstream — credentials
   or rate limits.
6. Check `AuditEvent` for the last successful transition to find where the pipeline stopped.
7. Restart the worker. It is stateless; everything in flight is in Redis and re-runs safely.
