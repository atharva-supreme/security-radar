import test from 'node:test';
import assert from 'node:assert/strict';
import { historyRows, HISTORY_DDL } from '../src/history.mjs';
import { buildMessages } from '../src/slack.mjs';

const unit = (over) => ({ package: 'x', line: '1', from: ['1.0.0'], to: '1.0.1', lineComplete: true, toMajor: null, closes: 1, worst: 'high', worstId: 'A', direct: true, prod: true, via: { direct: 'x' }, openDays: 3, advisories: ['A'], tier: 'P0', reason: 'fix in line', ...over });
const app = (branch, label, upgrades) => ({ repo: 'Org/a', project: 'a', branch, label, kind: 'app', ok: true, lockfile: `${label}/pnpm-lock.yaml`, importers: ['.'], upgrades });
const report = {
  generatedAt: '2026-11-03T02:30:00Z',
  advisories: [{ id: 'A', severity: 'high', summary: 'a', url: 'https://x/A' }],
  apps: [
    app('main', 'web', [unit({ package: 'next', line: '16', to: '16.4.1', worst: 'critical' }), unit({ package: 'qs', line: '6', tier: 'P1', worst: 'moderate' }), unit({ package: 'vite', line: '7', tier: 'P2' })]),
    app('staging', 'web', [unit({ package: 'qs', line: '6', tier: 'P1', worst: 'moderate' })]),
  ],
};
const projects = { 'Org/a': 'Alpha' };
const line = (branch, pkg, ln, tier, action, reason) => ({ app: 'web', apps: ['web'], package: pkg, line: ln, branch, tier, action, assessed: true, decidedOn: '2026-11-02', reason });
const verdicts = { projects: { 'Org/a': { ok: true, notAssessed: 0, todo: ['Run it.', 'Merge staging.'], lines: [
  line('main', 'next', '16', 'P0', 'now', 'framework'), line('main', 'qs', '6', 'P2', 'skip', 'never imported'), line('main', 'vite', '7', 'P0', 'now', 'raised by Claude'), line('staging', 'qs', '6', 'P1', 'later', 'staging uses it'),
] } } };

test('historyRows: one health row per branch plus overall, matching the Slack header', () => {
  const { health } = historyRows(report, { projects, verdicts });
  assert.deepEqual(health.map((h) => [h[0], h[1], h[2]]), [['a', 'Alpha', 'staging'], ['a', 'Alpha', 'main'], ['a', 'Alpha', 'overall']]);
  const byBranch = Object.fromEntries(health.map((h) => [h[2], h]));
  const header = buildMessages(report, { projects, verdicts })[0].blocks[0].text.text;
  assert.ok(header.includes(`staging ${byBranch.staging[3]} · main ${byBranch.main[3]} · overall ${byBranch.overall[3]}`), header);
  assert.equal(byBranch.overall[3], Math.min(byBranch.staging[3], byBranch.main[3]));
  assert.equal(byBranch.main[7], 2, 'P0 lines');
  assert.equal(byBranch.main[9], 1, 'P2 packages');
  assert.equal(byBranch.overall[12], 'Run it.\nMerge staging.');
  assert.equal(byBranch.main[12], null);
  assert.equal(byBranch.main[10], 1, 'filtered');
});

test('historyRows: tier rows keep Claude\'s tier beside the scanner\'s, per branch', () => {
  const { tiers } = historyRows(report, { projects, verdicts });
  assert.equal(tiers.length, 4);
  const row = (branch, pkg) => tiers.find((t) => t[2] === branch && t[4] === pkg);
  assert.deepEqual([row('main', 'vite')[6], row('main', 'vite')[7], row('main', 'vite')[8], row('main', 'vite')[9]], ['P0', 'P2', 1, 'raised by Claude']);
  assert.deepEqual([row('main', 'qs')[6], row('staging', 'qs')[6]], ['P2', 'P1'], 'each branch has its own tier');
  assert.equal(row('main', 'next')[12], '16.4.1');
  assert.equal(row('main', 'next')[16], '2026-11-02');
  assert.equal(new Set(tiers.map((t) => t[0])).size, 4, 'row hashes are unique');
});

test('historyRows: no verdict stores scanner tiers, marked as not filtered and not assessed', () => {
  const { health, tiers } = historyRows(report, { projects });
  assert.ok(health.every((h) => h[10] === 0));
  assert.deepEqual(tiers.find((t) => t[4] === 'vite').slice(6, 9), ['P2', 'P2', 0]);
});

test('HISTORY_DDL: both tables, created only if missing, removed with their scan', () => {
  assert.equal(HISTORY_DDL.length, 2);
  for (const ddl of HISTORY_DDL) { assert.match(ddl, /^CREATE TABLE IF NOT EXISTS/); assert.match(ddl, /ON DELETE CASCADE/); }
});
