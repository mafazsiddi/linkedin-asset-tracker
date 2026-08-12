const { query } = require('../../lib/db');
const { json, methodNotAllowed, currentMonthRange } = require('../../lib/util');

const ASSET_SELECT = `
  select a.*,
         m.name as market_name,
         c.name as campaign_name,
         c.li_campaign_id as li_campaign_id,
         coalesce(cm.spend, 0) as spend,
         coalesce(cm.impressions, 0) as impressions,
         coalesce(cm.clicks, 0) as clicks,
         coalesce(cm.reach, 0) as reach,
         coalesce(cm.leads, 0) as leads,
         cm.source as metrics_source
  from assets a
  join markets m on m.id = a.market_id
  left join campaigns c on c.id = a.campaign_id
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
    const existing = await query('select * from assets where id = $1', [id]);
    if (!existing.rows.length) return json(res, 404, { error: 'Not found' });
    const prev = existing.rows[0];
    const b = req.body || {};
    const merged = {
      title: b.title ?? prev.title,
      type: b.type ?? prev.type,
      market_id: b.marketId ? Number(b.marketId) : prev.market_id,
      campaign_id: b.campaignId !== undefined ? (b.campaignId ? Number(b.campaignId) : null) : prev.campaign_id,
      requested_by: b.requestedBy ?? prev.requested_by,
      assigned_to: b.assignedTo ?? prev.assigned_to,
      priority: b.priority ?? prev.priority,
      due_date: b.dueDate !== undefined ? (b.dueDate || null) : prev.due_date,
      status: b.status ?? prev.status,
      date_delivered: b.dateDelivered !== undefined ? (b.dateDelivered || null) : prev.date_delivered,
      link: b.link ?? prev.link,
      version: b.version ?? prev.version,
      ad_copy_link: b.adCopyLink ?? prev.ad_copy_link,
      creative_link: b.creativeLink ?? prev.creative_link,
      notes: b.notes ?? prev.notes
    };
    const { rows } = await query(
      `update assets set
         title=$2, type=$3, market_id=$4, campaign_id=$5, requested_by=$6, assigned_to=$7,
         priority=$8, due_date=$9, status=$10, date_delivered=$11, link=$12, version=$13,
         ad_copy_link=$14, creative_link=$15, notes=$16, updated_at=now()
       where id=$1 returning *`,
      [
        id, merged.title, merged.type, merged.market_id, merged.campaign_id, merged.requested_by,
        merged.assigned_to, merged.priority, merged.due_date, merged.status, merged.date_delivered,
        merged.link, merged.version, merged.ad_copy_link, merged.creative_link, merged.notes
      ]
    );
    const asset = rows[0];
    if (asset.assigned_to && asset.assigned_to !== prev.assigned_to) {
      const market = await query('select name from markets where id = $1', [asset.market_id]);
      await query(
        `insert into notifications (to_name, asset_id, asset_title, market_name) values ($1,$2,$3,$4)`,
        [asset.assigned_to, asset.id, asset.title, market.rows[0] ? market.rows[0].name : null]
      );
    }
    const { start, end } = currentMonthRange();
    const joined = await query(`${ASSET_SELECT} where a.id = $3`, [start, end, id]);
    return json(res, 200, joined.rows[0]);
  }

  if (req.method === 'DELETE') {
    await query('delete from assets where id = $1', [id]);
    return json(res, 204, null);
  }

  return methodNotAllowed(res, ['PUT', 'DELETE']);
};
