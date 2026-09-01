# LinkedIn asset tracker

Creative asset pipeline tracker for LinkedIn campaigns, with a daily LinkedIn Ads sync. Frontend is a
single static `index.html`; backend is Vercel Serverless Functions under `api/` backed by Postgres.

## Data model

- **Markets**: the 6 tracked countries (UAE, Oman, Philippines, Germany, India, Global), each with a POC.
- **Campaigns**: LinkedIn campaigns, matched by exact name (e.g. `UAE_EN - Compliance`) to Campaign
  Manager. Several creative assets can share one campaign.
- **Assets**: creative briefs/deliverables, each linked to a market and (optionally) a campaign.
- **Metrics**: stored per campaign per day (`campaign_daily_metrics`). Totals for whatever period
  the date picker is on are summed on read — there's no separate lifetime counter to keep in sync.
  All spend is in INR. Metrics only exist at campaign granularity (that's what LinkedIn's API
  reports), so assets that share a campaign show identical numbers — that's expected, not a bug.
- **Company engagement**: which companies saw each ad set (`campaign_company_engagement`), keyed by
  reporting window rather than by day — see "Which companies saw an ad set" below.

## Reporting period

The date picker drives every number on the page and offers three ways to pick a period:

| Mode | What it does |
|---|---|
| Presets | This month, last month, this quarter, last 7/30 days, all time |
| **Month** | Any month of any year, one tap — paged by year |
| **Quarter** | Q1–Q4 of any year |
| **Calendar** | Click a first and last day for an arbitrary range |

A month or quarter still in progress is clamped to today, so "This quarter" means quarter-to-date
rather than asking the API for days that haven't happened yet. The picked period keeps its name in
the UI ("Q3 2026" rather than "Jul 1 – Sep 30").

> "All time" sends `?all=1`. It has to be explicit: an absent range makes the API fall back to the
> current month, so before this existed the all-time option quietly showed current-month numbers.

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

### Refresh cadence — every 2 hours

The free Vercel plan caps its own cron at once per day, so the real schedule lives in
`.github/workflows/sync.yml`, which calls the same endpoint **every 2 hours** via GitHub Actions.
It needs a repo secret: **Settings → Secrets and variables → Actions → New repository secret**
named `CRON_SECRET`, set to the same value as the `CRON_SECRET` env var in Vercel. The Vercel cron
stays as a once-daily fallback in case the Actions run is skipped or disabled.

GitHub's scheduler is best-effort and can run late under load. That's tolerable here because each
run re-fetches a trailing window rather than a single day (see "How metrics reach an asset"), so a
late or skipped run is corrected by the next one instead of leaving a permanent hole.

The header shows how stale the data is ("Synced 2h ago"), flagging anything older than two missed
cycles, and an open tab re-pulls every hour so a dashboard left up all day doesn't quietly freeze.

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
| `/api/cron/sync` | GET/POST | LinkedIn sync, protected by `CRON_SECRET`. `?days=N`, `?start=&end=`, `?campaignId=N`, `?replace=1` |
| `/api/campaigns/:id?creatives=1` | GET | lists the real LinkedIn ads under a campaign, so an asset can be linked to one |
| `/api/campaigns/:id?companies=1` | GET | companies that saw this ad set. `?start=&end=`/`?all=1`, `?refresh=1` to bypass the cache |
| `/api/assets` (POST `{assets:[…]}`) | POST | bulk create for the CSV importer; validates and reports per row |
| `/api/health` | GET | diagnostics — DB reachability, schema completeness, token validity, last sync |
| `/api/auth/linkedin/start`, `/callback` | GET | OAuth flow, inert until LinkedIn app is approved |

## Ads are imported from LinkedIn automatically

The sync pulls the ads (creatives) that actually exist under each campaign and creates an asset row
for each one — matched on `li_creative_id`, which is uniquely indexed, so re-running only fills in
ads that have appeared since. Adding a campaign with a LinkedIn ID imports its ads immediately
rather than waiting for the next scheduled run.

Existing assets are refreshed in place, never duplicated, and only the columns LinkedIn owns
(`li_status`, `li_is_serving`) are touched — locally edited fields like assignee, due date, notes
and links are left alone. Run a metrics-only sync with `?skipImport=1`.

