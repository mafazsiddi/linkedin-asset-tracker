-- LinkedIn asset tracker schema.
-- Run this once against your Postgres database (Vercel Postgres / Neon free tier both work):
--   psql "$POSTGRES_URL" -f db/schema.sql

create table if not exists markets (
  id serial primary key,
  name text not null unique,
  poc_name text,
  channel text,
  drive_folder_link text,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists campaigns (
  id serial primary key,
  li_campaign_id text unique,
  name text not null,
  market_id integer not null references markets(id) on delete cascade,
  -- Mirrored from LinkedIn by the sync. `status` is what the advertiser set (ACTIVE, PAUSED,
  -- ARCHIVED...); `serving_status` is whether it is actually delivering right now — a campaign can
  -- be ACTIVE but held by billing or its date window. The UI shows only live campaigns by default.
  status text,
  serving_status text,
  objective text,
  format text,
  cost_type text,
  daily_budget numeric,
  budget_currency text,
  run_start date,
  run_end date,
  li_synced_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists assets (
  id serial primary key,
  title text not null,
  type text not null default 'Image',
  market_id integer not null references markets(id) on delete cascade,
  campaign_id integer references campaigns(id) on delete set null,
  -- The LinkedIn ad (creative) this asset represents. Assets imported straight from LinkedIn get
  -- this set automatically; an asset without one falls back to showing its campaign's totals.
  li_creative_id text,
  li_status text,
  li_is_serving boolean,
  li_synced_at timestamptz,
  imported_from_linkedin boolean not null default false,
  requested_by text,
  assigned_to text,
  priority text default 'Medium',
  due_date date,
  status text not null default 'Requested',
  date_delivered date,
  link text,
  version text default 'v1',
  ad_copy_link text,
  creative_link text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per campaign per day. "Current month" totals are SUM()'d across this table on read —
-- there is no separate lifetime-totals column to keep in sync.
create table if not exists campaign_daily_metrics (
  id serial primary key,
  campaign_id integer not null references campaigns(id) on delete cascade,
  metric_date date not null,
  spend numeric not null default 0,
  impressions integer not null default 0,
  clicks integer not null default 0,
  reach integer not null default 0,
  leads integer not null default 0,
  source text not null default 'manual' check (source in ('sync', 'manual', 'mock')),
  updated_at timestamptz not null default now(),
  unique (campaign_id, metric_date)
);

-- One row per asset (LinkedIn creative/ad) per day — mirrors campaign_daily_metrics but at the
-- individual-ad level, since LinkedIn's Analytics API also supports pivot=CREATIVE. Several assets
-- can share a campaign, and each needs its own numbers rather than the whole campaign's rollup.
create table if not exists asset_daily_metrics (
  id serial primary key,
  asset_id integer not null references assets(id) on delete cascade,
  metric_date date not null,
  spend numeric not null default 0,
  impressions integer not null default 0,
  clicks integer not null default 0,
  reach integer not null default 0,
  leads integer not null default 0,
  source text not null default 'manual' check (source in ('sync', 'manual', 'mock')),
  updated_at timestamptz not null default now(),
  unique (asset_id, metric_date)
);

-- Which companies saw a given campaign's ads, per reporting window.
--
-- Not one row per day like the other metrics tables: LinkedIn only serves demographic pivots
-- (MEMBER_COMPANY) at timeGranularity=ALL, so a result is only meaningful for the exact date range
-- it was requested for — hence range_start/range_end in the key rather than a metric_date. Filled
-- on demand by lib/companies.js and re-fetched once fetched_at ages past the cache TTL.
create table if not exists campaign_company_engagement (
  id serial primary key,
  campaign_id integer not null references campaigns(id) on delete cascade,
  range_start date not null,
  range_end date not null,
  company_urn text not null,
  company_name text,
  impressions integer not null default 0,
  clicks integer not null default 0,
  -- LinkedIn's totalEngagements: clicks plus reactions, comments, shares and follows.
  engagements integer not null default 0,
  spend numeric not null default 0,
  reach integer not null default 0,
  leads integer not null default 0,
  fetched_at timestamptz not null default now(),
  unique (campaign_id, range_start, range_end, company_urn)
);

-- Job function and job title breakdowns for an ad set, cached like the company list above.
--
-- Kept apart from campaign_company_engagement rather than folded in as extra columns because
-- LinkedIn serves only one demographic pivot per query: these are ad-set-wide totals with no way to
-- attribute them to a company, so "titles at company X" is not a row that can exist.
create table if not exists campaign_audience_breakdown (
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
);

create table if not exists notifications (
  id serial primary key,
  to_name text not null,
  asset_id integer references assets(id) on delete cascade,
  asset_title text,
  market_name text,
  created_at timestamptz not null default now(),
  read boolean not null default false
);

create table if not exists sync_log (
  id serial primary key,
  run_at timestamptz not null default now(),
  status text not null,
  campaigns_synced integer not null default 0,
  error text
);

-- Single-row-in-practice table holding the current LinkedIn OAuth token, once the app is approved.
create table if not exists linkedin_tokens (
  id serial primary key,
  access_token text,
  refresh_token text,
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);

insert into markets (name, poc_name)
values
  ('UAE', 'Tanya Gupta'),
  ('Oman', 'Mr. AJ'),
  ('Philippines', 'Anna'),
  ('Germany', 'Tanya Gupta'),
  ('India', 'Mr. AJ'),
  ('Global', 'Tanya Gupta')
on conflict (name) do nothing;

-- The ad importer matches on li_creative_id and must never create the same ad twice, even if two
-- syncs overlap. Partial so pre-existing rows without a creative id are unaffected.
create unique index if not exists assets_li_creative_id_key
  on assets (li_creative_id) where li_creative_id is not null;

create index if not exists campaign_daily_metrics_date_idx on campaign_daily_metrics (metric_date);
create index if not exists asset_daily_metrics_date_idx on asset_daily_metrics (metric_date);
create index if not exists campaign_company_engagement_lookup_idx
  on campaign_company_engagement (campaign_id, range_start, range_end);
create index if not exists campaign_audience_breakdown_lookup_idx
  on campaign_audience_breakdown (campaign_id, range_start, range_end);
