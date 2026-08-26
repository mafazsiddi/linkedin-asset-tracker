const { query } = require('../../lib/db');
const { json, methodNotAllowed, currentMonthRange, withHandler } = require('../../lib/util');
const { ASSET_SELECT, reportingRange } = require('../../lib/queries');

module.exports = withHandler(async function handler(req, res) {
  if (req.method === 'GET') {
    const { start, end } = reportingRange(req);
    const { rows } = await query(`${ASSET_SELECT} order by a.created_at desc`, [start, end]);
    return json(res, 200, rows);
  }

  if (req.method === 'POST') {
    const b = req.body || {};
    if (!b.title) return json(res, 400, { error: 'title is required' });
    if (!b.marketId) return json(res, 400, { error: 'marketId is required' });
    const { rows } = await query(
      `insert into assets
        (title, type, market_id, campaign_id, li_creative_id, requested_by, assigned_to, priority,
         due_date, status, date_delivered, link, version, ad_copy_link, creative_link, notes)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       returning *`,
      [
        b.title, b.type || 'Image', Number(b.marketId), b.campaignId ? Number(b.campaignId) : null,
        b.liCreativeId || null,
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
});
