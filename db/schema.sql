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
  created_at timestamptz not null default now()
);

create table if not exists assets (
  id serial primary key,
  title text not null,
  type text not null default 'Image',
  market_id integer not null references markets(id) on delete cascade,
  campaign_id integer references campaigns(id) on delete set null,
  li_creative_id text,
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
  source text not null default 'manual' check (source in ('sync', 'manual')),
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
  source text not null default 'manual' check (source in ('sync', 'manual')),
  updated_at timestamptz not null default now(),
  unique (asset_id, metric_date)
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
