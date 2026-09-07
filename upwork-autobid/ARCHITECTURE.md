# Architecture

## Module map

| Path | Responsibility |
|---|---|
| `src/config/env.ts` | Zod-validated environment. Every secret and toggle enters here |
| `src/lib/` | Logger, Prisma and Redis singletons, HTTP with retry/backoff/circuit-breaker/rate-limit, hashing, time and quota bucket helpers, error taxonomy |
| `src/sources/` | Detection. One module per source plus `normalize.ts` and a `registry.ts` that fans out concurrently and dedupes |
| `src/scoring/` | `hard-filters` → `scorer` (weighted dimensions) → `red-flags`, with an optional `llm-rerank`. `index.ts` orchestrates |
| `src/proposals/` | `pricing` (bid maths) → `templates` + `prompt` → `generator` (Claude) → `guardrails`. `index.ts` persists |
| `src/submit/` | `policy` (the gate), `quotas`, three submitters, and `dispatcher` which holds the lock and writes the audit trail |
| `src/notify/` | Telegram, Slack, email, console. `format.ts` builds the messages |
| `src/queue/` | BullMQ queue definitions and the idempotent repeatable-job scheduler |
| `src/workers/` | `discover` → `score` → `draft` → `submit`, plus `maintenance` and `heartbeat` |
| `src/server/` | Fastify API, auth, SSE hub, Prometheus metrics, route modules |
| `src/public/` | Zero-build dashboard: HTML, one CSS file, one JS file |
| `src/bootstrap/` | Single-process entry running API and workers together |

## Data model

| Model | Why it exists |
|---|---|
| `Profile` | One set of matching rules, thresholds, bid strategy, quotas and drafting instructions. Multiple profiles can run at once |
| `Job` | A detected posting, unique on `(source, externalId)`. `contentHash` distinguishes an edit from a re-sighting |
| `JobProfileMatch` | The score of one job against one profile, unique on `(jobId, profileId)`. Holds the breakdown, red flags and reasons |
| `Proposal` | A draft: letter, bid, answers, guardrail warnings, token usage, approval state |
| `Submission` | One attempt to send a proposal. Multiple rows per proposal across retries |
| `SourceCheckpoint` | Per-source cursor, last success, consecutive failures and a `disabledUntil` cooldown |
| `ConnectsLedger` | Every connect spent, so the daily budget is auditable |
| `NotificationLog` | Every notification attempt and its outcome |
| `AuditEvent` | Who or what did which state transition, and when |
| `Heartbeat` | Per-component liveness, read by the health endpoint |
| `OAuthToken` | Upwork access and refresh tokens |
| `Setting` | Runtime settings changed from the dashboard |

## Lifecycle

`Job.status`: `NEW → SCORED → DRAFTED → QUEUED → SUBMITTED`, with `SKIPPED` from scoring and
`EXPIRED` from maintenance.

`Proposal.status`: `DRAFT → PENDING_APPROVAL → APPROVED → SUBMITTING → SUBMITTED`, with `REJECTED`,
`FAILED` and `EXPIRED` as terminal states.

Each transition is one BullMQ job. Every job is idempotent: `discover` upserts on the unique
index, `score` upserts the match, `draft` returns an existing non-terminal proposal rather than
creating a second, and `submit` short-circuits if a `SUBMITTED` row already exists.

## The policy gate

`AUTO_SUBMIT` fires only when **all** of these hold:

1. `env.AUTO_SUBMIT` is true
2. `profile.autoSubmit` is true
3. `match.decision === 'BID'`
4. `match.score >= profile.autoBidThreshold`
5. no `HIGH` red flag
6. the proposal has no guardrail errors
7. quota headroom on the hourly, daily and connects counters
8. the selected submitter reports `canAutoSubmit && isConfigured()`

Anything missing means `REVIEW` with a stated reason. The gate fails **closed**, always.

## Concurrency and idempotency

- A Redis lock around the whole discover run stops overlapping schedules double-ingesting.
- A Redis lock keyed on the proposal id makes double-submission impossible across retries.
- Submission concurrency is 1 per profile, so quota checks cannot race.
- Quota counters are UTC day/hour buckets with an `EXPIRE` set on first increment.
- Repeatable jobs are registered with a stable key and stale ones are removed first, so a deploy
  does not accumulate duplicate schedules.

## Failure modes

| Failure | What happens |
|---|---|
| A source starts failing | Its checkpoint records consecutive failures and backs off with an exponential `disabledUntil`; maintenance alerts if it has not succeeded in 3× its poll interval. Other sources keep running |
| Claude API down or no key | `generator` falls back to the deterministic template path. Drafting never blocks the pipeline |
| Redis down | Queues stop. The health endpoint reports it and the process exits so the platform restarts |
| Postgres down | Same: reported, then a non-zero exit so the container is replaced |
| Quota exhausted | Policy returns `REVIEW` with the reason. Nothing is dropped |
| Upwork token expired | Refreshed automatically under a lock. A failed refresh surfaces as a config error naming the reconnect URL |
| Submitter lacks the scope | `api-submitter` maps the response to an actionable message and the dispatcher falls back to the review queue |
| Worker throws | Unhandled rejection and exception handlers log and exit non-zero, so the platform restarts it |
