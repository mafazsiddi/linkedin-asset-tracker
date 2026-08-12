const { query } = require('../../lib/db');
const { json, methodNotAllowed, currentMonthRange } = require('../../lib/util');

// Metrics are joined here (not just on /api/assets) so a campaign with no assets attached yet
// still shows its logged current-month numbers in the country view's campaigns panel.
const CAMPAIGN_SELECT = `
  select c.*, m.name as market_name,
         coalesce(cm.spend, 0) as spend,
         coalesce(cm.impressions, 0) as impressions,
         coalesce(cm.clicks, 0) as clicks,
         coalesce(cm.reach, 0) as reach,
         coalesce(cm.leads, 0) as leads,
         cm.source as metrics_source
  from campaigns c
  join markets m on m.id = c.market_id
  left join lateral (
    select sum(spend) as spend, sum(impressions) as impressions, sum(clicks) as clicks,
           sum(reach) as reach, sum(leads) as leads,
           (array_agg(source order by metric_date desc))[1] as source
    from campaign_daily_metrics
    where campaign_id = c.id and metric_date >= $1 and metric_date <= $2
  ) cm on true
`;

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    const { marketId } = req.query;
    const { start, end } = currentMonthRange();
    const params = [start, end];
    let where = '';
    if (marketId) {
      params.push(Number(marketId));
      where = 'where c.market_id = $3';
    }
    const { rows } = await query(`${CAMPAIGN_SELECT} ${where} order by c.name`, params);
    return json(res, 200, rows);
  }

  if (req.method === 'POST') {
    const { name, marketId, liCampaignId } = req.body || {};
    if (!name || !marketId) return json(res, 400, { error: 'name and marketId are required' });
    const inserted = await query(
      `insert into campaigns (name, market_id, li_campaign_id)
       values ($1, $2, $3) returning id`,
      [name, Number(marketId), liCampaignId || null]
    );
    const { start, end } = currentMonthRange();
    const joined = await query(`${CAMPAIGN_SELECT} where c.id = $3`, [start, end, inserted.rows[0].id]);
    return json(res, 201, joined.rows[0]);
  }

  return methodNotAllowed(res, ['GET', 'POST']);
};
