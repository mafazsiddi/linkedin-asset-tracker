const { query } = require('../../lib/db');
const { json, methodNotAllowed, currentMonthRange } = require('../../lib/util');

// Each asset is one LinkedIn ad (creative), so its metrics come from asset_daily_metrics
// (pivot=CREATIVE) — not the parent campaign's rollup, which several assets can share.
const ASSET_SELECT = `
  select a.*,
         m.name as market_name,
         c.name as campaign_name,
         c.li_campaign_id as li_campaign_id,
         coalesce(am.spend, 0) as spend,
         coalesce(am.impressions, 0) as impressions,
         coalesce(am.clicks, 0) as clicks,
         coalesce(am.reach, 0) as reach,
         coalesce(am.leads, 0) as leads,
         am.source as metrics_source
  from assets a
  join markets m on m.id = a.market_id
  left join campaigns c on c.id = a.campaign_id
  left join lateral (
    select sum(spend) as spend, sum(impressions) as impressions, sum(clicks) as clicks,
           sum(reach) as reach, sum(leads) as leads,
           (array_agg(source order by metric_date desc))[1] as source
    from asset_daily_metrics
    where asset_id = a.id and metric_date >= $1 and metric_date <= $2
  ) am on true
`;

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    const { start, end } = currentMonthRange();
    const { rows } = await query(`${ASSET_SELECT} order by a.created_at desc`, [start, end]);
    return json(res, 200, rows);
  }

  if (req.method === 'POST') {
    const b = req.body || {};
    if (!b.title) return json(res, 400, { error: 'title is required' });
    if (!b.marketId) return json(res, 400, { error: 'marketId is required' });
    const { rows } = await query(
      `insert into assets
        (title, type, market_id, campaign_id, requested_by, assigned_to, priority, due_date,
         status, date_delivered, link, version, ad_copy_link, creative_link, notes)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       returning *`,
      [
        b.title, b.type || 'Image', Number(b.marketId), b.campaignId ? Number(b.campaignId) : null,
        b.requestedBy || null, b.assignedTo || null, b.priority || 'Medium', b.dueDate || null,
        b.status || 'Requested', b.dateDelivered || null, b.link || null, b.version || 'v1',
        b.adCopyLink || null, b.creativeLink || null, b.notes || null
      ]
    );
    const asset = rows[0];
    if (asset.assigned_to) {
      const market = await query('select name from markets where id = $1', [asset.market_id]);
      await query(
        `insert into notifications (to_name, asset_id, asset_title, market_name) values ($1,$2,$3,$4)`,
        [asset.assigned_to, asset.id, asset.title, market.rows[0] ? market.rows[0].name : null]
      );
    }
    const { start, end } = currentMonthRange();
    const joined = await query(`${ASSET_SELECT} where a.id = $3`, [start, end, asset.id]);
    return json(res, 201, joined.rows[0]);
  }

  return methodNotAllowed(res, ['GET', 'POST']);
};
