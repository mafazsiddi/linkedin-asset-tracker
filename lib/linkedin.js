// LinkedIn Ads client. LINKEDIN_MODE=mock (default) returns deterministic fake numbers so the
// full sync pipeline (cron -> upsert -> rollup -> frontend) can be built and tested before the
// Marketing Developer Platform app is approved. Flip LINKEDIN_MODE=live once it is, and set
// LINKEDIN_CLIENT_ID/SECRET + complete /api/auth/linkedin/start once per the README.

const { query } = require('./db');
const { eachDay, addDaysISO } = require('./util');

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
    leads: Number(row.oneClickLeads || 0),
    // `totalEngagements` is every interaction with the ad unit — clicks, reactions, comments,
    // shares, follows. Only requested by the demographic queries, so it reads 0 everywhere else.
    engagements: Number(row.totalEngagements || 0)
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

// LinkedIn's default page size is 10, so every call here sets its own.
const PAGE_SIZE = 100;
const MAX_PAGES = 100;

// The two endpoint families behave completely differently, and both fail *silently* when handled
// wrongly, so they get separate functions rather than a flag:
//
//   /adAccounts/{id}/creatives — cursor paged. Caps `count` at 100 regardless of what you ask for
//     and ignores `start` entirely. Continuation is `pageSize` + `pageToken`, with the next token
//     under `metadata.nextPageToken`.
//
//   adAnalytics — not paged at all. Honours a large `count` (a 20-creative × 31-day query returns
//     268 rows in one response), returns no `metadata`, and ignores `start` — asking for start=100
//     hands back the same rows as start=0. Paging it by offset would loop forever on duplicates.

// Cursor-paged finder. Used for creatives, where an un-paged call returned 102 of 235 ads — 18 of
// 22 campaigns looked like they had no ads at all, so their ads were never imported.
async function linkedInGetAllCursor(path, qs) {
  const out = [];
  let pageToken = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await linkedInGet(
      path,
      `${qs}&pageSize=${PAGE_SIZE}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`
    );
    out.push(...(data.elements || []));
    pageToken = data.metadata && data.metadata.nextPageToken;
    if (!pageToken) return out;
  }
  throw new Error(
    `Paging /${path} exceeded ${MAX_PAGES} pages (${out.length} elements). Refusing to return partial data.`
  );
}

// Single-shot finder for endpoints that can't be paged. Since there is no second page to fetch,
// the only defence against truncation is to notice it: a response that exactly fills the requested
// count is indistinguishable from one that was cut off, so treat it as an error rather than
// quietly under-reporting. Callers keep queries well under this by chunking dates and batching ids.
const SINGLE_PAGE_COUNT = 1000;

async function linkedInGetUnpaged(path, qs) {
  const data = await linkedInGet(path, `${qs}&count=${SINGLE_PAGE_COUNT}`);
  const elements = data.elements || [];
  if (elements.length >= SINGLE_PAGE_COUNT) {
    throw new Error(
      `/${path} returned ${elements.length} elements, filling the ${SINGLE_PAGE_COUNT}-row limit — ` +
      `the response was probably truncated and this endpoint cannot be paged. Narrow the date ` +
      `range or the id batch.`
    );
  }
  return elements;
}

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
    `&campaigns=List(${campaignUrn})&fields=${ANALYTICS_FIELDS}`;
  const elements = await linkedInGetUnpaged('adAnalytics', qs);
  const byDate = {};
  for (const row of elements) {
    const date = rowDateISO(row);
    if (date) byDate[date] = statsFromRow(row);
  }
  return byDate;
}

// Longest range that may be requested in one analytics call.
//
// LinkedIn stops returning `approximateMemberReach` once the requested range gets long — a 31-day
// query comes back with reach on every row, a 93-day query comes back with the same impressions
// and clicks but reach silently zeroed. Nothing in the response says so; the field is simply
// absent, and `Number(undefined || 0)` turns that into a confident 0. A full-history backfill
// therefore wiped reach from every row it wrote while looking like it had succeeded.
//
// Splitting into month-sized chunks keeps every request inside the range where LinkedIn answers
// in full. Chunks are per-day disjoint, so merging them can't double-count.
const MAX_RANGE_DAYS = 31;

