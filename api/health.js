const { query } = require('../lib/db');
const { json, methodNotAllowed, withHandler, currentMonthRange, todayISO, addDaysISO } = require('../lib/util');
const { getCampaignDailyStatsRange } = require('../lib/linkedin');

// One place to answer "why are the numbers wrong / why is nothing loading" without needing
// database access. Every previous failure — a rotated Postgres password, an unapplied schema, an
// expired LinkedIn token, a sync that has been erroring for days — presented identically in the
// UI as an empty table, so the only signal anything was broken was somebody noticing and
// complaining. This reports each of those distinctly.
module.exports = withHandler(async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  const out = {
    ok: false,
    checkedAt: new Date().toISOString(),
    database: { connected: false },
    linkedin: { mode: process.env.LINKEDIN_MODE || 'mock' },
    sync: {}
  };

  try {
    const { rows } = await query('select current_database() as db, now() as now');
    out.database.connected = true;
    out.database.name = rows[0].db;
  } catch (e) {
    out.database.error = e.message;
    out.database.code = e.code;
    out.database.hint = (e.code === '28P01')
      ? 'Postgres rejected the credentials. POSTGRES_URL on this deployment is stale — update it and redeploy (env var changes only apply to new deployments).'
      : 'Check POSTGRES_URL is set on this deployment.';
    return json(res, 503, out);
  }

  // Schema presence — a freshly provisioned database connects fine but has no tables, which
  // otherwise surfaces as every endpoint 500ing with a bare relation-does-not-exist.
  const expected = ['markets', 'campaigns', 'assets', 'campaign_daily_metrics',
    'asset_daily_metrics', 'notifications', 'sync_log', 'linkedin_tokens'];
  const { rows: present } = await query(
    'select table_name from information_schema.tables where table_schema = current_schema()'
  );
  const names = present.map(r => r.table_name);
  const missing = expected.filter(t => !names.includes(t));
  out.database.schemaComplete = missing.length === 0;
  if (missing.length) {
    out.database.missingTables = missing;
    out.database.hint = 'Run db/schema.sql against this database.';
    return json(res, 503, out);
  }

  const [{ rows: counts }, { rows: tokens }, { rows: lastSync }] = await Promise.all([
    query(`select
             (select count(*) from markets) as markets,
             (select count(*) from campaigns) as campaigns,
             (select count(*) from campaigns where li_campaign_id is not null) as campaigns_linked,
             (select count(*) from assets) as assets,
             (select count(*) from assets where li_creative_id is not null) as assets_linked`),
    query('select expires_at, updated_at from linkedin_tokens order by updated_at desc limit 1'),
    query('select run_at, status, campaigns_synced, error from sync_log order by run_at desc limit 1')
  ]);

  const c = counts[0];
  out.counts = {
    markets: Number(c.markets),
    campaigns: Number(c.campaigns),
    campaignsWithLinkedInId: Number(c.campaigns_linked),
    assets: Number(c.assets),
    assetsWithCreativeId: Number(c.assets_linked)
  };

  const token = tokens[0];
  out.linkedin.tokenStored = Boolean(token);
  if (token) {
    out.linkedin.tokenExpiresAt = token.expires_at;
    out.linkedin.tokenExpired = Boolean(token.expires_at && new Date(token.expires_at) < new Date());
  }
  if (out.linkedin.mode === 'live' && (!token || out.linkedin.tokenExpired)) {
    out.linkedin.hint = 'LINKEDIN_MODE=live but there is no valid stored token — every live fetch will fail. Visit /api/auth/linkedin/start.';
  }

  out.sync.last = lastSync[0] || null;
  const monthRange = currentMonthRange();
  const { rows: coverage } = await query(
    `select count(distinct metric_date) as days
     from campaign_daily_metrics where metric_date >= $1 and metric_date <= $2`,
    [monthRange.start, monthRange.end]
  );
  // A month-to-date total is only as complete as the days behind it, so report the gap directly
  // rather than letting an under-counted total look like a real drop in spend.
  out.sync.monthRange = monthRange;
  out.sync.daysWithDataThisMonth = Number(coverage[0].days);

  // ?probe=1 makes one real read-only LinkedIn call so a broken credential, an expired API
  // version or a missing scope can be confirmed directly, instead of being inferred from the
  // sync quietly writing nothing. Opt-in because it costs an API round-trip. Writes nothing.
  if (req.query && req.query.probe) {
    const { rows: probeRows } = await query(
      'select * from campaigns where li_campaign_id is not null order by id limit 1'
    );
    if (!probeRows.length) {
      out.linkedin.probe = { ran: false, reason: 'No campaign has a LinkedIn campaign ID to probe with.' };
    } else {
      const day = addDaysISO(todayISO(), -2);
      try {
        const stats = await getCampaignDailyStatsRange(probeRows[0], day, day);
        out.linkedin.probe = {
          ran: true, ok: true, campaign: probeRows[0].name, date: day,
          returned: stats[day] || null
        };
      } catch (e) {
        out.linkedin.probe = { ran: true, ok: false, campaign: probeRows[0].name, date: day, error: e.message };
      }
    }
  }

  const warnings = [];
  if (out.linkedin.hint) warnings.push(out.linkedin.hint);
  if (out.linkedin.probe && out.linkedin.probe.ok === false) warnings.push(`LinkedIn probe failed: ${out.linkedin.probe.error}`);
  if (out.counts.campaignsWithLinkedInId === 0) warnings.push('No campaign has a LinkedIn campaign ID, so the sync has nothing to fetch.');
  if (out.sync.last && out.sync.last.status !== 'ok') warnings.push(`Last sync reported "${out.sync.last.status}": ${out.sync.last.error || ''}`.trim());
  if (!out.sync.last) warnings.push('The sync has never run on this database.');
  out.warnings = warnings;
  out.ok = warnings.length === 0;

  return json(res, 200, out);
});
