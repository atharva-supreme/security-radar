#!/usr/bin/env node
// Loads one day's report into MySQL.   node scripts/store.mjs data/reports/2026-10-29.json
// Idempotent: the same date loaded twice replaces that day's rows. Needs MYSQL_URL.

import { readFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';

const file = process.argv[2];
if (!file) { console.error('usage: node scripts/store.mjs <report.json>'); process.exit(2); }
if (!process.env.MYSQL_URL) { console.error('MYSQL_URL not set'); process.exit(2); }

const r = JSON.parse(await readFile(file, 'utf8'));
const day = /(\d{4}-\d{2}-\d{2})/.exec(file)?.[1] ?? r.generatedAt.slice(0, 10);
const dt = (iso) => (iso ? new Date(iso).toISOString().slice(0, 19).replace('T', ' ') : null);
const bit = (v) => (v === null || v === undefined ? null : v ? 1 : 0);

const u = new URL(process.env.MYSQL_URL);
const conn = await mysql.createConnection({
  host: u.hostname, port: Number(u.port || 3306),
  user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
  database: u.pathname.slice(1), charset: 'utf8mb4',
});

try {
  await conn.beginTransaction();
  await conn.execute('DELETE FROM scans WHERE scan_date = ?', [day]); // cascades to findings and app_counts
  const s = r.summary;
  const [ins] = await conn.execute(
    `INSERT INTO scans (scan_date, generated_at, status, open_total, distinct_total, critical_n, high_n, moderate_n, low_n, new_open, early_n, malicious_n, packages_n, apps_n, projects_n)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [day, dt(r.generatedAt), r.status, s.open, s.distinct, s.critical, s.high, s.moderate, s.low, s.newOpen, s.early, s.malicious ?? 0, r.checked.packages ?? 0, r.checked.apps ?? 0, r.checked.projects ?? 0],
  );
  const scanId = ins.insertId;

  // advisories: insert new, refresh last_seen (and severity, in case it was upgraded)
  const advRows = r.advisories.map((a) => [a.id, a.severity, bit(a.malicious) ?? 0, a.cve ?? null, a.package, (a.summary ?? '').slice(0, 512), (a.url ?? '').slice(0, 512), dt(a.published_at), day, day]);
  for (let i = 0; i < advRows.length; i += 500) {
    await conn.query(
      `INSERT INTO advisories (id, severity, malicious, cve, package, summary, url, published_at, first_seen, last_seen) VALUES ?
       ON DUPLICATE KEY UPDATE severity = VALUES(severity), summary = VALUES(summary), url = VALUES(url), last_seen = VALUES(last_seen)`,
      [advRows.slice(i, i + 500)],
    );
  }

  const findingRows = [];
  const countRows = [];
  for (const a of r.apps) {
    const c = a.counts ?? {};
    countRows.push([scanId, a.project, a.branch ?? '', a.label, a.kind, bit(a.ok) ?? 0, a.packages ?? 0, c.critical ?? 0, c.high ?? 0, c.moderate ?? 0, c.low ?? 0, a.command ?? null]);
    for (const o of a.open ?? []) {
      findingRows.push([scanId, a.project, a.branch ?? '', a.label, a.kind, o.id, o.severity, o.package, o.installed, o.fixed ?? null, bit(o.fixedOnNpm), bit(o.direct), bit(o.early) ?? 0, bit(o.isNew) ?? 0, o.openDays ?? null]);
    }
  }
  for (let i = 0; i < countRows.length; i += 500) {
    await conn.query('INSERT INTO app_counts (scan_id, project, branch, app, kind, ok, packages_n, critical_n, high_n, moderate_n, low_n, command) VALUES ?', [countRows.slice(i, i + 500)]);
  }
  for (let i = 0; i < findingRows.length; i += 1000) {
    await conn.query('INSERT IGNORE INTO findings (scan_id, project, branch, app, kind, advisory_id, severity, package, installed, fixed, fixed_on_npm, direct, early, is_new, open_days) VALUES ?', [findingRows.slice(i, i + 1000)]);
  }
  await conn.commit();
  console.log(`stored ${day}: scan #${scanId}, ${advRows.length} advisories, ${findingRows.length} findings, ${countRows.length} app rows`);
} catch (e) {
  await conn.rollback();
  throw e;
} finally {
  await conn.end();
}
