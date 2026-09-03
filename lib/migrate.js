const { query } = require('./db');

// Idempotent schema top-ups. The production database is provisioned through the Vercel/Neon
// integration and its connection string is marked sensitive, so there is no practical way to run
// psql against it by hand — the app has to be able to bring its own schema forward. Every
// statement is `if not exists`, so running this repeatedly is a no-op.
//
// Mirrored in db/schema.sql for fresh installs; keep the two in step.
const STATEMENTS = [
  // Campaign metadata pulled from LinkedIn, so the UI can show only campaigns that are actually
  // live instead of every campaign ever created.
  `alter table campaigns add column if not exists status text`,
  `alter table campaigns add column if not exists serving_status text`,
  `alter table campaigns add column if not exists objective text`,
  `alter table campaigns add column if not exists format text`,
  `alter table campaigns add column if not exists cost_type text`,
  `alter table campaigns add column if not exists daily_budget numeric`,
  `alter table campaigns add column if not exists budget_currency text`,
  `alter table campaigns add column if not exists run_start date`,
  `alter table campaigns add column if not exists run_end date`,
  `alter table campaigns add column if not exists li_synced_at timestamptz`,

  // Ad-level metadata for assets imported straight from LinkedIn.
  `alter table assets add column if not exists li_status text`,
  `alter table assets add column if not exists li_is_serving boolean`,
  `alter table assets add column if not exists li_synced_at timestamptz`,
  `alter table assets add column if not exists imported_from_linkedin boolean not null default false`,

  // The importer matches on (campaign, creative) and must never create the same ad twice, even if
  // two syncs overlap. A partial unique index keeps the existing rows with a null creative id.
  `create unique index if not exists assets_li_creative_id_key
     on assets (li_creative_id) where li_creative_id is not null`,

  `create index if not exists campaign_daily_metrics_date_idx
     on campaign_daily_metrics (metric_date)`,
  `create index if not exists asset_daily_metrics_date_idx
     on asset_daily_metrics (metric_date)`,

  // Companies that saw each ad set. Keyed by the reporting window, not by day — LinkedIn only
  // serves the MEMBER_COMPANY pivot at timeGranularity=ALL, so a row is only valid for the exact
  // range it was fetched for. See lib/companies.js.
  `create table if not exists campaign_company_engagement (
     id serial primary key,
     campaign_id integer not null references campaigns(id) on delete cascade,
     range_start date not null,
     range_end date not null,
     company_urn text not null,
     company_name text,
     impressions integer not null default 0,
     clicks integer not null default 0,
     spend numeric not null default 0,
     reach integer not null default 0,
     leads integer not null default 0,
     fetched_at timestamptz not null default now(),
     unique (campaign_id, range_start, range_end, company_urn)
   )`,
  `create index if not exists campaign_company_engagement_lookup_idx
     on campaign_company_engagement (campaign_id, range_start, range_end)`,

  // Paid engagements (LinkedIn's totalEngagements — clicks plus reactions, comments, shares and
  // follows). Added after the table shipped, so existing rows default to 0 until their window is
  // re-fetched.
  `alter table campaign_company_engagement
     add column if not exists engagements integer not null default 0`,

  // Job function and job title breakdowns for an ad set, cached the same way and for the same
  // reasons as the company list. A separate table rather than more columns on the company one:
  // LinkedIn allows only a single demographic pivot per query, so these are ad-set-wide totals
  // that can't be attributed to a company. See lib/linkedin.js.
  `create table if not exists campaign_audience_breakdown (
     id serial primary key,
     campaign_id integer not null references campaigns(id) on delete cascade,
     range_start date not null,
     range_end date not null,
     dimension text not null check (dimension in ('job_function', 'job_title')),
     entity_urn text not null,
     entity_name text,
     impressions integer not null default 0,
     clicks integer not null default 0,
     engagements integer not null default 0,
     spend numeric not null default 0,
     leads integer not null default 0,
     fetched_at timestamptz not null default now(),
     unique (campaign_id, range_start, range_end, dimension, entity_urn)
   )`,
  `create index if not exists campaign_audience_breakdown_lookup_idx
     on campaign_audience_breakdown (campaign_id, range_start, range_end)`,

  // Widen the source check to allow 'mock'. Generated rows used to be stored as 'sync', which made
  // fake data indistinguishable from real once it was in the table — a week of it sat in production
  // unnoticed. Tagging it honestly is what makes it findable and removable.
  // Dropping and re-adding is the only way to change a check constraint; both halves are guarded so
  // re-running is a no-op.
  `alter table campaign_daily_metrics drop constraint if exists campaign_daily_metrics_source_check`,
  `alter table campaign_daily_metrics add constraint campaign_daily_metrics_source_check
     check (source in ('sync', 'manual', 'mock'))`,
  `alter table asset_daily_metrics drop constraint if exists asset_daily_metrics_source_check`,
  `alter table asset_daily_metrics add constraint asset_daily_metrics_source_check
     check (source in ('sync', 'manual', 'mock'))`
];

let done = false;

// Guarded per cold start so a warm function doesn't re-issue DDL on every request. `force` is used
// by the health endpoint to re-check on demand.
async function ensureSchema(force) {
  if (done && !force) return { ran: false, cached: true };
  const applied = [];
  const errors = [];
  for (const sql of STATEMENTS) {
    try {
      await query(sql);
      applied.push(sql.split('\n')[0].trim().slice(0, 70));
    } catch (e) {
      // A duplicate-object race between two concurrent invocations is expected and harmless.
      if (e.code === '42710' || e.code === '42P07' || e.code === '23505') continue;
      errors.push(`${sql.slice(0, 60)}: ${e.message}`);
    }
  }
  if (!errors.length) done = true;
  return { ran: true, statements: applied.length, errors };
}

module.exports = { ensureSchema };
