const { query } = require('../../lib/db');
const { json, methodNotAllowed, currentMonthRange } = require('../../lib/util');

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
  const id = Number(req.query.id);

  if (req.method === 'PUT') {
    const existing = await query('select * from campaigns where id = $1', [id]);
    if (!existing.rows.length) return json(res, 404, { error: 'Not found' });
    const prev = existing.rows[0];
    const { name, marketId, liCampaignId } = req.body || {};
    const merged = {
      name: name ?? prev.name,
      market_id: marketId ? Number(marketId) : prev.market_id,
      // liCampaignId can be explicitly cleared to null, so distinguish "not sent" from "cleared".
      li_campaign_id: liCampaignId !== undefined ? (liCampaignId || null) : prev.li_campaign_id
    };
    await query(
      `update campaigns set name = $2, market_id = $3, li_campaign_id = $4 where id = $1`,
      [id, merged.name, merged.market_id, merged.li_campaign_id]
    );
    const { start, end } = currentMonthRange();
    const joined = await query(`${CAMPAIGN_SELECT} where c.id = $3`, [start, end, id]);
    return json(res, 200, joined.rows[0]);
  }

  if (req.method === 'DELETE') {
    await query('delete from campaigns where id = $1', [id]);
    return json(res, 204, null);
  }

  return methodNotAllowed(res, ['PUT', 'DELETE']);
};
