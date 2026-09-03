const { query } = require('./db');
const { getCampaignCompanyEngagement, getCampaignAudienceBreakdown } = require('./linkedin');

// Read-through cache for "who has seen this ad set" — the company list, plus the job function and
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

// How long a cached window stays fresh. Matches the 2-hourly sync cadence, so the panel is never
// staler than the numbers next to it.
const TTL_MINUTES = Number(process.env.COMPANY_CACHE_TTL_MINUTES || 120);

// LinkedIn returns the long tail; the panel shows the companies that actually engaged. Anything
// past this is noise with a single impression against it.
const TOP_N = Number(process.env.COMPANY_TOP_N || 100);

async function readCache(campaignId, start, end) {
  const { rows } = await query(
    `select company_urn, company_name, impressions, clicks, engagements, spend, reach, leads,
            fetched_at
       from campaign_company_engagement
      where campaign_id = $1 and range_start = $2 and range_end = $3
      order by impressions desc`,
    [campaignId, start, end]
  );
  return rows;
}

function isFresh(rows) {
  if (!rows.length) return false;
  const fetchedAt = new Date(rows[0].fetched_at).getTime();
  return Date.now() - fetchedAt < TTL_MINUTES * 60 * 1000;
}

function shape(rows) {
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

async function writeCache(campaignId, start, end, companies) {
  // Replace rather than upsert: a company that stopped appearing in the window must disappear from
  // the cached answer too, and there's no per-row signal for that.
  await query(
    'delete from campaign_company_engagement where campaign_id = $1 and range_start = $2 and range_end = $3',
    [campaignId, start, end]
  );
  for (const c of companies) {
    await query(
      `insert into campaign_company_engagement
         (campaign_id, range_start, range_end, company_urn, company_name,
          impressions, clicks, engagements, spend, reach, leads, fetched_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
       on conflict (campaign_id, range_start, range_end, company_urn)
       do update set company_name = $5, impressions = $6, clicks = $7, engagements = $8,
                     spend = $9, reach = $10, leads = $11, fetched_at = now()`,
      [
        campaignId, start, end, c.companyUrn, c.name,
        c.impressions, c.clicks, c.engagements, c.spend, c.reach, c.leads
      ]
    );
  }
}

// ---- job function / job title breakdowns ----

// The two facets share a table, told apart by `dimension`, and are keyed by the same window as the
// company list so they can be written and read as one unit.
const DIMENSIONS = { jobFunctions: 'job_function', jobTitles: 'job_title' };

function shapeFacet(rows) {
  return rows.map(r => ({
    urn: r.entity_urn,
    id: String(r.entity_urn || '').split(':').pop(),
    name: r.entity_name,
    impressions: Number(r.impressions) || 0,
    clicks: Number(r.clicks) || 0,
    engagements: Number(r.engagements) || 0,
    spend: Number(r.spend) || 0,
    leads: Number(r.leads) || 0
  }));
}

async function readBreakdown(campaignId, start, end) {
  const { rows } = await query(
    `select dimension, entity_urn, entity_name, impressions, clicks, engagements, spend, leads
       from campaign_audience_breakdown
      where campaign_id = $1 and range_start = $2 and range_end = $3
      order by impressions desc`,
    [campaignId, start, end]
  );
  const out = { jobFunctions: [], jobTitles: [] };
  for (const [key, dimension] of Object.entries(DIMENSIONS)) {
    out[key] = shapeFacet(rows.filter(r => r.dimension === dimension));
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
    // One multi-row insert per facet. The company loop above pays a round trip per company because
    // it predates this; there's no reason to repeat that for up to a hundred more titles.
    const params = [campaignId, start, end, dimension];
    const values = rows.map((r, i) => {
      const n = params.length;
      params.push(r.urn, r.name, r.impressions, r.clicks, r.engagements, r.spend, r.leads);
      return `($1,$2,$3,$4,$${n + 1},$${n + 2},$${n + 3},$${n + 4},$${n + 5},$${n + 6},$${n + 7}, now())`;
    });
    await query(
      `insert into campaign_audience_breakdown
         (campaign_id, range_start, range_end, dimension, entity_urn, entity_name,
          impressions, clicks, engagements, spend, leads, fetched_at)
       values ${values.join(',')}
       on conflict (campaign_id, range_start, range_end, dimension, entity_urn)
       do update set entity_name = excluded.entity_name, impressions = excluded.impressions,
                     clicks = excluded.clicks, engagements = excluded.engagements,
                     spend = excluded.spend, leads = excluded.leads, fetched_at = now()`,
      params
    );
  }
}

// Returns { companies, jobFunctions, jobTitles, cached, fetchedAt, stale }. `refresh` forces a live
// call even when the cache is warm. On a LinkedIn failure a stale cached answer is served rather
// than an error — the panel saying "as of 4 hours ago" beats it saying nothing.
async function companiesForCampaign(campaign, start, end, options) {
  const opts = options || {};
  const cached = await readCache(campaign.id, start, end);
  const cachedBreakdown = await readBreakdown(campaign.id, start, end);
  if (!opts.refresh && isFresh(cached)) {
    return Object.assign(
      { companies: shape(cached), cached: true, fetchedAt: cached[0].fetched_at, stale: false },
      cachedBreakdown
    );
  }

  try {
    const live = await getCampaignCompanyEngagement(campaign, start, end);
    const top = live.slice(0, TOP_N);

    // Job function and title are two more queries against the same throttled endpoint, and they
    // answer a softer question than the company list does. Losing them must not cost the caller
    // the companies it actually asked for, so a failure here falls back to whatever was cached.
    let breakdown = cachedBreakdown;
    let breakdownError = null;
    try {
      const fresh = await getCampaignAudienceBreakdown(campaign, start, end);
      breakdown = {
        jobFunctions: fresh.jobFunctions.slice(0, TOP_N),
        jobTitles: fresh.jobTitles.slice(0, TOP_N)
      };
      await writeBreakdown(campaign.id, start, end, breakdown);
    } catch (e) {
      breakdownError = e.message;
    }

    await writeCache(campaign.id, start, end, top);
    return Object.assign(
      {
        companies: top, cached: false, fetchedAt: new Date().toISOString(), stale: false,
        breakdownError
      },
      breakdown
    );
  } catch (e) {
    if (cached.length) {
      return Object.assign(
        {
          companies: shape(cached), cached: true, fetchedAt: cached[0].fetched_at,
          stale: true, error: e.message
        },
        cachedBreakdown
      );
    }
    throw e;
  }
}

module.exports = { companiesForCampaign, TTL_MINUTES, TOP_N };
