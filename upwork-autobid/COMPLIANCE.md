# What Upwork actually permits

Everything here was checked against Upwork's own documents on **2026-09-07**. It decides how
this service is built, so it is worth reading before you change any default.

> **Verification caveat.** `www.upwork.com` and `developer.upwork.com` serve a Cloudflare
> challenge (HTTP 403) to automated fetchers, so the GraphQL reference and Legal Center were
> read through a text-rendering proxy that returns the primary document. `support.upwork.com`
> content came from Upwork's own first-party Help Center JSON API. The quotes below are
> verbatim and carry document versions and dates, but **confirm the two load-bearing facts in
> a browser yourself** before betting an account on them: that `createJobProposal` exists, and
> that the "Submit Proposal" scope is selectable on your API key.

## 1. The API does expose proposal submission

This contradicts the widely repeated claim that Upwork's API is client-side only.

| Operation | Scope required | Notes |
|---|---|---|
| `createJobProposal(input: CreateJobProposalInput!)` | `Submit Proposal` | "Create a new proposal using the new flow". Input carries `coverLetter`, bid amount, screening-question answers, attachments, milestones, `boostBidAmount`, `agencyOrgId`, `teamOrgId`. |
| `createContractProposal` | `Submit Proposal` | "Vendor (freelancer or agency manager) operation." `agencyTeamId` / `agencyManagerId` "only populated for agency proposals". |
| `withdrawContractProposal` | `Submit Proposal` | Pulls a submitted contract proposal. |
| `bidsForJob` | `Submit Proposal` | Returns the top 4 competing bids. |

All business operations are GraphQL at `api.upwork.com/graphql`; the only REST remnants are the
two OAuth2 endpoints. The OAuth2 authorize call takes **no `scope` parameter** — scopes are bound
to the API key itself, so you cannot request extra scopes at authorization time.

## 2. The gate is reputation, not membership tier

No paid plan buys API access. Upwork's Help Center: *"Clients and freelancers on any membership
plan can request access to Upwork API"* — subject to a hard bar:

- **$25,000** lifetime earnings (or spend, for clients)
- **JSS ≥ 90%**
- completed identity verification
- verified payment method
- account in good standing
- roughly a week of review

Two access tiers exist. The self-serve key at `upwork.com/services/api/apply` is *"available for
personal and internal use only. Commercial use isn't supported."* Anything commercial or
multi-tenant needs an unnamed partner arrangement via `partnerships@upwork.com` — no public name,
no published criteria. Credentials *"may not be transferred, shared, sublicensed, or made
available to any other person or entity"*, which forecloses running this as a SaaS on one key.

Only **Upwork Enterprise** names API access as a plan benefit, and specifically for
reporting/dashboard integration.

## 3. The clause that shapes this codebase

**Upwork API & MCP Terms of Use v2.3, effective 2026-08-13** — this superseded the older API
Terms. Three sections matter:

**§5.9 — the autonomy limit.** An Agent may not independently *"select, rank, score, or recommend
among candidates, postings, proposals, or contracts using criteria the Agent itself determines,
and tak[e] any consequential action absent the Principal's specific, contemporaneous direction
identifying its object."* It may only execute *"a specific action the Principal has directed with
respect to a specific, Principal-identified person, posting, proposal, or contract, where the
Principal made the underlying decision."*

That sentence is precisely a description of an autonomous auto-bidder, and it is why this service
defaults to a review queue rather than automatic submission. Scoring and drafting are fine —
**the human making the submit decision on a specific, identified posting is the compliant shape.**
Upwork ships exactly this themselves: their first-party Claude Connector and ChatGPT App can
*"Submit a proposal, optionally with a paid boost"* with the Connects cost shown before you confirm.

**§4.1 — the monitoring limit.** Permission to search or browse *"authorizes only access
reasonably necessary to perform a specific, documented, user-directed task and does not authorize
activity designed to enumerate or continuously monitor Upwork's available content corpus."*
"Bulk Access" is defined to include *"monitoring … of all or a substantial portion of any category
of Upwork Content … including all or substantially all available job postings"* via *"repeated,
paginated, incremental, continuous, distributed, or coordinated requests."*

A fixed-interval poller over `marketplaceJobPostingsSearch` is a textbook match for that language.
**See "Choosing a detection source" below** — this is the single most important configuration
decision in the service.

**§5.3 — the model limit.** Job descriptions and *"real-time event payloads"* may not be used to
train, fine-tune, **retrieval-augment**, evaluate or benchmark any ML model without a signed
license. Passing one job you were alerted to into a model to draft your own proposal is a
user-directed task; building a corpus of scraped postings to retrieve over is not.

§4.1 also expressly permits enabling users to *"draft, submit, and manage proposals"* and to
*"operate an Agent on behalf of an Upwork User"*, so the overall shape is sanctioned — the
constraint is on autonomy and on corpus-wide monitoring, not on automation itself.

## 4. Automating the website is flatly prohibited

Terms of Use v4.12 §3.5 bans *"a robot, spider, scraper, or similar mechanisms"*, bans scraping,
and — broadest of all — bans *"access[ing] our services through any technology other than our
interface."*

The Help Center article "Use bots and other automation properly" (updated 2026-09-01) defines a
bot to include *"any script, program, browser extension, or third-party service"*, states *"Even
if the tool says it was created for Upwork, it doesn't mean it's allowed"*, and says Upwork are
*"not able to approve or make exceptions for tools that automate interactions with Upwork"*.
Enforcement is a documented ladder: warning → temporary restriction → permanent block, and
*"using the tool again will result in another suspension."*

