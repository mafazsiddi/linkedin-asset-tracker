const { query } = require('../../lib/db');
const { json, methodNotAllowed, todayISO, withHandler } = require('../../lib/util');

// Manual stopgap logging for a campaign/day until the daily sync goes live. The sync always
// overwrites whatever is here for that day once it runs (source flips to 'sync').
module.exports = withHandler(async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const b = req.body || {};
  if (!b.campaignId) return json(res, 400, { error: 'campaignId is required' });
  const date = b.date || todayISO();
  const { rows } = await query(
    `insert into campaign_daily_metrics (campaign_id, metric_date, spend, impressions, clicks, reach, leads, source)
     values ($1,$2,$3,$4,$5,$6,$7,'manual')
     on conflict (campaign_id, metric_date)
     do update set spend=$3, impressions=$4, clicks=$5, reach=$6, leads=$7, source='manual', updated_at=now()
     returning *`,
    [Number(b.campaignId), date, b.spend || 0, b.impressions || 0, b.clicks || 0, b.reach || 0, b.leads || 0]
  );
  return json(res, 200, rows[0]);
});
