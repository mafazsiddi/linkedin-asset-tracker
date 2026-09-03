const { query } = require('./db');
const { getCampaignCompanyEngagement, getCampaignAudienceBreakdown } = require('./linkedin');

// Read-through cache for "who has seen this ad set" — the company list, and the job function and
// job title breakdowns that sit under it.
//
// This can't work like the other metrics. Spend/impressions are stored one row per campaign per
// day and summed over whatever window the UI asks for, but LinkedIn only serves demographic pivots
// (MEMBER_COMPANY, MEMBER_JOB_FUNCTION, MEMBER_JOB_TITLE) at timeGranularity=ALL — one aggregate
// for the whole range, with no per-day breakdown to store. So a stored row is only ever valid for
// the exact window it was fetched for, and the cache key has to include that window.
//
// The other reason not to fold this into the cron sync: the account reports ~500k engaged
// companies. Pulling every campaign's full company list on a schedule would dwarf the rest of the
// database for data almost nobody opens. Fetching on demand and caching keeps it proportional.
//
// Companies and the two facets are fetched through separate entry points on purpose. They are
// independent LinkedIn queries, the caller wants the company table on screen first, and making the
// list wait on a title pivot it didn't ask about is what made this panel feel slow.

// How long a cached window stays fresh. Matches the 2-hourly sync cadence, so the panel is never
// staler than the numbers next to it.
const TTL_MINUTES = Number(process.env.COMPANY_CACHE_TTL_MINUTES || 120);

// LinkedIn returns the long tail; the panel shows the values that actually engaged. Anything past
// this is noise with a single impression against it.
const TOP_N = Number(process.env.COMPANY_TOP_N || 100);

// ---- freshness ----
//
// Freshness is tracked in its own table rather than inferred from the cached rows. "LinkedIn
// reported nothing" is a legitimate and very common answer here — demographic values below a
// privacy threshold are dropped entirely — and with row presence as the signal an empty window is
// indistinguishable from one never fetched. Every open re-hit LinkedIn, and the panel's
// widen-to-90-days retry made that twice per open.

async function readMarker(campaignId, start, end, kind) {
  const { rows } = await query(
    `select fetched_at from campaign_audience_fetch
      where campaign_id = $1 and range_start = $2 and range_end = $3 and kind = $4`,
    [campaignId, start, end, kind]
  );
  return rows.length ? rows[0].fetched_at : null;
}

async function writeMarker(campaignId, start, end, kind) {
  await query(
    `insert into campaign_audience_fetch (campaign_id, range_start, range_end, kind, fetched_at)
     values ($1,$2,$3,$4, now())
     on conflict (campaign_id, range_start, range_end, kind)
     do update set fetched_at = now()`,
    [campaignId, start, end, kind]
  );
}

function isFresh(fetchedAt) {
  if (!fetchedAt) return false;
  return Date.now() - new Date(fetchedAt).getTime() < TTL_MINUTES * 60 * 1000;
}

// One multi-row insert instead of one per value. These tables cache up to TOP_N rows and the
// database is a pooled Neon instance several hundred milliseconds away — a row-at-a-time loop spent
// ~100 sequential round trips, which was the bulk of the time the panel took to load.
function bulkInsert(table, columns, fixedValues, rows, toValues, conflictColumns) {
  const params = fixedValues.slice();
  const tuples = rows.map(row => {
    const offset = params.length;
    const cells = toValues(row);
    params.push(...cells);
    const fixedRefs = fixedValues.map((_, i) => `$${i + 1}`);
    const rowRefs = cells.map((_, i) => `$${offset + i + 1}`);
    return `(${fixedRefs.concat(rowRefs).join(',')}, now())`;
  });
  const updates = columns
    .slice(fixedValues.length)
    .map(c => `${c} = excluded.${c}`)
    .concat('fetched_at = now()')
    .join(', ');
  return query(
    `insert into ${table} (${columns.join(',')}, fetched_at)
     values ${tuples.join(',')}
     on conflict (${conflictColumns.join(',')}) do update set ${updates}`,
    params
  );
}

// ---- companies ----

async function readCompanies(campaignId, start, end) {
  const { rows } = await query(
    `select company_urn, company_name, impressions, clicks, engagements, spend, reach, leads
       from campaign_company_engagement
      where campaign_id = $1 and range_start = $2 and range_end = $3
      order by impressions desc`,
    [campaignId, start, end]
  );
  return rows.map(r => ({
    companyUrn: r.company_urn,
    companyId: String(r.company_urn || '').split(':').pop(),
    name: r.company_name,
    impressions: Number(r.impressions) || 0,
    clicks: Number(r.clicks) || 0,
    engagements: Number(r.engagements) || 0,
    spend: Number(r.spend) || 0,
    reach: Number(r.reach) || 0,
    leads: Number(r.leads) || 0
  }));
}

