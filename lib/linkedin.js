// LinkedIn Ads client. LINKEDIN_MODE=mock (default) returns deterministic fake numbers so the
// full sync pipeline (cron -> upsert -> rollup -> frontend) can be built and tested before the
// Marketing Developer Platform app is approved. Flip LINKEDIN_MODE=live once it is, and set
// LINKEDIN_CLIENT_ID/SECRET + complete /api/auth/linkedin/start once per the README.

const { query } = require('./db');
const { eachDay } = require('./util');

const LINKEDIN_AD_ACCOUNT_URN = process.env.LINKEDIN_AD_ACCOUNT_URN || 'urn:li:sponsoredAccount:509493016';

// Creative endpoints are no longer addressable at /rest/creatives — LinkedIn requires the
// advertiser account in the path (/rest/adAccounts/{id}/creatives) and rejects the old form with
// a 400. Everything creative-related needs the bare numeric account id, not the URN.
const AD_ACCOUNT_ID = String(LINKEDIN_AD_ACCOUNT_URN).split(':').pop();

function seedFrom(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}

// Deterministic per (campaign, day) so re-running the sync for the same day is idempotent.
//
// Every shift here must be `>>>`, not `>>`. seedFrom returns an unsigned 32-bit value, but `>>`
// coerces to a *signed* int32 first, so any seed above 2^31 made `(seed >> 3) % 100` negative —
// which drove clicks, spend and leads negative, and the read-side greatest(sum, 0) clamp then
// flattened whole months to zero.
function mockDailyStats(campaign, dateISO) {
  const seed = seedFrom(String(campaign.li_campaign_id || campaign.id) + dateISO);
  const impressions = 800 + (seed % 4000);
  const clicks = Math.round(impressions * (0.006 + ((seed >>> 3) % 100) / 10000));
  const spend = Math.round(clicks * (35 + ((seed >>> 7) % 40)) * 100) / 100;
  const reach = Math.round(impressions * (0.7 + ((seed >>> 11) % 20) / 100));
  const leads = Math.round(clicks * (0.03 + ((seed >>> 13) % 50) / 5000));
  return { spend, impressions, clicks, reach, leads };
}

async function getStoredToken() {
  const { rows } = await query('select * from linkedin_tokens order by updated_at desc limit 1');
  return rows[0] || null;
}

// Every live call needs a token; failing here with a vague message was making every downstream
// symptom look like "LinkedIn returned nothing" rather than "nobody has authorised the app".
async function requireToken() {
  const token = await getStoredToken();
  if (!token || !token.access_token) {
    throw new Error('No LinkedIn access token stored. Visit /api/auth/linkedin/start to authorise the app.');
  }
  if (token.expires_at && new Date(token.expires_at).getTime() < Date.now()) {
    throw new Error(
      `The stored LinkedIn access token expired on ${new Date(token.expires_at).toISOString().slice(0, 10)}. ` +
      'Visit /api/auth/linkedin/start to reconnect.'
    );
  }
  return token;
}

function dateRangeParam(startISO, endISO) {
  const [sy, sm, sd] = startISO.split('-').map(Number);
  const [ey, em, ed] = endISO.split('-').map(Number);
  return `(start:(year:${sy},month:${sm},day:${sd}),end:(year:${ey},month:${em},day:${ed}))`;
}

// LinkedIn returns each DAILY element tagged with its own dateRange; its start is the day the row
// describes. Without requesting `dateRange` in `fields` every row comes back indistinguishable,
// which is why range queries have to ask for it explicitly.
function rowDateISO(row) {
  const s = row && row.dateRange && row.dateRange.start;
  if (!s || !s.year || !s.month || !s.day) return null;
  return `${s.year}-${String(s.month).padStart(2, '0')}-${String(s.day).padStart(2, '0')}`;
}

function statsFromRow(row) {
  return {
    spend: Number(row.costInLocalCurrency || 0),
    impressions: Number(row.impressions || 0),
    clicks: Number(row.clicks || 0),
    reach: Number(row.approximateMemberReach || 0),
    leads: Number(row.oneClickLeads || 0)
  };
}

