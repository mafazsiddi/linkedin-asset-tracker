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
| `/api/cron/sync` | GET/POST | daily LinkedIn sync, protected by `CRON_SECRET` |
| `/api/auth/linkedin/start`, `/callback` | GET | OAuth flow, inert until LinkedIn app is approved |
