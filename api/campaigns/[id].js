const { query } = require('../../lib/db');
const { json, methodNotAllowed, currentMonthRange, withHandler } = require('../../lib/util');
const { CAMPAIGN_SELECT, reportingRange } = require('../../lib/queries');
const { backfillCampaign } = require('../../lib/backfill');
const { listCampaignCreatives } = require('../../lib/linkedin');
const { companiesForCampaign } = require('../../lib/companies');
const { ensureSchema } = require('../../lib/migrate');
const { DEAD_STATUSES: DEAD_CREATIVE_STATUSES } = require('../../lib/importer');

module.exports = withHandler(async function handler(req, res) {
  const id = Number(req.query.id);

  // GET /api/campaigns/:id?companies=1[&start=&end=][&refresh=1] — the companies that have seen
  // this ad set, mirroring Campaign Manager's Companies report. Rides on this route for the same
  // reason ?creatives=1 does: the Hobby plan caps a deployment at 12 Serverless Functions and
  // api/ is already at exactly 12.
  if (req.method === 'GET' && req.query.companies) {
    const { rows } = await query('select * from campaigns where id = $1', [id]);
    if (!rows.length) return json(res, 404, { error: 'Not found' });
    const campaign = rows[0];
    if (!campaign.li_campaign_id) {
      return json(res, 409, {
        error: `Campaign "${campaign.name}" has no LinkedIn campaign ID set, so its audience can't be looked up.`
      });
    }
    // The cache table arrived after the first deploys, and production can't be reached with psql —
    // so make sure it exists before reading through it.
    await ensureSchema();
    const { start, end } = reportingRange(req);
    const result = await companiesForCampaign(campaign, start, end, {
      refresh: Boolean(req.query.refresh)
    });
    return json(res, 200, Object.assign({ campaignId: id, window: { start, end } }, result));
  }

  // GET /api/campaigns/:id?creatives=1 — lists the real LinkedIn ads under this campaign so an
  // asset can be pointed at one. An asset only gets its own (rather than its campaign's) numbers
  // once li_creative_id is set, and there was previously no way to discover those IDs short of
  // opening Campaign Manager. Lives on this route rather than its own function because the Hobby
  // plan caps a deployment at 12 Serverless Functions and this project is at the limit.
  if (req.method === 'GET' && req.query.creatives) {
    const { rows } = await query('select * from campaigns where id = $1', [id]);
    if (!rows.length) return json(res, 404, { error: 'Not found' });
    const campaign = rows[0];
    if (!campaign.li_campaign_id) {
      return json(res, 409, {
        error: `Campaign "${campaign.name}" has no LinkedIn campaign ID set, so its ads can't be looked up.`
      });
    }
    // Mark which creatives are already claimed so the UI doesn't offer the same ad twice.
    const { rows: taken } = await query(
      'select li_creative_id, title from assets where campaign_id = $1 and li_creative_id is not null',
      [id]
    );
    const takenBy = new Map(taken.map(t => [String(t.li_creative_id), t.title]));
    const creatives = await listCampaignCreatives(campaign);
    // Same exclusion the importer applies — a picker offering 70 deleted ads is unusable.
    // ?all=1 keeps the unfiltered list available for looking up a specific old ad.
    const usable = req.query.all
      ? creatives
      : creatives.filter(c => !DEAD_CREATIVE_STATUSES.has(String(c.status || '').toUpperCase()));
    return json(res, 200, usable.map(c => Object.assign({}, c, {
      linkedToAsset: takenBy.get(String(c.creativeId)) || null
    })));
  }

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
    const updated = await query(
      `update campaigns set name = $2, market_id = $3, li_campaign_id = $4 where id = $1 returning *`,
      [id, merged.name, merged.market_id, merged.li_campaign_id]
    );

    // Attaching (or correcting) the LinkedIn campaign ID is the moment the campaign becomes
    // syncable — fetch its history now instead of leaving it at zero until the next cron run.
    let backfill = null;
    if (merged.li_campaign_id && merged.li_campaign_id !== prev.li_campaign_id) {
      backfill = await backfillCampaign(updated.rows[0], currentMonthRange());
    }

    const { start, end } = currentMonthRange();
    const joined = await query(`${CAMPAIGN_SELECT} where c.id = $3`, [start, end, id]);
    return json(res, 200, Object.assign({}, joined.rows[0], backfill ? { backfill } : {}));
  }

  if (req.method === 'DELETE') {
    await query('delete from campaigns where id = $1', [id]);
    return json(res, 204, null);
  }

  return methodNotAllowed(res, ['GET', 'PUT', 'DELETE']);
});
