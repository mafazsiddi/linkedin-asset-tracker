const { query } = require('./db');
const { listCreativesForCampaigns, fetchCampaignMetadata } = require('./linkedin');

// Pulls the ads that actually exist in LinkedIn into the assets table.
//
// Adding a campaign only ever created the campaign row — its ads had to be typed in by hand, one
// at a time, along with a creative ID copied out of Campaign Manager. In practice that meant
// assets were never linked to real ads at all, so nothing ad-level was ever fetched for them.
//
// Matching is on li_creative_id, which is uniquely indexed, so re-running only fills in ads that
// appeared since the last run. Existing assets are refreshed in place (name/status), never
// duplicated, and their locally-edited workflow fields (assignee, due date, notes, links) are left
// alone — only the columns LinkedIn is authoritative for are touched.
async function importCreativesAsAssets(campaigns, options) {
  const opts = options || {};
  const withId = campaigns.filter(c => c.li_campaign_id);
  if (!withId.length) return { imported: 0, updated: 0, skipped: 0, errors: [] };

  const creatives = await listCreativesForCampaigns(withId);

  // Map LinkedIn campaign id -> local campaign row, so each ad lands in the right market.
  const byLiCampaign = new Map(withId.map(c => [String(c.li_campaign_id), c]));

  const { rows: existing } = await query(
    'select id, li_creative_id, title from assets where li_creative_id is not null'
  );
  const known = new Map(existing.map(a => [String(a.li_creative_id), a]));

  let imported = 0;
  let updated = 0;
  let skipped = 0;
  const errors = [];

  for (const cr of creatives) {
    const campaign = byLiCampaign.get(String(cr.campaignId));
    if (!campaign) { skipped++; continue; }
    try {
      const prior = known.get(String(cr.creativeId));
      if (prior) {
        // Refresh only LinkedIn-owned columns.
        await query(
          `update assets
             set li_status = $2, li_is_serving = $3, li_synced_at = now(), updated_at = now(),
                 campaign_id = coalesce(campaign_id, $4)
           where id = $1`,
          [prior.id, cr.status, cr.isServing, campaign.id]
        );
        updated++;
        continue;
      }
      // on conflict do nothing guards against two overlapping syncs racing on the same ad.
      const ins = await query(
        `insert into assets
           (title, type, market_id, campaign_id, li_creative_id, li_status, li_is_serving,
            li_synced_at, imported_from_linkedin, status, version)
         values ($1,$2,$3,$4,$5,$6,$7, now(), true, $8, 'v1')
         on conflict (li_creative_id) where li_creative_id is not null do nothing
         returning id`,
        [
          cr.name, cr.type, campaign.market_id, campaign.id, cr.creativeId,
          cr.status, cr.isServing,
          // An ad that LinkedIn is actively serving is, by definition, live.
          cr.isServing ? 'Live on LinkedIn' : 'Delivered'
        ]
      );
      if (ins.rows.length) imported++; else skipped++;
    } catch (e) {
      errors.push(`creative ${cr.creativeId}: ${e.message}`);
    }
  }

  return { imported, updated, skipped, creativesSeen: creatives.length, errors };
}

// Refreshes campaign status/objective/budget/schedule from LinkedIn. Without this the app has no
// idea which campaigns are still live, so the country view lists every campaign ever created.
async function syncCampaignMetadata(campaigns) {
  const withId = campaigns.filter(c => c.li_campaign_id);
  if (!withId.length) return { updated: 0, errors: [] };

  const meta = await fetchCampaignMetadata(withId);
  let updated = 0;
  const errors = [];

  for (const campaign of withId) {
    const m = meta[String(campaign.li_campaign_id)];
    if (!m) {
      errors.push(`campaign "${campaign.name}" (${campaign.li_campaign_id}): not returned by LinkedIn`);
      continue;
    }
    try {
      await query(
        `update campaigns set
           status = $2, serving_status = $3, objective = $4, format = $5, cost_type = $6,
           daily_budget = $7, budget_currency = $8, run_start = $9, run_end = $10,
           li_synced_at = now()
         where id = $1`,
        [
          campaign.id, m.status, m.servingStatus, m.objective, m.format, m.costType,
          m.dailyBudget, m.budgetCurrency, m.runStart, m.runEnd
        ]
      );
      updated++;
    } catch (e) {
      errors.push(`campaign "${campaign.name}": ${e.message}`);
    }
  }
  return { updated, errors };
}

module.exports = { importCreativesAsAssets, syncCampaignMetadata };
