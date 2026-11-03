#!/usr/bin/env node
// Stores the day's Claude tiers and Health Scores in MySQL. Runs after the filter step and after
// scripts/store.mjs, whose scan row it attaches to. Idempotent: loading a day again replaces its rows.
//
//   node scripts/store-tiers.mjs data/reports/2026-11-03.json --verdicts data/verdicts/2026-11-03.json
//   ... --dry-run      count the rows, connect to nothing
//
// Needs MYSQL_URL. The two tables are created on first use.

import { readFile } from 'node:fs/promises';
import { historyRows, HISTORY_DDL } from '../src/history.mjs';

const args = process.argv.slice(2);
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--verdicts');
if (!file) { console.error('usage: node scripts/store-tiers.mjs <report.json> --verdicts <verdicts.json> [--dry-run]'); process.exit(2); }

const report = JSON.parse(await readFile(file, 'utf8'));
const day = /(\d{4}-\d{2}-\d{2})/.exec(file)?.[1] ?? report.generatedAt.slice(0, 10);
const verdictsPath = value('--verdicts') ?? `data/verdicts/${day}.json`;
const verdicts = await readFile(verdictsPath, 'utf8').then(JSON.parse).catch(() => null);
if (!verdicts) console.log(`no verdicts at ${verdictsPath}: storing scanner tiers, marked as not filtered`);
const watchlist = JSON.parse(await readFile(new URL('../watchlist.json', import.meta.url), 'utf8'));
const { health, tiers } = historyRows(report, { projects: watchlist.report?.projects ?? {}, verdicts });

if (args.includes('--dry-run')) {
  console.log(`${day}: ${health.length} project_health rows, ${tiers.length} package_tiers rows, nothing stored`);
  for (const h of health) console.log(`  ${h[1]} · ${h[2]} · ${h[3]} ${h[4]} · P0 ${h[7]} · P1 ${h[8]} · P2 ${h[9]}`);
  process.exit(0);
}
if (!process.env.MYSQL_URL) { console.error('MYSQL_URL not set'); process.exit(2); }

const { default: mysql } = await import('mysql2/promise');
const u = new URL(process.env.MYSQL_URL);
const conn = await mysql.createConnection({
  host: u.hostname, port: Number(u.port || 3306),
  user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
  database: u.pathname.slice(1), charset: 'utf8mb4',
});

async function load() {
  for (const ddl of HISTORY_DDL) await conn.query(ddl);
  const [scan] = await conn.query('SELECT id FROM scans WHERE scan_date = ?', [day]);
  if (!scan.length) throw new Error(`no scan row for ${day}: the store step must run first`);
  const scanId = scan[0].id;
  await conn.beginTransaction();
  await conn.query('DELETE FROM project_health WHERE scan_id = ?', [scanId]);
  await conn.query('DELETE FROM package_tiers WHERE scan_id = ?', [scanId]);
  if (health.length) await conn.query('INSERT INTO project_health (scan_id, project, display_name, branch, score, status, critical_n, high_n, p0_n, p1_n, p2_n, filtered, not_assessed, what_to_do) VALUES ?', [health.map((h) => [scanId, ...h])]);
  for (let i = 0; i < tiers.length; i += 1000) {
    await conn.query('INSERT INTO package_tiers (scan_id, row_hash, project, branch, app, package, version_line, tier, scanner_tier, assessed, reason, severity, installed, fix_to, direct, prod, via, decided_on) VALUES ?', [tiers.slice(i, i + 1000).map((t) => [scanId, ...t])]);
  }
  await conn.commit();
  console.log(`stored ${day}: scan #${scanId}, ${health.length} project_health rows, ${tiers.length} package_tiers rows`);
}

try {
  try {
    await load();
  } catch (e) {
    await conn.rollback().catch(() => {});
    if (e.errno !== 1615) throw e;
    console.log('ER_NEED_REPREPARE from the server, retrying once');
    await load();
  }
} finally {
  await conn.end();
}