async function writeCompanies(campaignId, start, end, companies) {
  // Replace rather than upsert: a company that stopped appearing in the window must disappear from
  // the cached answer too, and there's no per-row signal for that.
  await query(
    'delete from campaign_company_engagement where campaign_id = $1 and range_start = $2 and range_end = $3',
    [campaignId, start, end]
  );
  if (companies.length) {
    await bulkInsert(
      'campaign_company_engagement',
      ['campaign_id', 'range_start', 'range_end', 'company_urn', 'company_name',
       'impressions', 'clicks', 'engagements', 'spend', 'reach', 'leads'],
      [campaignId, start, end],
      companies,
      c => [c.companyUrn, c.name, c.impressions, c.clicks, c.engagements, c.spend, c.reach, c.leads],
      ['campaign_id', 'range_start', 'range_end', 'company_urn']
    );
  }
  await writeMarker(campaignId, start, end, 'companies');
}

// ---- job function / job title ----

// The two facets share a table, told apart by `dimension`, and are read and written as one unit.
const DIMENSIONS = { jobFunctions: 'job_function', jobTitles: 'job_title' };

async function readBreakdown(campaignId, start, end) {
  const { rows } = await query(
    `select dimension, entity_urn, entity_name, impressions, clicks, engagements, spend, leads
       from campaign_audience_breakdown
      where campaign_id = $1 and range_start = $2 and range_end = $3
      order by impressions desc`,
    [campaignId, start, end]
  );
  const shape = r => ({
    urn: r.entity_urn,
    id: String(r.entity_urn || '').split(':').pop(),
    name: r.entity_name,
    impressions: Number(r.impressions) || 0,
    clicks: Number(r.clicks) || 0,
    engagements: Number(r.engagements) || 0,
    spend: Number(r.spend) || 0,
    leads: Number(r.leads) || 0
  });
  const out = {};
  for (const [key, dimension] of Object.entries(DIMENSIONS)) {
    out[key] = rows.filter(r => r.dimension === dimension).map(shape);
  }
  return out;
}

async function writeBreakdown(campaignId, start, end, breakdown) {
  await query(
    'delete from campaign_audience_breakdown where campaign_id = $1 and range_start = $2 and range_end = $3',
    [campaignId, start, end]
  );
  for (const [key, dimension] of Object.entries(DIMENSIONS)) {
    const rows = breakdown[key] || [];
    if (!rows.length) continue;
    await bulkInsert(
      'campaign_audience_breakdown',
      ['campaign_id', 'range_start', 'range_end', 'dimension', 'entity_urn', 'entity_name',
       'impressions', 'clicks', 'engagements', 'spend', 'leads'],
      [campaignId, start, end, dimension],
      rows,
      r => [r.urn, r.name, r.impressions, r.clicks, r.engagements, r.spend, r.leads],
      ['campaign_id', 'range_start', 'range_end', 'dimension', 'entity_urn']
    );
  }
  await writeMarker(campaignId, start, end, 'audience');
}

// ---- entry points ----

// Both follow the same shape: serve the cache while it's fresh, otherwise re-pull; and if LinkedIn
// is unreachable, serve a stale cached answer rather than an error — the panel saying "as of 4
// hours ago" beats it saying nothing. `refresh` forces a live call even when the cache is warm.
async function cachedFetch(campaignId, start, end, kind, opts, read, fetch, write) {
  const fetchedAt = await readMarker(campaignId, start, end, kind);
  if (!opts.refresh && isFresh(fetchedAt)) {
    return Object.assign(await read(), { cached: true, fetchedAt, stale: false });
  }
  try {
    const live = await fetch();
    await write(live);
    return Object.assign(live, {
      cached: false, fetchedAt: new Date().toISOString(), stale: false
    });
  } catch (e) {
    if (fetchedAt) {
      return Object.assign(await read(), { cached: true, fetchedAt, stale: true, error: e.message });
    }
    throw e;
  }
}

// Returns { companies, cached, fetchedAt, stale }.
async function companiesForCampaign(campaign, start, end, options) {
  return cachedFetch(
    campaign.id, start, end, 'companies', options || {},
    async () => ({ companies: await readCompanies(campaign.id, start, end) }),
    async () => ({
      companies: (await getCampaignCompanyEngagement(campaign, start, end)).slice(0, TOP_N)
    }),
    live => writeCompanies(campaign.id, start, end, live.companies)
  );
}

// Returns { jobFunctions, jobTitles, cached, fetchedAt, stale }.
async function audienceForCampaign(campaign, start, end, options) {
  return cachedFetch(
    campaign.id, start, end, 'audience', options || {},
    () => readBreakdown(campaign.id, start, end),
    async () => {
      const fresh = await getCampaignAudienceBreakdown(campaign, start, end);
      return {
        jobFunctions: fresh.jobFunctions.slice(0, TOP_N),
        jobTitles: fresh.jobTitles.slice(0, TOP_N)
      };
    },
    live => writeBreakdown(campaign.id, start, end, live)
  );
}

module.exports = { companiesForCampaign, audienceForCampaign, TTL_MINUTES, TOP_N };