async function linkedInGet(path, qs) {
  const token = await requireToken();
  const resp = await fetch(`https://api.linkedin.com/rest/${path}?${qs}`, {
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      'LinkedIn-Version': LINKEDIN_API_VERSION,
      'X-Restli-Protocol-Version': '2.0.0'
    }
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`LinkedIn API error ${resp.status} on /${path}: ${body.slice(0, 500)}`);
  }
  return resp.json();
}

// LinkedIn-Version headers only stay active for ~15 months, so this needs bumping periodically —
// see https://learn.microsoft.com/en-us/linkedin/marketing/versioning.
const LINKEDIN_API_VERSION = '202607';

// `dateRange` has to be in the field list for range queries — see rowDateISO.
const ANALYTICS_FIELDS = 'dateRange,impressions,clicks,costInLocalCurrency,approximateMemberReach,oneClickLeads';

// LinkedIn's default page size is 10. A month-long DAILY query silently returned only the first
// 10 days without this, which is a large part of why month-to-date totals never matched Campaign
// Manager.
const PAGE_SIZE = 1000;

// Calls LinkedIn's versioned Ad Analytics API (adAnalytics, pivot=CAMPAIGN) for a whole date range
// in one request, returning { 'YYYY-MM-DD': stats }. The /rest/ API requires Rest.li 2.0 structured
// query params (parens, not dot-notation) — plain URLSearchParams.set() with dotted keys like
// "dateRange.start.day" gets rejected with QUERY_PARAM_NOT_ALLOWED.
async function fetchLiveDailyStatsRange(campaign, startISO, endISO) {
  if (!campaign.li_campaign_id) {
    throw new Error(`Campaign "${campaign.name}" has no LinkedIn campaign ID set.`);
  }
  const campaignUrn = encodeURIComponent(`urn:li:sponsoredCampaign:${campaign.li_campaign_id}`);
  const qs =
    `q=analytics&pivot=CAMPAIGN&timeGranularity=DAILY` +
    `&dateRange=${dateRangeParam(startISO, endISO)}` +
    `&campaigns=List(${campaignUrn})&fields=${ANALYTICS_FIELDS}&count=${PAGE_SIZE}`;
  const data = await linkedInGet('adAnalytics', qs);
  const byDate = {};
  for (const row of data.elements || []) {
    const date = rowDateISO(row);
    if (date) byDate[date] = statsFromRow(row);
  }
  return byDate;
}

// Returns { 'YYYY-MM-DD': stats } for every day in [startISO, endISO] that has data.
async function getCampaignDailyStatsRange(campaign, startISO, endISO) {
  const mode = process.env.LINKEDIN_MODE || 'mock';
  if (mode === 'live') return fetchLiveDailyStatsRange(campaign, startISO, endISO);
  const byDate = {};
  for (const date of eachDay(startISO, endISO)) byDate[date] = mockDailyStats(campaign, date);
  return byDate;
}

async function getCampaignDailyStats(campaign, dateISO) {
  const byDate = await getCampaignDailyStatsRange(campaign, dateISO, dateISO);
  return byDate[dateISO] || { spend: 0, impressions: 0, clicks: 0, reach: 0, leads: 0 };
}

const ASSET_ANALYTICS_FIELDS = 'impressions,clicks,costInLocalCurrency,approximateMemberReach,oneClickLeads,dateRange,pivotValues';

// Deterministic mock, same shape as mockDailyStats but keyed by creative rather than campaign —
// several creatives can share a campaign, so this needs its own seed to vary per asset.
function mockCreativeDailyStats(creativeId, dateISO) {
  const seed = seedFrom(String(creativeId) + dateISO + ':creative');
  const impressions = 200 + (seed % 2000);
  const clicks = Math.round(impressions * (0.005 + ((seed >>> 3) % 100) / 12000));
  const spend = Math.round(clicks * (30 + ((seed >>> 7) % 35)) * 100) / 100;
  const reach = Math.round(impressions * (0.65 + ((seed >>> 11) % 25) / 100));
  const leads = Math.round(clicks * (0.02 + ((seed >>> 13) % 40) / 5000));
  return { spend, impressions, clicks, reach, leads };
}

