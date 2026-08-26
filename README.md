# LinkedIn asset tracker

Creative asset pipeline tracker for LinkedIn campaigns, with a daily LinkedIn Ads sync. Frontend is a
single static `index.html`; backend is Vercel Serverless Functions under `api/` backed by Postgres.

## Data model

- **Markets**: the 6 tracked countries (UAE, Oman, Philippines, Germany, India, Global), each with a POC.
- **Campaigns**: LinkedIn campaigns, matched by exact name (e.g. `UAE_EN - Compliance`) to Campaign
  Manager. Several creative assets can share one campaign.
- **Assets**: creative briefs/deliverables, each linked to a market and (optionally) a campaign.
- **Metrics**: stored per campaign per day (`campaign_daily_metrics`). "Current month" totals are
  summed on read — there's no separate lifetime counter to keep in sync. All spend is in INR.
  Metrics only exist at campaign granularity (that's what LinkedIn's API reports), so assets that
  share a campaign show identical numbers — that's expected, not a bug.

## One-time setup

1. **Postgres**: create a free database — either Vercel's own Postgres (Storage tab in your Vercel
   project, powered by Neon) or a [Neon](https://neon.tech) project directly. Either way you'll get a
   connection string.
2. Copy `.env.example` to `.env` and fill in `POSTGRES_URL`.
3. Run the schema:
   ```
   psql "$POSTGRES_URL" -f db/schema.sql
   ```
   This creates the tables and seeds the 6 markets with their POCs.
4. `npm install`

## Local development

```
npm install -g vercel   # once
vercel dev
```
This serves `index.html` and the `/api/*` functions together on one origin (matches how it runs in
production, so no CORS setup is needed). Loads `.env` automatically.

## Deploying (Vercel free tier)

```
vercel link       # first time, links this folder to a Vercel project
vercel env add POSTGRES_URL
vercel env add LINKEDIN_MODE           # "mock" for now
vercel env add LINKEDIN_AD_ACCOUNT_URN # urn:li:sponsoredAccount:509493016
vercel env add CRON_SECRET             # any random string — protects /api/cron/sync
vercel --prod
```
`vercel.json` schedules `/api/cron/sync` once a day (Hobby-plan-compatible). It runs in mock mode
until you flip `LINKEDIN_MODE`, generating deterministic fake numbers per campaign/day so the whole
pipeline (sync → store → roll up → display) is exercised end-to-end before real credentials exist.

For fresher-than-daily data on the free Vercel plan (which caps its own cron at once/day),
`.github/workflows/hourly-sync.yml` calls the same endpoint hourly via GitHub Actions. It needs a
repo secret: **Settings → Secrets and variables → Actions → New repository secret** named
`CRON_SECRET`, set to the same value as the `CRON_SECRET` env var in Vercel. The Vercel cron stays
as a once-daily fallback in case the Actions run is skipped or disabled.

## Adding real campaign IDs

Add campaigns from the UI ("+ Campaign" under a market, or "+ Asset" auto-creates one from the
campaign name you type) and fill in the **LinkedIn campaign ID** field on each. Or bulk-insert:
```sql
insert into campaigns (name, market_id, li_campaign_id)
values ('UAE_EN - Compliance', (select id from markets where name = 'UAE'), '123456789');
```
Only campaigns with a `li_campaign_id` set are included in the daily sync.

## Going live with LinkedIn (once the Marketing Developer Platform app is approved)

1. Set `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_REDIRECT_URI` (pointing at
   `https://<your-app>.vercel.app/api/auth/linkedin/callback`).
2. Visit `/api/auth/linkedin/start` (as the Company Page/Campaign Manager admin) to authorize and
   store an access token.
3. Set `LINKEDIN_MODE=live`. The next cron run calls the real LinkedIn Marketing API instead of the
   mock. `lib/linkedin.js` has the request shape — it's a best-effort scaffold and hasn't been
   tested against a real approved app yet, so double-check the response field names once you have
   live data.

## API summary

> **Function budget:** Vercel's Hobby plan allows **12 Serverless Functions per deployment**, and
> `api/` currently holds exactly 12 — deploying a 13th file fails the build outright. Add new
> endpoints as extra methods/query params on an existing handler (as `?creatives=1` and the
> `/api/notifications/read` rewrite in `vercel.json` both do), not as new files.


| Endpoint | Methods | Notes |
|---|---|---|
| `/api/markets` | GET, POST | list / create markets |
| `/api/markets/:id` | PUT, DELETE | |
| `/api/campaigns` | GET (`?marketId=`), POST | list / create campaigns |
| `/api/campaigns/:id` | PUT, DELETE | |
| `/api/assets` | GET, POST | assets joined with their campaign's current-month metrics |
| `/api/assets/:id` | PUT, DELETE | reassigning `assignedTo` creates a notification |
| `/api/metrics/manual` | POST | manual stopgap entry for a campaign/day; sync overwrites it |
| `/api/notifications` | GET | |
| `/api/notifications/read` | POST | `{}` marks all read, `{"clear":true}` deletes all |
| `/api/cron/sync` | GET/POST | LinkedIn sync, protected by `CRON_SECRET`. `?days=N`, `?start=&end=`, `?campaignId=N` |
| `/api/campaigns/:id?creatives=1` | GET | lists the real LinkedIn ads under a campaign, so an asset can be linked to one |
| `/api/health` | GET | diagnostics — DB reachability, schema completeness, token validity, last sync |
| `/api/auth/linkedin/start`, `/callback` | GET | OAuth flow, inert until LinkedIn app is approved |

## How metrics reach an asset

Metrics land at two levels, and which one an asset shows depends on whether it's linked to a
specific LinkedIn ad:

- **Campaign level** (`campaign_daily_metrics`, `pivot=CAMPAIGN`) — needs `li_campaign_id` on the
  campaign. Without it the sync has nothing to fetch and everything stays at zero.
- **Ad level** (`asset_daily_metrics`, `pivot=CREATIVE`) — needs `li_creative_id` on the asset. Set
  it from the asset modal ("Find ads" pulls the real IDs from LinkedIn via `/api/creatives`).

An asset with **no** `li_creative_id` falls back to showing its parent campaign's totals, reported
as `metrics_source: "campaign"` — shared with every other asset on that campaign. An asset that
*is* linked but has no data is genuinely not serving, and correctly stays at zero.

The sync re-fetches a **trailing window** (`SYNC_WINDOW_DAYS`, default 7) on every run rather than
just the current day. LinkedIn restates a day's numbers for ~2-3 days as clicks are de-duplicated
and conversions attributed, so a single-day fetch permanently bakes in whatever was true at that
moment — and any skipped run left a hole in the month-to-date sum that never healed. Re-fetching a
window makes the stored data self-correcting.

Adding a campaign with a LinkedIn ID (or attaching one later) triggers an immediate month-to-date
backfill, so it shows real numbers straight away instead of waiting for the next scheduled run.

## Troubleshooting

**Start with `/api/health`.** It distinguishes the failure modes that otherwise all look identical
in the UI (an empty table):

| Symptom | Cause |
|---|---|
| `database.code: "28P01"` | `POSTGRES_URL` is stale. Vercel bakes env vars in at **deploy** time — changing the variable is not enough, you must redeploy (`vercel --prod`). |
| `database.missingTables: [...]` | Database is reachable but empty — run `psql "$POSTGRES_URL" -f db/schema.sql`. |
| `linkedin.tokenStored: false` while `mode: "live"` | Nobody has authorised the app. Visit `/api/auth/linkedin/start`. |
| `linkedin.tokenExpired: true` | Reconnect via `/api/auth/linkedin/start`. |
| `counts.campaignsWithLinkedInId: 0` | No campaign has a LinkedIn campaign ID, so the sync has nothing to fetch. |
| `sync.daysWithDataThisMonth` lower than expected | Missing days — the month-to-date total is under-counting. Backfill with `/api/cron/sync?start=YYYY-MM-DD&end=YYYY-MM-DD`. |

`sync.last.error` carries the last run's failure text. A run that partially fails now reports
`status: "partial"` and still syncs every campaign that worked, rather than aborting on the first
bad one.
