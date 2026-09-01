#!/usr/bin/env node
// Proves the stored numbers are LinkedIn's own.
//
//   node scripts/audit-metrics.js 2026-08-01 2026-08-31
//
// For each campaign it fetches the range live from LinkedIn, sums the same range out of
// campaign_daily_metrics, and prints any disagreement. Agreement means the dashboard is showing
// what Campaign Manager shows; a mismatch is a bug worth chasing.
//
// This exists because two separate faults each produced totals that looked completely plausible in
// the UI — a week of generated mock rows written with source='sync', and reach silently dropped by
// LinkedIn on long date ranges. Neither was visible without comparing against the source. Read-only:
// it writes nothing.

const fs = require('fs');
const path = require('path');

// Same .env parsing dev-server.js uses, so this runs without `vercel dev`.
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

const { query } = require('../lib/db');
const { getCampaignDailyStatsRange, isLiveMode } = require('../lib/linkedin');

const START = process.argv[2];
const END = process.argv[3];
const ISO = /^\d{4}-\d{2}-\d{2}$/;

if (!ISO.test(START || '') || !ISO.test(END || '')) {
  console.error('usage: node scripts/audit-metrics.js <start YYYY-MM-DD> <end YYYY-MM-DD>');
  process.exit(2);
}

const METRICS = ['spend', 'impressions', 'clicks', 'reach', 'leads'];
const money = v => (Math.round(Number(v) * 100) / 100);

(async () => {
  if (!isLiveMode()) {
    console.error('LINKEDIN_MODE is not "live" — this would compare stored data against generated');
    console.error('numbers, which proves nothing. Set LINKEDIN_MODE=live and re-run.');
    process.exit(2);
  }

  const { rows: campaigns } = await query(
    'select id, name, li_campaign_id from campaigns where li_campaign_id is not null order by name'
  );

  console.log(`auditing ${campaigns.length} campaigns over ${START} .. ${END}\n`);

  const totals = { live: {}, stored: {} };
  for (const m of METRICS) { totals.live[m] = 0; totals.stored[m] = 0; }
  const bad = [];

  for (const c of campaigns) {
    let live = Object.fromEntries(METRICS.map(m => [m, 0]));
    try {
      const byDate = await getCampaignDailyStatsRange(c, START, END);
      for (const s of Object.values(byDate)) for (const m of METRICS) live[m] += Number(s[m]) || 0;
    } catch (e) {
      console.log(`FETCH FAILED  ${c.name}: ${e.message}`);
      bad.push(c.name);
      continue;
    }

    const { rows: [stored] } = await query(
      `select coalesce(sum(spend),0) as spend, coalesce(sum(impressions),0) as impressions,
              coalesce(sum(clicks),0) as clicks, coalesce(sum(reach),0) as reach,
              coalesce(sum(leads),0) as leads
         from campaign_daily_metrics
        where campaign_id = $1 and metric_date >= $2 and metric_date <= $3`,
      [c.id, START, END]
    );

    // Spend is floating point on both sides, so compare to the paisa rather than exactly.
    const off = METRICS.filter(m => m === 'spend'
      ? Math.abs(money(live[m]) - money(stored[m])) > 0.01
      : Math.round(live[m]) !== Math.round(Number(stored[m])));

    if (off.length) {
      bad.push(c.name);
      console.log(`MISMATCH  ${c.name}`);
      for (const m of off) {
        console.log(`   ${m.padEnd(12)} linkedin=${String(money(live[m])).padStart(12)}   stored=${String(money(stored[m])).padStart(12)}`);
      }
    }

    for (const m of METRICS) { totals.live[m] += Number(live[m]); totals.stored[m] += Number(stored[m]); }
  }

  const fmt = o => METRICS.map(m => `${m}=${Math.round(o[m])}`).join('  ');
  console.log('\nlinkedin :', fmt(totals.live));
  console.log('stored   :', fmt(totals.stored));

  // Contamination markers that are wrong regardless of what LinkedIn currently returns.
  const { rows: [neg] } = await query(
    `select (select count(*) from campaign_daily_metrics
              where spend<0 or clicks<0 or impressions<0 or reach<0) as campaign,
            (select count(*) from asset_daily_metrics
              where spend<0 or clicks<0 or impressions<0 or reach<0) as asset`
  );
  const { rows: [mock] } = await query(
    `select count(*) as n from campaign_daily_metrics where source = 'mock'`
  );
  console.log(`\nnegative rows: campaign=${neg.campaign} asset=${neg.asset}   rows tagged mock: ${mock.n}`);

  if (bad.length) {
    console.log(`\n${bad.length} campaign(s) disagree with LinkedIn.`);
    console.log('Rebuild the window authoritatively:');
    console.log(`  curl -H "Authorization: Bearer $CRON_SECRET" \\`);
    console.log(`    ".../api/cron/sync?start=${START}&end=${END}&replace=1&skipImport=1"`);
    process.exit(1);
  }
  console.log('\nAll campaigns match LinkedIn exactly.');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
