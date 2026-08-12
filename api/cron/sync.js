const { query } = require('../../lib/db');
const { json, todayISO } = require('../../lib/util');
const { getCampaignDailyStats } = require('../../lib/linkedin');

// Vercel invokes this daily per vercel.json's crons config. When CRON_SECRET is set (recommended
// once deployed), Vercel automatically sends it as "Authorization: Bearer <CRON_SECRET>" on
// scheduled invocations, and that's what we check here — anyone else calling this without the
// secret gets rejected.
module.exports = async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const authHeader = req.headers['authorization'] || '';
    if (authHeader !== `Bearer ${secret}`) return json(res, 401, { error: 'Unauthorized' });
  }

  const date = todayISO();
  const { rows: campaigns } = await query('select * from campaigns where li_campaign_id is not null');
  let synced = 0;

  try {
    for (const campaign of campaigns) {
      const stats = await getCampaignDailyStats(campaign, date);
      await query(
        `insert into campaign_daily_metrics (campaign_id, metric_date, spend, impressions, clicks, reach, leads, source)
         values ($1,$2,$3,$4,$5,$6,$7,'sync')
         on conflict (campaign_id, metric_date)
         do update set spend=$3, impressions=$4, clicks=$5, reach=$6, leads=$7, source='sync', updated_at=now()`,
        [campaign.id, date, stats.spend, stats.impressions, stats.clicks, stats.reach, stats.leads]
      );
      synced++;
    }
    await query('insert into sync_log (status, campaigns_synced) values ($1,$2)', ['ok', synced]);
    return json(res, 200, { synced, date, campaignsConsidered: campaigns.length });
  } catch (e) {
    await query('insert into sync_log (status, campaigns_synced, error) values ($1,$2,$3)', ['error', synced, e.message]);
    return json(res, 500, { error: e.message, synced });
  }
};
