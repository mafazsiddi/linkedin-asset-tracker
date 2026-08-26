const { query } = require('../../lib/db');
const { json, methodNotAllowed, currentMonthRange, withHandler } = require('../../lib/util');
const { CAMPAIGN_SELECT, reportingRange } = require('../../lib/queries');
const { backfillCampaign } = require('../../lib/backfill');

module.exports = withHandler(async function handler(req, res) {
  if (req.method === 'GET') {
    const { marketId } = req.query;
    const { start, end } = reportingRange(req);
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
       values ($1, $2, $3) returning *`,
      [name, Number(marketId), liCampaignId || null]
    );
    const campaign = inserted.rows[0];

    // Pull this campaign's history immediately rather than waiting for the next scheduled sync.
    const backfill = await backfillCampaign(campaign, currentMonthRange());

    const { start, end } = currentMonthRange();
    const joined = await query(`${CAMPAIGN_SELECT} where c.id = $3`, [start, end, campaign.id]);
    return json(res, 201, Object.assign({}, joined.rows[0], { backfill }));
  }

  return methodNotAllowed(res, ['GET', 'POST']);
});
