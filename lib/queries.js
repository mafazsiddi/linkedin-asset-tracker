// The asset/campaign SELECTs live here because they were previously copy-pasted between
// `index.js` and `[id].js` in both resources, and had already drifted apart — the list views
// clamped negative totals to zero while the single-row views returned raw sums, so the same asset
// showed different numbers depending on whether you'd just edited it or reloaded the page.

const { currentMonthRange, isISODate, todayISO } = require('./util');

// Wide enough to cover every row that could exist — this account's first campaign predates the
// tracker but not by decades. Used for the "All time" option, which otherwise silently returned
// current-month numbers under an "All time" label because an absent range falls back to the month.
const ALL_TIME_START = '2000-01-01';

// Lets the frontend's date picker (month, quarter or a hand-picked calendar range) control the
// reporting period metrics are summed over, like LinkedIn Campaign Manager's date picker.
// `?all=1` reports over all recorded history; an absent/invalid range falls back to current-month.
function reportingRange(req) {
  const q = req.query || {};
  if (q.all) return { start: ALL_TIME_START, end: todayISO() };
  const { start, end } = q;
  if (isISODate(start) && isISODate(end) && start <= end) return { start, end };
  return currentMonthRange();
}

// LinkedIn's reporting API occasionally sends a negative delta on a given day (e.g. an
// invalid-click/fraud correction) — clamp the summed total so the UI never shows a nonsensical
// negative spend/click count, while still letting per-day corrections net out. `days` is what
// distinguishes "no rows at all" from "rows that legitimately sum to zero": greatest(sum(x), 0)
// collapses both to 0, because Postgres' GREATEST ignores NULL arguments.
const METRIC_AGG = `
  select count(*) as days,
         greatest(sum(spend), 0) as spend, greatest(sum(impressions), 0) as impressions,
         greatest(sum(clicks), 0) as clicks, greatest(sum(reach), 0) as reach,
         greatest(sum(leads), 0) as leads,
         (array_agg(source order by metric_date desc))[1] as source`;

// Metrics are joined here (not just on /api/assets) so a campaign with no assets attached yet
// still shows its logged current-month numbers in the country view's campaigns panel.
const CAMPAIGN_SELECT = `
  select c.*, m.name as market_name,
         cm.spend, cm.impressions, cm.clicks, cm.reach, cm.leads,
         cm.source as metrics_source
  from campaigns c
  join markets m on m.id = c.market_id
  left join lateral (
    ${METRIC_AGG}
    from campaign_daily_metrics
    where campaign_id = c.id and metric_date >= $1 and metric_date <= $2
  ) cm on true
`;

// Each asset is one LinkedIn ad (creative), so its metrics come from asset_daily_metrics
// (pivot=CREATIVE) rather than the parent campaign's rollup, which several assets can share.
//
// The fallback matters: an asset only ever gets creative-level rows once `li_creative_id` is set,
// and nothing in the app ever set it, so every asset read back as zeros. When an asset has no
// creative ID linked, the honest best-available number is its parent campaign's total for the
// same window — reported as metrics_source='campaign' so the UI can say so rather than implying
// the figure is ad-specific. An asset that *is* linked but has no rows is genuinely not serving,
// so it correctly stays at zero instead of inheriting the campaign's spend.
const ASSET_SELECT = `
  select a.*,
         m.name as market_name,
         c.name as campaign_name,
         c.li_campaign_id as li_campaign_id,
         case when am.days > 0 then am.spend       else coalesce(cm.spend, 0) end       as spend,
         case when am.days > 0 then am.impressions else coalesce(cm.impressions, 0) end as impressions,
         case when am.days > 0 then am.clicks      else coalesce(cm.clicks, 0) end      as clicks,
         case when am.days > 0 then am.reach       else coalesce(cm.reach, 0) end       as reach,
         case when am.days > 0 then am.leads       else coalesce(cm.leads, 0) end       as leads,
         case when am.days > 0 then am.source
              when cm.days > 0 then 'campaign'
              else null end as metrics_source
  from assets a
  join markets m on m.id = a.market_id
  left join campaigns c on c.id = a.campaign_id
  left join lateral (
    ${METRIC_AGG}
    from asset_daily_metrics
    where asset_id = a.id and metric_date >= $1 and metric_date <= $2
  ) am on true
  left join lateral (
    ${METRIC_AGG}
    from campaign_daily_metrics
    where a.li_creative_id is null
      and campaign_id = a.campaign_id and metric_date >= $1 and metric_date <= $2
  ) cm on true
`;

module.exports = { CAMPAIGN_SELECT, ASSET_SELECT, reportingRange };
