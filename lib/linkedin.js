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

// Best-effort scaffold against LinkedIn's Marketing API (adAnalytics, pivot=CAMPAIGN). Untested
// against a real approved app — expect to adjust field names once real responses come back.
async function fetchLiveDailyStats(campaign, dateISO) {
  const token = await getStoredToken();
  if (!token || !token.access_token) {
    throw new Error('No LinkedIn access token stored. Visit /api/auth/linkedin/start first.');
  }
  if (!campaign.li_campaign_id) {
    throw new Error(`Campaign "${campaign.name}" has no LinkedIn campaign ID set.`);
  }
  const [y, m, d] = dateISO.split('-').map(Number);
  const url = new URL('https://api.linkedin.com/rest/adAnalytics');
  url.searchParams.set('q', 'analytics');
  url.searchParams.set('pivot', 'CAMPAIGN');
  url.searchParams.set('timeGranularity', 'DAILY');
  url.searchParams.set('dateRange.start.day', String(d));
  url.searchParams.set('dateRange.start.month', String(m));
  url.searchParams.set('dateRange.start.year', String(y));
  url.searchParams.set('dateRange.end.day', String(d));
  url.searchParams.set('dateRange.end.month', String(m));
  url.searchParams.set('dateRange.end.year', String(y));
  url.searchParams.set('campaigns[0]', `urn:li:sponsoredCampaign:${campaign.li_campaign_id}`);

  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      'LinkedIn-Version': '202401',
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
    leads: Number(row.oneClickLeads || row.leads || 0)
  };
}

async function getCampaignDailyStats(campaign, dateISO) {
  const mode = process.env.LINKEDIN_MODE || 'mock';
  if (mode === 'live') return fetchLiveDailyStats(campaign, dateISO);
  return mockDailyStats(campaign, dateISO);
}

module.exports = { getCampaignDailyStats, LINKEDIN_AD_ACCOUNT_URN };
