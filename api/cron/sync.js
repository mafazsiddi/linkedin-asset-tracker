const { query } = require('../../lib/db');
const { json, todayISO, addDaysISO, isISODate, withHandler } = require('../../lib/util');
const { getCampaignDailyStatsRange, getAssetDailyStatsRange } = require('../../lib/linkedin');

// How many trailing days each run re-fetches. Syncing only "today" (what this used to do) meant
// any hour the job didn't run left a permanent hole in the month-to-date sums, and LinkedIn's own
// numbers for a given day keep moving for ~2-3 days as clicks are de-duplicated and conversions
// are attributed. Re-fetching a trailing window makes the stored data self-healing: a missed run
// or a restated day is corrected on the next pass instead of being wrong until someone notices.
const DEFAULT_WINDOW_DAYS = Number(process.env.SYNC_WINDOW_DAYS || 7);

const UPSERT_CAMPAIGN = `
  insert into campaign_daily_metrics (campaign_id, metric_date, spend, impressions, clicks, reach, leads, source)
  values ($1,$2,$3,$4,$5,$6,$7,'sync')
  on conflict (campaign_id, metric_date)
  do update set spend=$3, impressions=$4, clicks=$5, reach=$6, leads=$7, source='sync', updated_at=now()`;

const UPSERT_ASSET = `
  insert into asset_daily_metrics (asset_id, metric_date, spend, impressions, clicks, reach, leads, source)
  values ($1,$2,$3,$4,$5,$6,$7,'sync')
  on conflict (asset_id, metric_date)
  do update set spend=$3, impressions=$4, clicks=$5, reach=$6, leads=$7, source='sync', updated_at=now()`;

// Resolves the window to sync. Defaults to the trailing DEFAULT_WINDOW_DAYS, but an explicit
// ?start=&end= lets a newly-added campaign be backfilled over its real reporting period.
function syncWindow(req) {
  const { start, end, days } = req.query || {};
  const today = todayISO();
  if (isISODate(start) && isISODate(end) && start <= end) return { start, end };
  const span = Math.max(1, Math.min(Number(days) || DEFAULT_WINDOW_DAYS, 92));
  return { start: addDaysISO(today, -(span - 1)), end: today };
}

// Vercel invokes this daily per vercel.json's crons config, and GitHub Actions calls it hourly.
// When CRON_SECRET is set (recommended once deployed), Vercel automatically sends it as
// "Authorization: Bearer <CRON_SECRET>" on scheduled invocations, and that's what we check here.
module.exports = withHandler(async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const authHeader = req.headers['authorization'] || '';
    if (authHeader !== `Bearer ${secret}`) return json(res, 401, { error: 'Unauthorized' });
  }

  const { start, end } = syncWindow(req);
  const onlyCampaign = req.query && req.query.campaignId ? Number(req.query.campaignId) : null;

  const campaignRows = onlyCampaign
    ? await query('select * from campaigns where li_campaign_id is not null and id = $1', [onlyCampaign])
    : await query('select * from campaigns where li_campaign_id is not null');
  const campaigns = campaignRows.rows;

  const assetRows = onlyCampaign
    ? await query('select id, title, li_creative_id from assets where li_creative_id is not null and campaign_id = $1', [onlyCampaign])
    : await query('select id, title, li_creative_id from assets where li_creative_id is not null');
  const assets = assetRows.rows;

  const errors = [];
  let campaignDays = 0;
  let assetDays = 0;
  let campaignsSynced = 0;

  // One campaign failing (a deleted LinkedIn campaign, a permissions gap on a single ad account)
  // used to throw straight out of the loop and abandon every remaining campaign, so a single bad
  // row zeroed the whole run. Each campaign is isolated so the rest still get their data.
  for (const campaign of campaigns) {
    try {
      const byDate = await getCampaignDailyStatsRange(campaign, start, end);
      for (const [date, stats] of Object.entries(byDate)) {
        await query(UPSERT_CAMPAIGN, [
          campaign.id, date, stats.spend, stats.impressions, stats.clicks, stats.reach, stats.leads
        ]);
        campaignDays++;
      }
      campaignsSynced++;
    } catch (e) {
      errors.push(`campaign "${campaign.name}" (#${campaign.id}): ${e.message}`);
    }
  }

  if (assets.length) {
    try {
      const byCreative = await getAssetDailyStatsRange(assets, start, end);
      for (const asset of assets) {
        const byDate = byCreative[asset.li_creative_id];
        if (!byDate) continue; // no LinkedIn data for this ad in this window (e.g. not serving)
        for (const [date, stats] of Object.entries(byDate)) {
          await query(UPSERT_ASSET, [
            asset.id, date, stats.spend, stats.impressions, stats.clicks, stats.reach, stats.leads
          ]);
          assetDays++;
        }
      }
    } catch (e) {
      errors.push(`assets: ${e.message}`);
    }
  }

  const status = errors.length ? (campaignsSynced ? 'partial' : 'error') : 'ok';
  await query(
    'insert into sync_log (status, campaigns_synced, error) values ($1,$2,$3)',
    [status, campaignsSynced, errors.length ? errors.join(' | ').slice(0, 2000) : null]
  );

  return json(res, errors.length && !campaignsSynced ? 500 : 200, {
    status,
    window: { start, end },
    campaignsConsidered: campaigns.length,
    campaignsSynced,
    campaignDaysWritten: campaignDays,
    assetsConsidered: assets.length,
    assetDaysWritten: assetDays,
    // Surfaced rather than swallowed: a run that quietly wrote nothing is exactly the failure
    // mode that kept getting noticed only from the UI showing stale numbers.
    errors
  });
});
