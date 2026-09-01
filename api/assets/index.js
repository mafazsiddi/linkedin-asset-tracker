const { query } = require('../../lib/db');
const { json, methodNotAllowed, currentMonthRange, withHandler } = require('../../lib/util');
const { ASSET_SELECT, reportingRange } = require('../../lib/queries');

const INSERT_ASSET = `
  insert into assets
    (title, type, market_id, campaign_id, li_creative_id, requested_by, assigned_to, priority,
     due_date, status, date_delivered, link, version, ad_copy_link, creative_link, notes)
   values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
   returning *`;

function insertParams(b) {
  return [
    b.title, b.type || 'Image', Number(b.marketId), b.campaignId ? Number(b.campaignId) : null,
    b.liCreativeId || null,
    b.requestedBy || null, b.assignedTo || null, b.priority || 'Medium', b.dueDate || null,
    b.status || 'Requested', b.dateDelivered || null, b.link || null, b.version || 'v1',
    b.adCopyLink || null, b.creativeLink || null, b.notes || null
  ];
}

// Reassigning work is the one asset change somebody else needs to hear about.
async function notifyAssignee(asset) {
  if (!asset.assigned_to) return;
  const market = await query('select name from markets where id = $1', [asset.market_id]);
  await query(
    `insert into notifications (to_name, asset_id, asset_title, market_name) values ($1,$2,$3,$4)`,
    [asset.assigned_to, asset.id, asset.title, market.rows[0] ? market.rows[0].name : null]
  );
}

module.exports = withHandler(async function handler(req, res) {
  if (req.method === 'GET') {
    const { start, end } = reportingRange(req);
    const { rows } = await query(`${ASSET_SELECT} order by a.created_at desc`, [start, end]);
    return json(res, 200, rows);
  }

  if (req.method === 'POST') {
    const b = req.body || {};

    // Bulk create, used by the asset library's CSV import. Each row is validated and inserted
    // independently and failures are reported per-row rather than aborting the batch — a single
    // typo'd market name in a 200-row spreadsheet shouldn't discard the other 199 good rows, and
    // the importer needs to be able to tell the user exactly which lines to fix.
    if (Array.isArray(b.assets)) {
      const results = [];
      const errors = [];
      for (let i = 0; i < b.assets.length; i++) {
        const row = b.assets[i] || {};
        // Row numbers are 1-based and refer to data rows, matching what the user sees after the
        // header line in their spreadsheet.
        const at = i + 1;
        if (!row.title) { errors.push({ row: at, error: 'title is required' }); continue; }
        if (!row.marketId) { errors.push({ row: at, error: 'a known country/market is required' }); continue; }
        try {
          const { rows } = await query(INSERT_ASSET, insertParams(row));
          await notifyAssignee(rows[0]);
          results.push(rows[0].id);
        } catch (e) {
          errors.push({ row: at, error: e.message });
        }
      }
      const { start, end } = currentMonthRange();
      const created = results.length
        ? (await query(`${ASSET_SELECT} where a.id = any($3::int[]) order by a.created_at desc`,
            [start, end, results])).rows
        : [];
      return json(res, errors.length && !results.length ? 400 : 201, {
        created: results.length, failed: errors.length, errors, assets: created
      });
    }

    if (!b.title) return json(res, 400, { error: 'title is required' });
    if (!b.marketId) return json(res, 400, { error: 'marketId is required' });
    const { rows } = await query(INSERT_ASSET, insertParams(b));
    const asset = rows[0];
    await notifyAssignee(asset);
    const { start, end } = currentMonthRange();
    const joined = await query(`${ASSET_SELECT} where a.id = $3`, [start, end, asset.id]);
    return json(res, 201, joined.rows[0]);
  }

  return methodNotAllowed(res, ['GET', 'POST']);
});