It also flags API-key holders specifically: *"Even with an API key, some actions remain off-limits.
Examples include spamming proposals or invites"*, and calls out *"using OAuth2 tokens or session
cookies from a browser or an official client in a script or bot."*

**Never point this service at the website.** There is no browser-automation source in this
codebase and none should be added.

## 5. Choosing a detection source

RSS is dead — discontinued after **2024-08-20**, confirmed both in the Help Center and in the
GraphQL schema, where `USER_SITE_SEARCH_RSS` and `JOBS_FEED` ("retrieve saved searches") are both
annotated *"No longer supported."* The `rss` source in this codebase remains for non-Upwork feeds.

| Source | Latency | Account needed | §4.1 posture |
|---|---|---|---|
| **Email job alerts** (`email`) | seconds | **Freelancer Plus** | Safest. Upwork pushes *you* the alert; the service reads your own mailbox. No corpus monitoring. |
| Mobile push | seconds | Freelancer Plus | Upwork's own recommendation: *"the fastest way to receive them"*. Not machine-readable — use email for the same alerts. |
| Webhook (`JP` / `NEW`) | sub-second | approved API key **+ per-subscription Upwork approval** | Documented at `upwork.com/developer/subscriptions`; subscriptions sit in `REVIEW` until Upwork approves. **Unconfirmed whether `JP`/`NEW` fires for all marketplace postings or only your own org's** — every sibling entity is org-scoped. Do not architect on this until you have asked Upwork. |
| GraphQL polling (`upwork_api`) | poll interval | approved API key | Most controllable, **highest §4.1 exposure**. Finest time filter is `daysPosted_eq` (days, not minutes), and the incremental cursors exist only on the deprecated legacy query — so it means re-fetching the recency-sorted head and de-duplicating. |

**Recommended configuration:** `SOURCES=email`, with the Upwork API used to enrich a *specific*
alerted job rather than to sweep the marketplace. `SOURCES=upwork_api` is implemented and works,
but read §4.1 above and decide deliberately.

Instant job alerts require **Freelancer Plus**. Job *digest* emails additionally require a Rising
Talent / Top Rated / Top Rated Plus badge.

### Rate limits

Two different official numbers are live simultaneously — use the lower:

- Developer docs: *"We allow 300 requests per minute per IP address."*
- Help Center (updated 2026-09-05): *"The API allows up to 10 requests per second per IP address."*

Separately there is a hard **40,000 requests/day** cap you attest to at key-request time. That is
27.8 req/min sustained — the daily cap, not the per-minute cap, is the real constraint.

## 6. Agency accounts

An Agency is the only Upwork-sanctioned way to run "one operator bids for many freelancers":

- unlimited member seats on Agency Plus
- a **single shared Connects pool**, topped up only by owner/admins
- an **Agency manager** role that can *"submit, edit, or withdraw proposals and accept or decline
  offers on behalf of any agency member"*

Every member keeps their own login. Credential sharing is prohibited by the User Agreement:
*"Never share your Account password with anyone; you can give permissions to other Users to act
under your Account Types as Team Members or Agency Members if needed."* A VA logging in as you is
a violation; a delegated agency seat is not.

On the API, `createJobProposal` carries `agencyOrgId` and a required `teamOrgId`, and multi-org
context is selected per request via the `X-Upwork-API-TenantId` header — set `UPWORK_TENANT_ID`.

## 7. Other platforms

If the goal is genuinely unattended bidding, the platform matters more than the code:

| Platform | Bid endpoint | Verdict |
|---|---|---|
| **Guru.com** | proposal-creation endpoints, self-service credentials | The **only** platform checked with an official, maintained, publicly documented API for creating proposals and no ToS clause banning automated access. Review the API Terms shown at registration. |
| Freelancer.com | `POST /projects/0.1/bids/` | Technically capable, **contractually forbidden**. Its own developer docs name "Automatic Bidders" as *"the most common prohibited integration that we see, and it will not be approved"*; ToS §33 requires express written permission for automated API access. |
| Fiverr | none | No developer portal exists. |
| Toptal, Gun.io, Braintrust, Arc.dev, Twine, Contra, Codeable, Wellfound | none | No public developer portal, and mostly no bidding concept — Toptal: *"You don't need to bid on projects."* |
| PeoplePerHour, Truelancer, Workana | internal only | No public documentation. |
| SAP Ariba | Surrogate Bid API | Appears buyer-side (a buying org entering bids for suppliers), not supplier self-service. |
| SAM.gov | read-only | Vendor-facing API does not submit. |

The source and submitter layers here are pluggable, so adding Guru is one file on each side.

## 8. What this means in practice

- Detection, scoring and drafting: **run them automatically, always on.** That is what this
  service does.
- Submission: **keep a human on it.** The review queue puts a notification on your phone with
  Approve/Reject buttons; the round trip is a few seconds. That is both the compliant shape and
  the one Upwork's own AI integrations use.
- `AUTO_SUBMIT=true` exists for the case where you hold a partner arrangement that covers it, or
  where you point the webhook submitter at your own system. It is off by default, it fails closed
  to the review queue when no capable submitter is configured, and turning it on is a decision
  about your account, not a config tweak.