**Ads that never ran are not imported.** `CANCELED` (LinkedIn's marker for a deleted ad) and
`DRAFT` creatives are skipped — this account carries ~70 of them, all unnamed and with no
impressions, and importing them buried the real assets. An ad cancelled *after* it was imported is
pruned on the next sync, but only when nothing would be lost: the row must have been created by the
importer, have no recorded metrics, and have no local edits. Hand-created assets are never pruned,
and an ad with spend history is kept even once cancelled.

Campaign status, objective, budget and schedule are mirrored too. That's what powers the
**live-only campaign filter**: LinkedIn reports state two ways — `status` is what the advertiser
set (`ACTIVE`, `PAUSED`, `ARCHIVED`…) and `servingStatuses` says whether it can actually deliver
right now. The two disagree often: most of this account's `ACTIVE` campaigns sit on
`CAMPAIGN_GROUP_STATUS_HOLD` because their parent campaign group is paused, and are not running at
all.

`RUNNABLE` is the only serving status that means delivering — **there is no `RUNNING` value**,
which is worth knowing because matching on it silently marks every campaign as not live. Everything
else is a stop or a hold (billing, budget, date window, group status). The UI shows only `RUNNABLE`
campaigns, labels held ones with the reason rather than calling them "Active", and hides the rest
behind a "Show non-live campaigns" toggle.

> Market-level totals deliberately still sum **all** campaigns, not just live ones — spend in the
> period is spend in the period, and filtering it would under-report the month.

### API paths

LinkedIn retired the account-less creative and campaign endpoints; both now require the advertiser
account in the path and return a 400 explaining so if you use the old form:

- `/rest/adAccounts/{adAccountId}/creatives` (not `/rest/creatives`)
- `/rest/adAccounts/{adAccountId}/adCampaigns` (not `/rest/adCampaigns`)

The account id is the numeric tail of `LINKEDIN_AD_ACCOUNT_URN`.

### Schema migrations

`lib/migrate.js` applies idempotent `add column if not exists` statements on demand, because the
production database is provisioned through the Vercel/Neon integration and its connection string is
marked sensitive — there's no practical way to run `psql` against it by hand. The sync calls it
before each run. `db/schema.sql` carries the same columns for fresh installs; keep the two in step.

## The same creative across several ad sets

A creative is uploaded once per ad set it runs in, so LinkedIn returns several distinct ads —
different creative IDs, different campaigns, identical artwork and name. "Beyond e-Invoicing"
running in both `GLOBAL_US_E-INV_AUG_26` and `Global_UK_E-INV_AUG_26` is two rows in LinkedIn but
one thing to produce and chase.

Assets are therefore **merged on ad name** wherever they're listed. The merged card carries the
combined spend/impressions/clicks and a badge naming how many ad sets it spans; tapping the badge
breaks it down per ad set. Ratios are recomputed from the combined totals (CTR = total clicks over
total impressions), never averaged across placements — that would weight a 12-impression placement
the same as a 12,000-impression one.

**"Combine duplicate creatives" turns this off.** A combined row shows the total across every ad
set, so it is deliberately larger than the matching line in Campaign Manager — a creative in three
ad sets shows roughly triple. That is a sum, not a bug, but it makes side-by-side reconciliation
impossible, so the toggle (in the filter bar and above the All-assets table, persisted, default on)
switches to one row per ad, which lines up with Campaign Manager one-to-one. Totals are identical
either way; only the grouping changes. Combined rows also carry a `combined` chip next to their
figures so a summed number is never mistaken for a single ad's.

Grouped on the **name**, not the creative ID: the ID is unique per placement, so it would never
group anything. The breakdown rolls up per ad set rather than per placement because LinkedIn
routinely holds several creative IDs for the same artwork inside one ad set — this account has a
creative appearing 18 times across 7 ad sets, and 18 near-identical lines answer nothing. Where all
placements sit in one ad set the badge counts placements instead, so it never reads "1 ad sets".

## Which companies saw an ad set

Each campaign row has a **Companies** expander mirroring Campaign Manager's Companies report —
company name, an engagement level relative to the top company, impressions, clicks and CTR.

This one can't work like the other metrics, for two reasons:

- LinkedIn only serves demographic pivots (`MEMBER_COMPANY` among them) at `timeGranularity=ALL`.
  There is no per-day breakdown to store and re-slice, so a result is only valid for the exact date
  range it was requested for — hence `range_start`/`range_end` in the cache key rather than a
  `metric_date`. Changing the reporting period discards what's loaded rather than showing the
  previous period's companies under the new heading.
- The account reports engagement from ~500k companies. Pulling every campaign's list on a schedule
  would dwarf the rest of the database for data almost nobody opens.

So it's fetched **on demand and cached** (`campaign_company_engagement`), with the top
`COMPANY_TOP_N` (default 100) companies kept per window and the cache considered fresh for
`COMPANY_CACHE_TTL_MINUTES` (default 120, matching the sync cadence). `?refresh=1` forces a re-pull.
If LinkedIn is unreachable and a stale entry exists it's served with a "showing the last good pull"
marker — a panel saying "as of 4 hours ago" beats one saying nothing.

Company names aren't on the analytics response (the pivot value is a bare `urn:li:organization:…`),
and the plain `/rest/organizations` lookup needs an organization-admin scope this app doesn't have.
Names come from `adTargetingEntities?q=urns`, which the ads scopes do cover. Resolution is
best-effort: an unresolvable company still appears, labelled by its ID.

## Asset library

A third tab holding the asset records on their own — no campaign metrics. Everywhere else an asset
sits next to its spend, which is right for reporting and wrong for producing: the people filling
this in care about who owns a brief, when it's due and where the file lives.

It's also the only bulk entry point. Drop a CSV (or click to pick one) and rows are validated in a
preview before anything is written — unknown countries, missing titles and malformed dates are
called out by line number. **Template** downloads the expected columns; **Export** dumps the current
filtered view back out as CSV.

Columns: `title` and `country` are required, everything else optional — `campaign`, `type`,
`status`, `priority`, `requested_by`, `assigned_to`, `due_date` (YYYY-MM-DD), `version`,
`asset_link`, `ad_copy_link`, `creative_link`, `notes`. `market`/`name`/`owner`/`due`/`ad_set` are
accepted as aliases. A campaign named in the CSV that doesn't exist yet is created, the same as
typing a new campaign name in the "+ Asset" modal.

Rows are inserted independently and failures reported per row rather than aborting the batch: one
typo'd country in a 200-row spreadsheet shouldn't discard the other 199.

## Home page

Above the country breakdown sits an **overall campaign performance** panel: combined spend,
impressions, clicks, leads, CTR/CPC/CPM/CPL and the live ad-set count for the selected period, then
every ad set ranked by spend.

The headline totals cover **all** ad sets in the period while the table lists live ones only, which
is stated on the panel — spend in the period is spend in the period, whether or not the ad set is
still running, but "what's running now" is the useful table.

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

## Two ways the stored numbers went wrong

Both of these produced totals that looked entirely plausible in the UI and only showed up when a
month was compared against Campaign Manager line by line. Both are now prevented in code; the
`scratchpad` audit approach below is how to re-check at any time.

### 1. Mock data written into production

`LINKEDIN_MODE` defaults to `mock`. An unset, misspelled, or not-yet-redeployed variable therefore
turns the scheduled sync into a **fake-data generator pointed at the production database** — and
because it upserts, it overwrites real days and invents days LinkedIn never reported. A week of
generated rows sat in August unnoticed.

What made it invisible was that generated rows were stored with `source = 'sync'`, exactly like
real ones. Nothing downstream could tell them apart. Two changes fix that:

- Generated rows are now stored with **`source = 'mock'`**.
- The sync **refuses to run in mock mode** against a database that already contains real (`sync`)
  rows, returning `409 refused`. Deliberate mock generation needs `ALLOW_MOCK_WRITES=1`.

The fingerprint, if you ever need to spot it by eye: `mockDailyStats` seeds on
`hash(campaignId + dateISO)`, and consecutive dates shift that hash by exactly 1 — so mock rows
show **impressions incrementing by exactly 1 per day with spend and clicks frozen**:

```
2026-08-20   spend 1742   impr 2687   clicks 26
2026-08-21   spend 1742   impr 2688   clicks 26
2026-08-22   spend 1742   impr 2689   clicks 26
```

Negative spend or clicks are the same generator's older signed-shift bug. Real LinkedIn data never
looks like either; the upserts now also clamp every metric at zero on write, not just on read.

### 2. Half the ads were never imported, because the creatives finder is cursor-paged

One `creatives` call covering all 22 campaigns returned **102 creatives belonging to just 4 of
them**. The other 18 campaigns looked like they had no ads at all, so their ads were never
imported and never got ad-level metrics — a creative running in four ad sets showed as three.
Asking for the campaigns one at a time returned their ads correctly, which is what gave it away.

LinkedIn uses two incompatible pagination schemes on the endpoints this app touches, and picking
the wrong one fails silently in a different way each time:

| Endpoint | Scheme | Behaviour if handled wrongly |
|---|---|---|
| `/adAccounts/{id}/creatives` | **cursor** — `pageSize` + `pageToken`, next token in `metadata.nextPageToken` | caps `count` at 100 and **ignores `start`**, so offset paging re-fetches page one forever |
| `adAnalytics` | **none** — honours a large `count` in one response | **ignores `start`**; `start=100` returns the same rows as `start=0`, so offset paging loops on duplicates |
| `adAccounts/{id}/adCampaigns` (search) | none needed — batched 20 ids at a time | — |

So creatives are cursor-paged to exhaustion, while analytics is fetched in a single request with a
large `count`. Because that request cannot be paged, `linkedInGetUnpaged` treats a response that
exactly fills the requested count as an **error** rather than returning quietly-truncated data —
callers stay well under it by chunking dates (see below) and batching ids.

Fixing this imported 11 previously invisible ads (140 → 151) and left every campaign with at least
one ad.

### 3. `approximateMemberReach` vanishes on long ranges

LinkedIn stops returning `approximateMemberReach` once the requested range gets long. A 31-day
query returns reach on every row; a 93-day query returns **identical impressions and clicks with
reach silently absent** — and `Number(undefined || 0)` turns that into a confident `0`. Nothing in
the response indicates it happened, so a full-history backfill wiped reach from every row it wrote
while reporting `status: "ok"`.

Every analytics request is therefore chunked into `MAX_RANGE_DAYS` (31) windows and merged. Chunks
are per-day disjoint, so merging cannot double-count.

> **Reach is not shown in the UI.** LinkedIn reports `approximateMemberReach` per day, so summing a
> range counts the same member once per day they were served — it is not the unique reach Campaign
> Manager shows, and it tracked impressions at ~89% (correlation 0.74) anyway, so it contributed a
> number that looked authoritative while saying nothing impressions didn't. It is still fetched and
> stored, so it can be surfaced again without a backfill. Spend, impressions, clicks and leads are
> additive and do match Campaign Manager.

## Leads only appear where leads can exist

`oneClickLeads` counts lead-form submissions, which only a `LEAD_GENERATION` campaign has. This
account runs 12 lead-gen, 9 website-conversion and 1 website-visit ad sets, so a leads column
showed `0` against two thirds of the live ones — which reads as broken tracking rather than as
"this objective doesn't produce leads".

Leads and CPL are therefore shown only where the objective is `LEAD_GENERATION`:

- campaign chips include `leads`/`CPL` only for lead-gen ad sets;
- the All-assets table shows a Leads column only when something in view is lead-gen, and prints
  `—` rather than `0` on rows that aren't;
- the home-page Leads tile totals lead-gen ad sets only, and disappears if there are none;
- a market's header chip falls back to impressions when that market runs no lead-gen campaigns;
- the manual-entry modal only asks for leads on a lead-gen campaign.

All 70 recorded leads sit in 6 ad sets, all of them lead-gen — so nothing is hidden that had a
number against it.

### Re-auditing at any time

```
node scripts/audit-metrics.js 2026-08-01 2026-08-31
```

For each campaign it fetches the range live from LinkedIn, sums the same range out of
`campaign_daily_metrics`, and prints any disagreement — plus a count of negative rows and rows
tagged `mock`. Read-only, exits non-zero on a mismatch so it can gate a deploy. Requires
`LINKEDIN_MODE=live`; it refuses to run otherwise, since comparing stored data against generated
numbers proves nothing.

Current state — all 22 campaigns match exactly:

```
linkedin : spend=664439  impressions=247656  clicks=2127  reach=128858  leads=8
stored   : spend=664439  impressions=247656  clicks=2127  reach=128858  leads=8
```

When it reports a mismatch, rebuild that window authoritatively:

```
curl -H "Authorization: Bearer $CRON_SECRET" \
  ".../api/cron/sync?start=2026-08-01&end=2026-08-31&replace=1&skipImport=1"
```

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

### Re-fetching a range authoritatively

A normal sync upserts, so it can only correct days LinkedIn returns data for — a wrong row for a
day a campaign wasn't serving would survive re-syncing forever. `?replace=1` drops the stored rows
in the window and rebuilds them from what LinkedIn returns:

```
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://<your-app>.vercel.app/api/cron/sync?start=2026-08-20&end=2026-08-26&replace=1"
```

The delete happens per campaign and only *after* that campaign's fetch has succeeded, so a failed
API call can never destroy stored data. Rows outside the window are untouched. Use it when stored
data is known-bad; the scheduled runs deliberately don't, so a LinkedIn outage can't wipe history.

> **`LINKEDIN_MODE` must be `live` in the deployed environment**, not just in `.env`. Vercel bakes
> env vars in at deploy time, so changing it requires a redeploy. If it resolves to `mock` the sync
> will happily overwrite real metrics with generated numbers — check `linkedin.mode` on
> `/api/health`, and `/api/health?probe=1` to make one read-only live call and confirm the
> credentials actually work.
