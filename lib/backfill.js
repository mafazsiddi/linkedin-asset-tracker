const { query } = require('./db');
const { currentMonthRange } = require('./util');
const { getCampaignDailyStatsRange, getAssetDailyStatsRange } = require('./linkedin');
const { importCreativesAsAssets, syncCampaignMetadata } = require('./importer');
const { ensureSchema } = require('./migrate');

// Adding a campaign by hand used to leave it showing zeros until the next scheduled sync, and even
// then the sync only ever wrote *that day*, so a campaign added mid-month permanently reported a
// fraction of its real month-to-date spend. Pulling its history the moment a LinkedIn campaign ID
// is attached is what makes the numbers match Campaign Manager straight away.
//
// Never throws: a backfill failure must not fail the create/update that triggered it, or the user
// loses the campaign they just typed in. The caller reports `error` back instead.
async function backfillCampaign(campaign, range) {
  const { start, end } = range || currentMonthRange();
  if (!campaign || !campaign.li_campaign_id) {
    return { ok: false, daysWritten: 0, error: null, skipped: 'no LinkedIn campaign ID' };
  }
  try {
    await ensureSchema();

    // Pull the campaign's real status/budget and import its ads as assets before fetching metrics,
    // so a campaign added by hand arrives fully populated instead of as an empty shell someone has
    // to fill in ad-by-ad.
    let meta = null;
    let ads = null;
    try { meta = await syncCampaignMetadata([campaign]); } catch (e) { meta = { error: e.message }; }
    try { ads = await importCreativesAsAssets([campaign]); } catch (e) { ads = { error: e.message }; }

    const byDate = await getCampaignDailyStatsRange(campaign, start, end);
    let daysWritten = 0;
    for (const [date, stats] of Object.entries(byDate)) {
      await query(
        `insert into campaign_daily_metrics (campaign_id, metric_date, spend, impressions, clicks, reach, leads, source)
         values ($1,$2,$3,$4,$5,$6,$7,'sync')
         on conflict (campaign_id, metric_date)
         do update set spend=$3, impressions=$4, clicks=$5, reach=$6, leads=$7, source='sync', updated_at=now()`,
        [campaign.id, date, stats.spend, stats.impressions, stats.clicks, stats.reach, stats.leads]
      );
      daysWritten++;
    }

    // Any assets already linked to real ads under this campaign get their history too, so the
    // campaign panel and the asset rows agree instead of one being populated and the other empty.
    const { rows: assets } = await query(
      'select id, li_creative_id from assets where campaign_id = $1 and li_creative_id is not null',
      [campaign.id]
    );
    let assetDaysWritten = 0;
    if (assets.length) {
      const byCreative = await getAssetDailyStatsRange(assets, start, end);
      for (const asset of assets) {
        for (const [date, stats] of Object.entries(byCreative[asset.li_creative_id] || {})) {
          await query(
            `insert into asset_daily_metrics (asset_id, metric_date, spend, impressions, clicks, reach, leads, source)
             values ($1,$2,$3,$4,$5,$6,$7,'sync')
             on conflict (asset_id, metric_date)
             do update set spend=$3, impressions=$4, clicks=$5, reach=$6, leads=$7, source='sync', updated_at=now()`,
            [asset.id, date, stats.spend, stats.impressions, stats.clicks, stats.reach, stats.leads]
          );
          assetDaysWritten++;
        }
      }
    }
    return {
      ok: true, daysWritten, assetDaysWritten, range: { start, end }, error: null,
      adsImported: ads && ads.imported, adsRefreshed: ads && ads.updated,
      metadataUpdated: meta && meta.updated
    };
  } catch (e) {
    console.error('[backfill]', campaign.li_campaign_id, e);
    return { ok: false, daysWritten: 0, range: { start, end }, error: e.message };
  }
}

module.exports = { backfillCampaign };
