// LinkedIn Ads client. LINKEDIN_MODE=mock (default) returns deterministic fake numbers so the
// full sync pipeline (cron -> upsert -> rollup -> frontend) can be built and tested before the
// Marketing Developer Platform app is approved. Flip LINKEDIN_MODE=live once it is, and set
// LINKEDIN_CLIENT_ID/SECRET + complete /api/auth/linkedin/start once per the README.

const { query } = require('./db');

const LINKEDIN_AD_ACCOUNT_URN = process.env.LINKEDIN_AD_ACCOUNT_URN || 'urn:li:sponsoredAccount:509493016';

function seedFrom(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}

// Deterministic per (campaign, day) so re-running the sync for the same day is idempotent.
function mockDailyStats(campaign, dateISO) {
  const seed = seedFrom(String(campaign.li_campaign_id || campaign.id) + dateISO);
  const impressions = 800 + (seed % 4000);
  const clicks = Math.round(impressions * (0.006 + ((seed >> 3) % 100) / 10000));
  const spend = Math.round(clicks * (35 + ((seed >> 7) % 40)) * 100) / 100;
  const reach = Math.round(impressions * (0.7 + ((seed >> 11) % 20) / 100));
  const leads = Math.round(clicks * (0.03 + ((seed >> 13) % 50) / 5000));
  return { spend, impressions, clicks, reach, leads };
}

async function getStoredToken() {
  const { rows } = await query('select * from linkedin_tokens order by updated_at desc limit 1');
  return rows[0] || null;
}

// LinkedIn-Version headers only stay active for ~15 months, so this needs bumping periodically —
// see https://learn.microsoft.com/en-us/linkedin/marketing/versioning.
const LINKEDIN_API_VERSION = '202607';

const ANALYTICS_FIELDS = 'impressions,clicks,costInLocalCurrency,approximateMemberReach,oneClickLeads';

// Calls LinkedIn's versioned Ad Analytics API (adAnalytics, pivot=CAMPAIGN). The /rest/ API requires
// Rest.li 2.0 structured query params (parens, not dot-notation) — plain URLSearchParams.set() with
// dotted keys like "dateRange.start.day" gets rejected with QUERY_PARAM_NOT_ALLOWED.
async function fetchLiveDailyStats(campaign, dateISO) {
  const token = await getStoredToken();
  if (!token || !token.access_token) {
    throw new Error('No LinkedIn access token stored. Visit /api/auth/linkedin/start first.');
  }
  if (!campaign.li_campaign_id) {
    throw new Error(`Campaign "${campaign.name}" has no LinkedIn campaign ID set.`);
  }
  const [y, m, d] = dateISO.split('-').map(Number);
  const dateRange = `(start:(year:${y},month:${m},day:${d}),end:(year:${y},month:${m},day:${d}))`;
  const campaignUrn = encodeURIComponent(`urn:li:sponsoredCampaign:${campaign.li_campaign_id}`);
  const qs =
    `q=analytics&pivot=CAMPAIGN&timeGranularity=DAILY&dateRange=${dateRange}` +
    `&campaigns=List(${campaignUrn})&fields=${ANALYTICS_FIELDS}`;

  const resp = await fetch(`https://api.linkedin.com/rest/adAnalytics?${qs}`, {
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      'LinkedIn-Version': LINKEDIN_API_VERSION,
      'X-Restli-Protocol-Version': '2.0.0'
    }
  });
  if (!resp.ok) {
    throw new Error(`LinkedIn API error ${resp.status}: ${await resp.text()}`);
  }
  const data = await resp.json();
  const row = (data.elements || [])[0] || {};
  return {
    spend: Number(row.costInLocalCurrency || 0),
    impressions: Number(row.impressions || 0),
    clicks: Number(row.clicks || 0),
    reach: Number(row.approximateMemberReach || 0),
    leads: Number(row.oneClickLeads || 0)
  };
}

