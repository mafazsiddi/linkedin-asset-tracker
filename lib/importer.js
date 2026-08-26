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
// Ads in these states never ran — CANCELED is what LinkedIn marks a deleted ad as, and DRAFT never
// left the composer. This account carries 70 of them against 20 campaigns, all unnamed and with no
// impressions, so importing them would bury the ads that matter under dead rows.
const DEAD_STATUSES = new Set(['CANCELED', 'DRAFT']);

function isImportable(cr) {
  return !DEAD_STATUSES.has(String(cr.status || '').toUpperCase());
}

// Removes rows this importer created for ads that turn out to be dead, but only when nothing would
// be lost: no metrics were ever recorded against them and nobody has edited them locally. Assets
// created by hand (imported_from_linkedin = false) are never touched.
async function pruneDeadImportedAssets() {
  const { rowCount } = await query(
    `delete from assets a
      where a.imported_from_linkedin = true
        and upper(coalesce(a.li_status, '')) = any($1::text[])
        and not exists (select 1 from asset_daily_metrics m where m.asset_id = a.id)
        and a.assigned_to is null and a.notes is null and a.due_date is null
        and a.link is null and a.ad_copy_link is null and a.creative_link is null
        and a.date_delivered is null`,
    [[...DEAD_STATUSES]]
  );
  return rowCount || 0;
}

async function importCreativesAsAssets(campaigns, options) {
  const opts = options || {};
  const withId = campaigns.filter(c => c.li_campaign_id);
  if (!withId.length) return { imported: 0, updated: 0, skipped: 0, pruned: 0, errors: [] };

  const all = await listCreativesForCampaigns(withId);
  const creatives = all.filter(isImportable);
  const deadSkipped = all.length - creatives.length;

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

  // Iterate every creative, not just the importable ones: an ad that was imported while live and
  // has since been cancelled still needs its status refreshed, otherwise it keeps reporting the
  // state it had at import time and the prune below never recognises it as dead.
  for (const cr of all) {
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
      // Never create a row for an ad that never ran.
      if (!isImportable(cr)) { skipped++; continue; }
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

  let pruned = 0;
  try {
    pruned = await pruneDeadImportedAssets();
  } catch (e) {
    errors.push(`prune: ${e.message}`);
  }

  return {
    imported, updated, skipped, pruned,
    creativesSeen: all.length, importable: creatives.length, deadSkipped,
    errors
  };
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