function chunkRange(startISO, endISO) {
  const chunks = [];
  let cursor = startISO;
  while (cursor <= endISO) {
    const last = addDaysISO(cursor, MAX_RANGE_DAYS - 1);
    const chunkEnd = last > endISO ? endISO : last;
    chunks.push([cursor, chunkEnd]);
    cursor = addDaysISO(chunkEnd, 1);
  }
  return chunks;
}

// Returns { 'YYYY-MM-DD': stats } for every day in [startISO, endISO] that has data.
async function getCampaignDailyStatsRange(campaign, startISO, endISO) {
  if (!isLiveMode()) {
    const byDate = {};
    for (const date of eachDay(startISO, endISO)) byDate[date] = mockDailyStats(campaign, date);
    return byDate;
  }
  const byDate = {};
  for (const [lo, hi] of chunkRange(startISO, endISO)) {
    Object.assign(byDate, await fetchLiveDailyStatsRange(campaign, lo, hi));
  }
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
      `&creatives=List(${creativesParam})&fields=${ASSET_ANALYTICS_FIELDS}`;
    const elements = await linkedInGetUnpaged('adAnalytics', qs);
    for (const row of elements) {
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
// Chunked for the same reason the campaign-level fetch is — see MAX_RANGE_DAYS.
async function getAssetDailyStatsRange(assets, startISO, endISO) {
  const ids = assets.filter(a => a.li_creative_id).map(a => a.li_creative_id);
  if (!ids.length) return {};
  if (!isLiveMode()) {
    const results = {};
    for (const id of ids) {
      results[id] = {};
      for (const date of eachDay(startISO, endISO)) results[id][date] = mockCreativeDailyStats(id, date);
    }
    return results;
  }
  const results = {};
  for (const [lo, hi] of chunkRange(startISO, endISO)) {
    const part = await fetchLiveCreativeDailyStatsRange(ids, lo, hi);
    for (const [creativeId, byDate] of Object.entries(part)) {
      results[creativeId] = Object.assign(results[creativeId] || {}, byDate);
    }
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
    const elements = await linkedInGetAllCursor(
      `adAccounts/${AD_ACCOUNT_ID}/creatives`,
      `q=criteria&campaigns=List(${urns})`
    );
    for (const el of elements) {
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

// ---- Demographic breakdowns (who actually saw an ad set) ----

// LinkedIn's demographic pivots answer "who saw this". MEMBER_COMPANY is the one Campaign Manager's
// Companies report is built on; MEMBER_JOB_FUNCTION and MEMBER_JOB_TITLE are the same machinery
// pointed at a different facet. Three constraints shape everything below:
//
//   - They are only served at timeGranularity=ALL. Asking for DAILY returns a single undated
//     aggregate rather than one row per day, so there is no way to store this per-day and re-slice
//     it later — it is keyed by the exact (campaign, start, end) window it was fetched for.
//   - Only ONE demographic pivot per query. The analytics finder takes a single `pivot`, and the
//     statistics finder's `pivots` list (which does accept up to three) has no MEMBER_* values in
//     its enum at all. So job titles cannot be broken down *per company*: "which titles at Deloitte
//     saw this ad" is not a question the API can answer. Each facet is its own query and its own
//     ad-set-wide breakdown.
//   - Results are capped at the top 100 values per creative per day, values with fewer than 3
//     events are dropped entirely, and the data lags performance metrics by 12-24 hours.
const MEMBER_COMPANY_PIVOT = 'MEMBER_COMPANY';
const MEMBER_JOB_FUNCTION_PIVOT = 'MEMBER_JOB_FUNCTION';
const MEMBER_JOB_TITLE_PIVOT = 'MEMBER_JOB_TITLE';

// Everything the demographic pivots can report that this app shows. `totalEngagements` is what
// Campaign Manager calls paid engagements; `impressions`/`clicks` are paid by definition here,
// since adAnalytics only ever reports on sponsored delivery.
//
// `approximateMemberReach` is deliberately absent. LinkedIn documents it — along with the card and
// conversion-value metrics — as available on non-demographic pivots only, so it comes back missing
// on every MEMBER_ query and `Number(undefined || 0)` turns that into a confident 0. Requesting it
// bought nothing but a wasted slot against the 45M-metric-values throttle.
const DEMOGRAPHIC_ANALYTICS_FIELDS =
  'pivotValues,impressions,clicks,costInLocalCurrency,totalEngagements,oneClickLeads';

// Deterministic mock companies, so the panel can be built and demoed before the ads-reporting
// permission is live. Names are obviously fake on purpose — nobody should mistake these for real
// engagement data.
const MOCK_COMPANIES = [
  'Deloitte', 'ADNOC Group', 'SAP', 'Petroleum Development Oman', 'Emirates NBD',
  'Siemens Energy', 'Infosys', 'Majid Al Futtaim', 'Accenture', 'Tata Consultancy Services',
  'Etihad Airways', 'Nestlé', 'Bosch', 'Wipro', 'Aramex'
];

// LinkedIn's standardised job functions — the full list is only ~26 long, so a mock can be
// realistic rather than representative.
const MOCK_JOB_FUNCTIONS = [
  'Engineering', 'Operations', 'Information Technology', 'Sales', 'Finance', 'Business Development',
  'Quality Assurance', 'Purchasing', 'Program and Project Management', 'Consulting',
  'Human Resources', 'Marketing'
];

const MOCK_JOB_TITLES = [
  'Quality Manager', 'Operations Manager', 'HSE Manager', 'Project Manager', 'Compliance Officer',
  'Plant Manager', 'Chief Executive Officer', 'Head of Operations', 'Process Engineer',
  'Supply Chain Manager', 'Internal Auditor', 'Managing Director'
];

// One deterministic generator for all three facets, so the shapes can't drift apart.
function mockFacetRows(campaign, startISO, endISO, urnPrefix, names, idBase) {
  const base = seedFrom(String(campaign.li_campaign_id || campaign.id) + startISO + endISO + urnPrefix);
  return names.map((name, i) => {
    const seed = seedFrom(name + String(base));
    const impressions = 40 + (seed % 900);
    const clicks = Math.round(impressions * (0.004 + ((seed >>> 5) % 60) / 10000));
    return {
      urn: `${urnPrefix}${idBase + i}`,
      id: String(idBase + i),
      name,
      impressions,
      clicks,
      // Engagements are always at least the clicks — every click is an engagement — plus the
      // reactions/shares/follows that never made it to the landing page.
      engagements: clicks + Math.round(impressions * (((seed >>> 13) % 40) / 10000)),
      spend: Math.round(clicks * (30 + ((seed >>> 9) % 40)) * 100) / 100,
      reach: Math.round(impressions * 0.72),
      leads: Math.round(clicks * 0.05)
    };
  }).sort((a, b) => b.impressions - a.impressions);
}

// Companies keep `companyUrn`/`companyId` rather than the generic `urn`/`id`: the cache table and
// the panel were built against those names and there is nothing to gain from churning them.
function asCompany(row) {
  return {
    companyUrn: row.urn,
    companyId: row.id,
    name: row.name,
    impressions: row.impressions,
    clicks: row.clicks,
    engagements: row.engagements,
    spend: row.spend,
    reach: row.reach,
    leads: row.leads
  };
}

function mockCompanyEngagement(campaign, startISO, endISO) {
  return mockFacetRows(campaign, startISO, endISO, 'urn:li:organization:', MOCK_COMPANIES, 1000)
    .map(asCompany);
}

// A pivot value is a bare URN, so every demographic row needs a second call to become readable.
//
// adTargetingEntities is the primary lookup because it is the one the ads scopes cover and it takes
// mixed URN types in a single batch — the obvious per-type endpoints (/organizations for companies)
// need an organization-admin scope this app doesn't have. For the URN types LinkedIn documents a
// standardised-data endpoint for, anything adTargetingEntities left unresolved gets a second
// attempt there.
const STANDARDIZED_LOOKUP_PATH = { title: 'titles', function: 'functions' };

// Both endpoint families have been through enough response-shape changes that pinning this to one
// field would be brittle; take whichever is present.
function localizedName(el) {
  if (!el) return null;
  if (typeof el.name === 'string') return el.name;
  if (el.name && el.name.localized) {
    const values = Object.values(el.name.localized).filter(v => typeof v === 'string');
    if (values.length) return values[0];
  }
  if (el.defaultLocalizedName && el.defaultLocalizedName.value) return el.defaultLocalizedName.value;
  if (typeof el.localizedName === 'string') return el.localizedName;
  return null;
}

// Batches are independent lookups, so they go out together. A hundred companies is four batches;
// running them one after another added a round trip's latency each for no reason.
function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

async function resolveViaTargetingEntities(urns, out) {
  await Promise.all(chunk(urns, 30).map(async batch => {
    try {
      const data = await linkedInGet(
        'adTargetingEntities',
        `q=urns&urns=List(${batch.map(encodeURIComponent).join(',')})`
      );
      for (const el of data.elements || []) {
        const urn = el.urn || el.facetUrn || '';
        const name = localizedName(el);
        if (urn && name) out[urn] = name;
      }
    } catch (e) {
      // One unresolvable batch must not sink the whole report.
    }
  }));
}

// Batch-get on /titles and /functions. Restli hands these back keyed by id under `results`, but
// some standardised-data endpoints answer with `elements` instead, so both are read.
async function resolveViaStandardizedData(urns, out) {
  const byType = {};
  for (const urn of urns) {
    const parts = String(urn).split(':');
    const type = parts[2];
    if (!STANDARDIZED_LOOKUP_PATH[type]) continue;
    (byType[type] = byType[type] || []).push(urn);
  }
  const calls = [];
  for (const [type, list] of Object.entries(byType)) {
    for (const batch of chunk(list, 50)) {
      calls.push(async () => {
        const ids = batch.map(u => u.split(':').pop());
        try {
          const data = await linkedInGet(
            STANDARDIZED_LOOKUP_PATH[type],
            `ids=List(${ids.join(',')})&locale=(language:en,country:US)`
          );
          const found = data.results
            ? Object.entries(data.results).map(([id, el]) => [id, localizedName(el)])
            : (data.elements || []).map(el => [String(el.id), localizedName(el)]);
          for (const [id, name] of found) {
            if (name) out[`urn:li:${type}:${id}`] = name;
          }
        } catch (e) {
          // Best-effort, same as above.
        }
      });
    }
  }
  await Promise.all(calls.map(fn => fn()));
}

// Deliberately best-effort: a value whose name can't be resolved still shows up, labelled by its
// id, because knowing *how many* companies or titles engaged is useful even when one name is
// missing.
async function resolveFacetNames(urns) {
  const out = {};
  const unique = [...new Set(urns.filter(Boolean))];
  if (!unique.length) return out;
  await resolveViaTargetingEntities(unique, out);
  const unresolved = unique.filter(u => !out[u]);
  if (unresolved.length) await resolveViaStandardizedData(unresolved, out);
  return out;
}

// One demographic pivot, one query. Returns rows sorted by impressions, names resolved where
// possible.
async function fetchLiveDemographicPivot(campaign, pivot, startISO, endISO) {
  const campaignUrn = encodeURIComponent(`urn:li:sponsoredCampaign:${campaign.li_campaign_id}`);
  const qs =
    `q=analytics&pivot=${pivot}&timeGranularity=ALL` +
    `&dateRange=${dateRangeParam(startISO, endISO)}` +
    `&campaigns=List(${campaignUrn})&fields=${DEMOGRAPHIC_ANALYTICS_FIELDS}`;
  const elements = await linkedInGetUnpaged('adAnalytics', qs);

  const rows = [];
  for (const row of elements) {
    const urn = (row.pivotValues || [])[0] || '';
    if (!urn) continue;
    const stats = statsFromRow(row);
    rows.push({
      urn,
      id: urn.split(':').pop(),
      name: null,
      impressions: stats.impressions,
      clicks: stats.clicks,
      engagements: stats.engagements,
      spend: stats.spend,
      reach: stats.reach,
      leads: stats.leads
    });
  }
  const names = await resolveFacetNames(rows.map(r => r.urn));
  for (const r of rows) r.name = names[r.urn] || null;
  return rows.sort((a, b) => b.impressions - a.impressions);
}

// Returns the companies that saw a campaign's ads over [startISO, endISO], highest impressions
// first. Ordering matters: the account has hundreds of thousands of engaged companies overall, so
// callers store/show a top slice rather than the whole tail.
async function getCampaignCompanyEngagement(campaign, startISO, endISO) {
  if (!campaign.li_campaign_id) {
    throw new Error(`Campaign "${campaign.name}" has no LinkedIn campaign ID set.`);
  }
  if (!isLiveMode()) return mockCompanyEngagement(campaign, startISO, endISO);
  const rows = await fetchLiveDemographicPivot(campaign, MEMBER_COMPANY_PIVOT, startISO, endISO);
  return rows.map(asCompany);
}

// The job function and job title breakdowns that sit alongside the company list. Ad-set-wide, not
// per company — see the note on the pivot constants above for why that isn't optional.
//
// The two pivots run together. adAnalytics does throttle, but on metric values returned in a
// 5-minute window (45 million of them); a title pivot capped at 100 rows × 6 metrics is 600, so
// there is nothing here worth serialising for.
async function getCampaignAudienceBreakdown(campaign, startISO, endISO) {
  if (!campaign.li_campaign_id) {
    throw new Error(`Campaign "${campaign.name}" has no LinkedIn campaign ID set.`);
  }
  if (!isLiveMode()) {
    return {
      jobFunctions: mockFacetRows(campaign, startISO, endISO, 'urn:li:function:', MOCK_JOB_FUNCTIONS, 1),
      jobTitles: mockFacetRows(campaign, startISO, endISO, 'urn:li:title:', MOCK_JOB_TITLES, 100)
    };
  }
  const [jobFunctions, jobTitles] = await Promise.all([
    fetchLiveDemographicPivot(campaign, MEMBER_JOB_FUNCTION_PIVOT, startISO, endISO),
    fetchLiveDemographicPivot(campaign, MEMBER_JOB_TITLE_PIVOT, startISO, endISO)
  ]);
  return { jobFunctions, jobTitles };
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
        servingStatus: i % 3 === 0 ? 'RUNNABLE' : 'CAMPAIGN_GROUP_STATUS_HOLD',
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
    // The search finder validates id values as URNs — passing bare numeric ids is rejected with
    // "Invalid Urn format. Invalid prefix." even though the campaign resource itself is keyed by a
    // plain Long.
    const values = batch
      .map(c => encodeURIComponent(`urn:li:sponsoredCampaign:${c.li_campaign_id}`))
      .join(',');
    const elements = await linkedInGetUnpaged(
      `adAccounts/${AD_ACCOUNT_ID}/adCampaigns`,
      `q=search&search=(id:(values:List(${values})))`
    );
    for (const el of elements) {
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

// The one place that decides whether this process is talking to LinkedIn or to the generator.
// Everything else asks here rather than re-reading the env var, so "am I live?" can't be answered
// differently in two places.
function isLiveMode() {
  return (process.env.LINKEDIN_MODE || 'mock') === 'live';
}

module.exports = {
  getCampaignDailyStats,
  getCampaignDailyStatsRange,
  isLiveMode,
  // Exported so the sync can tag generated rows, and so a row already in the database can be
  // tested against what the generator would have produced for that campaign/day — that is how
  // mock data written into production gets identified and removed.
  mockDailyStats,
  mockCreativeDailyStats,
  getAssetDailyStatsBatch,
  getAssetDailyStatsRange,
  listCampaignCreatives,
  listCreativesForCampaigns,
  fetchCampaignMetadata,
  getCampaignCompanyEngagement,
  getCampaignAudienceBreakdown,
  getStoredToken,
  LINKEDIN_AD_ACCOUNT_URN,
  AD_ACCOUNT_ID
};