// Each asset is one LinkedIn ad (creative). pivot=CREATIVE gives per-ad numbers, unlike
// pivot=CAMPAIGN which only rolls up to the whole campaign several assets can share. Batched
// (up to 20 creative URNs per call) since a market can have dozens of assets. Returns
// { creativeId: { 'YYYY-MM-DD': stats } }.
async function fetchLiveCreativeDailyStatsRange(creativeIds, startISO, endISO) {
  const results = {};
  const BATCH = 20;
  for (let i = 0; i < creativeIds.length; i += BATCH) {
    const batch = creativeIds.slice(i, i + BATCH);
    const creativesParam = batch.map(id => encodeURIComponent(`urn:li:sponsoredCreative:${id}`)).join(',');
    const qs =
      `q=analytics&pivot=CREATIVE&timeGranularity=DAILY` +
      `&dateRange=${dateRangeParam(startISO, endISO)}` +
      `&creatives=List(${creativesParam})&fields=${ASSET_ANALYTICS_FIELDS}&count=${PAGE_SIZE}`;
    const data = await linkedInGet('adAnalytics', qs);
    for (const row of data.elements || []) {
      const urn = (row.pivotValues || [])[0] || '';
      const creativeId = urn.split(':').pop();
      const date = rowDateISO(row);
      if (!creativeId || !date) continue;
      if (!results[creativeId]) results[creativeId] = {};
      results[creativeId][date] = statsFromRow(row);
    }
  }
  return results;
}

// Returns { li_creative_id: { 'YYYY-MM-DD': stats } } for every asset that has a creative ID.
async function getAssetDailyStatsRange(assets, startISO, endISO) {
  const mode = process.env.LINKEDIN_MODE || 'mock';
  const ids = assets.filter(a => a.li_creative_id).map(a => a.li_creative_id);
  if (!ids.length) return {};
  if (mode === 'live') return fetchLiveCreativeDailyStatsRange(ids, startISO, endISO);
  const results = {};
  for (const id of ids) {
    results[id] = {};
    for (const date of eachDay(startISO, endISO)) results[id][date] = mockCreativeDailyStats(id, date);
  }
  return results;
}

async function getAssetDailyStatsBatch(assets, dateISO) {
  const byCreative = await getAssetDailyStatsRange(assets, dateISO, dateISO);
  const flat = {};
  for (const [id, byDate] of Object.entries(byCreative)) {
    if (byDate[dateISO]) flat[id] = byDate[dateISO];
  }
  return flat;
}

// A creative's `content` is a single-key object naming the ad format, e.g. {documentAd: {...}} or
// {videoAd: {...}}. Mapped onto the app's own asset types so imported ads slot into the existing
// Type dropdown instead of arriving as a raw LinkedIn enum.
const CONTENT_TYPE_MAP = {
  documentAd: 'Document',
  videoAd: 'Video',
  textAd: 'Text',
  spotlightAd: 'Image',
  followCompanyAd: 'Image',
  jobsAd: 'Image',
  carouselAd: 'Carousel',
  eventAd: 'Image',
  singleImageAd: 'Image'
};

function creativeTypeFrom(content) {
  if (!content || typeof content !== 'object') return 'Image';
  const key = Object.keys(content)[0];
  return CONTENT_TYPE_MAP[key] || 'Image';
}

function normaliseCreative(el) {
  const id = String(el.id || '').split(':').pop();
  const campaignId = String(el.campaign || '').split(':').pop();
  const content = el.content || {};
  const inner = content[Object.keys(content)[0]] || {};
  return {
    creativeId: id,
    campaignId,
    // Creatives DO carry a human ad name — this is the label shown in Campaign Manager.
    name: el.name || `Ad ${id}`,
    type: creativeTypeFrom(content),
    status: el.intendedStatus || null,
    isServing: Boolean(el.isServing),
    servingHoldReasons: el.servingHoldReasons || [],
    reviewStatus: (el.review && el.review.status) || null,
    reference: inner.reference || null,
    createdAt: el.createdAt || null
  };
}

