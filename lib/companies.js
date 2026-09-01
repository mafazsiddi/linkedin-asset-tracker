const { query } = require('./db');
const { getCampaignCompanyEngagement } = require('./linkedin');

// Read-through cache for "which companies have seen this ad set".
//
// This can't work like the other metrics. Spend/impressions are stored one row per campaign per
// day and summed over whatever window the UI asks for, but LinkedIn only serves demographic pivots
// (MEMBER_COMPANY among them) at timeGranularity=ALL — one aggregate for the whole range, with no
// per-day breakdown to store. So a stored row is only ever valid for the exact window it was
// fetched for, and the cache key has to include that window.
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
    `select company_urn, company_name, impressions, clicks, spend, reach, leads, fetched_at
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
          impressions, clicks, spend, reach, leads, fetched_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
       on conflict (campaign_id, range_start, range_end, company_urn)
       do update set company_name = $5, impressions = $6, clicks = $7, spend = $8,
                     reach = $9, leads = $10, fetched_at = now()`,
      [
        campaignId, start, end, c.companyUrn, c.name,
        c.impressions, c.clicks, c.spend, c.reach, c.leads
      ]
    );
  }
}

// Returns { companies, cached, fetchedAt, stale }. `refresh` forces a live call even when the
// cache is warm. On a LinkedIn failure a stale cached answer is served rather than an error —
// the panel saying "as of 4 hours ago" beats it saying nothing.
async function companiesForCampaign(campaign, start, end, options) {
  const opts = options || {};
  const cached = await readCache(campaign.id, start, end);
  if (!opts.refresh && isFresh(cached)) {
    return { companies: shape(cached), cached: true, fetchedAt: cached[0].fetched_at, stale: false };
  }

  try {
    const live = await getCampaignCompanyEngagement(campaign, start, end);
    const top = live.slice(0, TOP_N);
    await writeCache(campaign.id, start, end, top);
    return { companies: top, cached: false, fetchedAt: new Date().toISOString(), stale: false };
  } catch (e) {
    if (cached.length) {
      return {
        companies: shape(cached), cached: true, fetchedAt: cached[0].fetched_at,
        stale: true, error: e.message
      };
    }
    throw e;
  }
}

module.exports = { companiesForCampaign, TTL_MINUTES, TOP_N };