async function getCampaignDailyStats(campaign, dateISO) {
  const mode = process.env.LINKEDIN_MODE || 'mock';
  if (mode === 'live') return fetchLiveDailyStats(campaign, dateISO);
  return mockDailyStats(campaign, dateISO);
}

const ASSET_ANALYTICS_FIELDS = 'impressions,clicks,costInLocalCurrency,approximateMemberReach,oneClickLeads,dateRange,pivotValues';

// Deterministic mock, same shape as mockDailyStats but keyed by creative rather than campaign —
// several creatives can share a campaign, so this needs its own seed to vary per asset.
function mockCreativeDailyStats(creativeId, dateISO) {
  const seed = seedFrom(String(creativeId) + dateISO + ':creative');
  const impressions = 200 + (seed % 2000);
  const clicks = Math.round(impressions * (0.005 + ((seed >> 3) % 100) / 12000));
  const spend = Math.round(clicks * (30 + ((seed >> 7) % 35)) * 100) / 100;
  const reach = Math.round(impressions * (0.65 + ((seed >> 11) % 25) / 100));
  const leads = Math.round(clicks * (0.02 + ((seed >> 13) % 40) / 5000));
  return { spend, impressions, clicks, reach, leads };
}

// Each asset is one LinkedIn ad (creative). pivot=CREATIVE gives per-ad numbers, unlike
// pivot=CAMPAIGN which only rolls up to the whole campaign several assets can share. Batched
// (up to 20 creative URNs per call) since a market can have dozens of assets.
async function fetchLiveCreativeDailyStatsBatch(creativeIds, dateISO) {
  const token = await getStoredToken();
  if (!token || !token.access_token) {
    throw new Error('No LinkedIn access token stored. Visit /api/auth/linkedin/start first.');
  }
  const [y, m, d] = dateISO.split('-').map(Number);
  const dateRange = `(start:(year:${y},month:${m},day:${d}),end:(year:${y},month:${m},day:${d}))`;
  const results = {};
  const BATCH = 20;
  for (let i = 0; i < creativeIds.length; i += BATCH) {
    const batch = creativeIds.slice(i, i + BATCH);
    const creativesParam = batch.map(id => encodeURIComponent(`urn:li:sponsoredCreative:${id}`)).join(',');
    const qs =
      `q=analytics&pivot=CREATIVE&timeGranularity=DAILY&dateRange=${dateRange}` +
      `&creatives=List(${creativesParam})&fields=${ASSET_ANALYTICS_FIELDS}&count=1000`;
    const resp = await fetch(`https://api.linkedin.com/rest/adAnalytics?${qs}`, {
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        'LinkedIn-Version': LINKEDIN_API_VERSION,
        'X-Restli-Protocol-Version': '2.0.0'
      }
    });
    if (!resp.ok) {
      throw new Error(`LinkedIn API error ${resp.status}: ${await resp.text()}`);
    }
    const data = await resp.json();
    for (const row of data.elements || []) {
      const urn = (row.pivotValues || [])[0] || '';
      const creativeId = urn.split(':').pop();
      if (!creativeId) continue;
      results[creativeId] = {
        spend: Number(row.costInLocalCurrency || 0),
        impressions: Number(row.impressions || 0),
        clicks: Number(row.clicks || 0),
        reach: Number(row.approximateMemberReach || 0),
        leads: Number(row.oneClickLeads || 0)
      };
    }
  }
  return results;
}

// Returns a map of li_creative_id -> stats for every asset that has one.
async function getAssetDailyStatsBatch(assets, dateISO) {
  const mode = process.env.LINKEDIN_MODE || 'mock';
  const withCreative = assets.filter(a => a.li_creative_id);
  if (mode === 'live') return fetchLiveCreativeDailyStatsBatch(withCreative.map(a => a.li_creative_id), dateISO);
  const results = {};
  withCreative.forEach(a => { results[a.li_creative_id] = mockCreativeDailyStats(a.li_creative_id, dateISO); });
  return results;
}

module.exports = { getCampaignDailyStats, getAssetDailyStatsBatch, LINKEDIN_AD_ACCOUNT_URN };