// Lists the ads (creatives) attached to one or more campaigns.
//
// Note the path: /rest/creatives was retired and now 400s with "All api calls to creative
// endpoints have been modified to include advertiser account id in the url path" — it must be
// /rest/adAccounts/{adAccountId}/creatives.
async function listCreativesForCampaigns(campaigns) {
  const withId = campaigns.filter(c => c.li_campaign_id);
  if (!withId.length) return [];
  const mode = process.env.LINKEDIN_MODE || 'mock';
  if (mode !== 'live') {
    // Mock mode has no real creatives to enumerate; deterministic stand-ins keep this testable.
    return withId.flatMap(c => [0, 1].map(i => ({
      creativeId: `${c.li_campaign_id}00${i}`,
      campaignId: String(c.li_campaign_id),
      name: `${c.name} — ad ${i + 1}`,
      type: 'Image',
      status: i === 0 ? 'ACTIVE' : 'PAUSED',
      isServing: i === 0,
      servingHoldReasons: [],
      reviewStatus: 'APPROVED',
      reference: null,
      createdAt: null
    })));
  }
  const out = [];
  const BATCH = 20;
  for (let i = 0; i < withId.length; i += BATCH) {
    const batch = withId.slice(i, i + BATCH);
    const urns = batch
      .map(c => encodeURIComponent(`urn:li:sponsoredCampaign:${c.li_campaign_id}`))
      .join(',');
    const data = await linkedInGet(
      `adAccounts/${AD_ACCOUNT_ID}/creatives`,
      `q=criteria&campaigns=List(${urns})&count=${PAGE_SIZE}`
    );
    for (const el of data.elements || []) {
      const c = normaliseCreative(el);
      if (c.creativeId) out.push(c);
    }
  }
  return out;
}

async function listCampaignCreatives(campaign) {
  if (!campaign.li_campaign_id) {
    throw new Error(`Campaign "${campaign.name}" has no LinkedIn campaign ID set.`);
  }
  return listCreativesForCampaigns([campaign]);
}

function epochToDateISO(ms) {
  if (!ms) return null;
  return new Date(Number(ms)).toISOString().slice(0, 10);
}

// Fetches campaign metadata (status, objective, budget, schedule) for the given campaigns. This is
// what makes "only show live campaigns" possible — the app previously stored nothing but a name
// and an ID, so it had no way to tell an active campaign from one archived months ago.
//
// Same path caveat as creatives: campaign endpoints require the advertiser account in the path.
async function fetchCampaignMetadata(campaigns) {
  const withId = campaigns.filter(c => c.li_campaign_id);
  if (!withId.length) return {};
  const mode = process.env.LINKEDIN_MODE || 'mock';
  if (mode !== 'live') {
    const out = {};
    withId.forEach((c, i) => {
      out[String(c.li_campaign_id)] = {
        status: i % 3 === 0 ? 'ACTIVE' : 'PAUSED',
        servingStatus: i % 3 === 0 ? 'RUNNING' : 'STOPPED',
        objective: 'LEAD_GENERATION', format: 'SPONSORED_UPDATE_NATIVE_DOCUMENT',
        costType: 'CPM', dailyBudget: 5000, budgetCurrency: 'INR',
        runStart: '2026-06-01', runEnd: null
      };
    });
    return out;
  }

  const out = {};
  const BATCH = 20;
  for (let i = 0; i < withId.length; i += BATCH) {
    const batch = withId.slice(i, i + BATCH);
    const values = batch.map(c => c.li_campaign_id).join(',');
    const data = await linkedInGet(
      `adAccounts/${AD_ACCOUNT_ID}/adCampaigns`,
      `q=search&search=(id:(values:List(${values})))&count=${PAGE_SIZE}`
    );
    for (const el of data.elements || []) {
      const id = String(el.id);
      out[id] = {
        status: el.status || null,
        // servingStatuses is an array; RUNNING is the only one that means "actually delivering".
        servingStatus: Array.isArray(el.servingStatuses) ? el.servingStatuses[0] || null : null,
        objective: el.objectiveType || null,
        format: el.format || null,
        costType: el.costType || null,
        dailyBudget: el.dailyBudget ? Number(el.dailyBudget.amount) : null,
        budgetCurrency: el.dailyBudget ? el.dailyBudget.currencyCode : null,
        runStart: epochToDateISO(el.runSchedule && el.runSchedule.start),
        runEnd: epochToDateISO(el.runSchedule && el.runSchedule.end),
        name: el.name || null
      };
    }
  }
  return out;
}

module.exports = {
  getCampaignDailyStats,
  getCampaignDailyStatsRange,
  getAssetDailyStatsBatch,
  getAssetDailyStatsRange,
  listCampaignCreatives,
  listCreativesForCampaigns,
  fetchCampaignMetadata,
  getStoredToken,
  LINKEDIN_AD_ACCOUNT_URN,
  AD_ACCOUNT_ID
};
