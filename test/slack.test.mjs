import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMessages, chunkRows, tableRows, projectSummary, esc } from '../src/slack.mjs';

const adv = (id, severity, pkg, extra = {}) => ({ id, severity, package: pkg, summary: `${pkg} issue <${id}>`, url: `https://example.test/${id}`, openDays: 10, isNew: false, early: false, malicious: false, hits: [], ...extra });
const app = (repo, branch, label, open = [], upgrades = [], extra = {}) => ({
  project: repo.split('/')[1], repo, branch, label, kind: 'app', ok: true, packages: 100, lockfile: `${label}/pnpm-lock.yaml`,
  open, counts: { critical: open.filter((o) => o.severity === 'critical').length, high: open.filter((o) => o.severity === 'high').length }, upgrades, notes: [], ...extra,
});

function sampleReport() {
  const openNext = [
    { id: 'A1', severity: 'critical', package: 'next', installed: '16.3.5', fixed: '16.4.1', isNew: true, early: false, openDays: 6 },
    { id: 'A2', severity: 'high', package: 'next', installed: '16.3.5', fixed: '16.4.1', isNew: false, early: true, openDays: 20 },
    { id: 'A3', severity: 'high', package: 'undici', installed: '7.29.0', fixed: '7.30.1', isNew: true, early: false, openDays: 1 },
    { id: 'A4', severity: 'low', package: 'deepmerge', installed: '4.3.1', fixed: null, isNew: false, early: false, openDays: 40 },
  ];
  const upNext = [
    { package: 'next', from: ['16.3.5'], transitive: [], to: '16.4.1', closes: 2, worst: 'critical' },
    { package: 'undici', from: ['7.29.0'], transitive: ['7.29.0'], to: '7.30.1', closes: 1, worst: 'high' },
    { package: 'deepmerge', from: ['4.3.1'], transitive: ['4.3.1'], to: null, closes: 1, worst: 'low' },
  ];
  return {
    status: 'RED', generatedAt: '2026-10-29T03:16:00Z',
    advisories: [
      adv('A1', 'critical', 'next', { isNew: true, hits: [{ project: 'catalent-sanity', branch: 'main', label: 'root', kind: 'app' }, { project: 'wp-site', branch: 'main', label: 'sass', kind: 'tooling' }] }),
      adv('A2', 'high', 'next', { early: true, hits: [{ project: 'catalent-sanity', branch: 'main', label: 'root', kind: 'app' }] }),
      adv('A3', 'high', 'undici', { isNew: true, hits: [{ project: 'catalent-sanity', branch: 'main', label: 'root', kind: 'app' }] }),
      adv('A4', 'low', 'deepmerge'),
    ],
    projects: [
      { project: 'catalent-sanity', branch: 'main', repo: 'Org/catalent-sanity', appStatus: 'RED' },
      { project: 'catalent-sanity', branch: 'staging', repo: 'Org/catalent-sanity', appStatus: 'GREEN' },
      { project: 'wp-site', branch: 'main', repo: 'Org/wp-site', appStatus: 'GREEN' },
      { project: 'vectorlabs', branch: 'main', repo: 'Org/vectorlabs', appStatus: 'GREEN' },
    ],
    apps: [
      app('Org/catalent-sanity', 'main', 'root', openNext, upNext),
      app('Org/catalent-sanity', 'staging', 'root'),
      app('Org/vectorlabs', 'main', 'web'),
      app('Org/vectorlabs', 'main', 'sanity'),
      { ...app('Org/wp-site', 'main', 'sass', openNext, upNext), kind: 'tooling' },
    ],
  };
}
const projects = { 'Org/catalent-sanity': 'Catalent', 'Org/vectorlabs': 'VectorLabs' };
const texts = (m) => m.blocks.filter((b) => b.type === 'section').map((b) => b.text.text);

test('summary, one message per affected project with a table per branch, then the clear list', () => {
  const msgs = buildMessages(sampleReport(), { projects, now: new Date('2026-10-29T04:00:00Z') });
  assert.equal(msgs.length, 3);
  const [summary, catalent, clear] = msgs;
  assert.match(summary.blocks[0].text.text, /1 of 2 projects affected · 3 critical\/high open across 4 advisories/);
  const issues = summary.blocks.find((b) => b.text?.text.startsWith('• '));
  assert.match(issues.text.text, /A1.*hits 1 apps in 1 projects.*\*NEW\*/); // the tooling hit on wp-site is not counted
  assert.match(issues.text.text, /&lt;A1&gt;/); // mrkdwn escaped

  // heading, main status + table, staging status + table, summary
  assert.deepEqual(catalent.blocks.map((b) => b.type), ['section', 'section', 'table', 'section', 'table', 'section']);
  assert.equal(catalent.blocks[0].text.text, '*:package: Catalent*');
  assert.match(catalent.blocks[1].text.text, /^`main` · :red_circle: \*RED\* · 1 critical, 2 high$/);
  assert.match(catalent.blocks[3].text.text, /^`staging` · :large_green_circle: \*GREEN\* · 0 critical, 0 high$/);
  const main = catalent.blocks[2];
  assert.equal(main.rows[0].map((c) => c.text).join('|'), 'App|Package|Installed|Upgrade to|Closes|Severity|Open|Direct');
  assert.equal(main.rows.length, 4); // header + 3 upgrades
  assert.ok(main.column_settings.every((c) => c.is_wrapped === false));
  const [label, pkg, installed, to, closes, severity, open, direct] = main.rows[1];
  assert.deepEqual([label.text, pkg.text, installed.text, to.text, closes.text, direct.text], ['root', 'next', '16.3.5', '16.4.1', '2', 'yes']);
  assert.deepEqual(severity.elements[0].elements[0], { type: 'link', url: 'https://example.test/A1', text: 'CRITICAL', style: { bold: true } });
  assert.equal(open.elements[0].elements.map((e) => e.text).join(''), '6 days · NEW');
  assert.equal(main.rows[2][7].text, 'no'); // undici is transitive
  assert.equal(main.rows[3][3].text, 'none yet');
  assert.equal(catalent.blocks[4].rows[1][1].text, 'clear');

  const summaryText = catalent.blocks[5].text.text;
  assert.match(summaryText, /^:memo: \*Summary\*\n/);
  assert.match(summaryText, /\*Fix first:\* next 16\.3\.5 → 16\.4\.1 closes 2 \(1 critical, 1 high\) on main; undici 7\.29\.0 → 7\.30\.1 closes 1 \(1 high\) on main\./);
  assert.match(summaryText, /\*New since yesterday:\* 2 on `main` \(next, undici\); `staging` clear\./);
  assert.match(summaryText, /\*Transitive, pnpm up will not move them:\* 2 of 3 packages\. pnpm overrides: undici@7\.30\.1\./); // deepmerge is transitive too but has no target
  assert.match(summaryText, /\*No fix published yet:\* deepmerge 4\.3\.1 on main\. Remove, replace, or wait\./);
  assert.ok(!JSON.stringify(msgs).includes('Note:'));

  assert.match(clear.blocks[0].text.text, /\*Clear:\* VectorLabs/);
  assert.ok(!JSON.stringify(msgs).includes('wp-site'));
});

test('--only returns just that project, matched by repo, short name or display name', () => {
  for (const only of ['Org/catalent-sanity', 'catalent-sanity', 'catalent']) {
    const msgs = buildMessages(sampleReport(), { projects, only });
    assert.equal(msgs.length, 1);
    assert.match(msgs[0].text, /^Security Radar · Catalent/);
  }
  assert.throws(() => buildMessages(sampleReport(), { projects, only: 'nope' }), /no reported project/);
});

test('all clear is a single line', () => {
  const r = sampleReport();
  r.apps = r.apps.filter((a) => a.repo === 'Org/vectorlabs');
  const msgs = buildMessages(r, { projects: { 'Org/vectorlabs': 'VectorLabs' } });
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].blocks[0].text.text, /1 projects clear, no action needed/);
});

test('long projects split across messages by rows and by characters; tables stay per branch; nothing trimmed', () => {
  const advisories = new Map([['X', adv('X', 'high', 'p')]]);
  const open = [{ id: 'X', severity: 'high', package: 'p', openDays: 1 }];
  const many = Array.from({ length: 250 }, (_, i) => ({ package: `p${i}`, from: ['1.0.0'], transitive: [], to: '1.0.1', closes: 1, worst: 'high' }));
  const rows = tableRows([{ ok: true, label: 'web', open: many.map((u) => ({ ...open[0], package: u.package })), upgrades: many }], advisories);
  assert.equal(rows.length, 250);
  const chunks = chunkRows(rows);
  assert.equal(chunks.reduce((n, c) => n + c.length, 0), 250);
  assert.ok(chunks.every((c) => c.length <= 90));
  const wide = Array.from({ length: 50 }, () => ({ package: 'x'.repeat(300), from: ['1.0.0'], transitive: [], to: '1.0.1', closes: 1, worst: 'high' }));
  const wideChunks = chunkRows(tableRows([{ ok: true, label: 'web', open, upgrades: wide }], advisories));
  assert.ok(wideChunks.length > 1);
  assert.equal(wideChunks.flat().length, 50);

  // 250 short rows fit one message in characters, so the 90-row tables continue inside the same message.
  const r = sampleReport();
  r.apps[0].upgrades = many;
  r.apps[0].open = many.map((u) => ({ ...open[0], package: u.package }));
  const one = buildMessages(r, { projects, only: 'catalent' });
  assert.equal(one.length, 1);
  assert.deepEqual(one[0].blocks.map((b) => b.type), ['section', 'section', 'table', 'section', 'table', 'section', 'table', 'section', 'table', 'section']);
  assert.match(one[0].blocks[3].text.text, /^`main` · continued$/);
  assert.match(one[0].blocks[7].text.text, /^`staging` · /);

  // 250 long rows exceed the characters one message may carry: several messages, main first, staging last.
  const long = many.map((u) => ({ ...u, package: `${u.package}-${'x'.repeat(60)}` }));
  r.apps[0].upgrades = long;
  r.apps[0].open = long.map((u) => ({ ...open[0], package: u.package }));
  const msgs = buildMessages(r, { projects, only: 'catalent' });
  assert.ok(msgs.length >= 3, `expected several messages, got ${msgs.length}`);
  assert.match(msgs[0].blocks[0].text.text, new RegExp(`Catalent \\(1/${msgs.length}\\)`));
  assert.match(msgs[1].blocks[1].text.text, /^`main` · continued$/);
  const tables = msgs.flatMap((m) => m.blocks.filter((b) => b.type === 'table'));
  assert.equal(tables.reduce((n, t) => n + t.rows.length - 1, 0), 251); // 250 main rows + the staging "clear" row
  assert.ok(tables.every((t) => t.rows.length - 1 <= 90));
  for (const m of msgs) {
    const chars = m.blocks.filter((b) => b.type === 'table').flatMap((t) => t.rows.flat()).reduce((n, c) => n + (c.type === 'rich_text' ? c.elements[0].elements.reduce((a, e) => a + e.text.length, 0) : c.text.length), 0);
    assert.ok(chars <= 10000, `message has ${chars} cell characters`);
  }
  assert.ok(texts(msgs.at(-1)).some((t) => t.startsWith(':memo: *Summary*'))); // summary on the last part only
  assert.ok(!texts(msgs[0]).some((t) => t.startsWith(':memo:')));
});

test('projectSummary wording for an npm lockfile and an unchanged branch', () => {
  const open = [{ id: 'A3', severity: 'high', package: 'undici', openDays: 3, isNew: false }];
  const perBranch = [{ branch: 'main', apps: [{ ok: true, label: 'root', lockfile: 'package-lock.json', open, upgrades: [{ package: 'undici', from: ['7.29.0'], transitive: ['7.29.0'], to: '7.30.1', closes: 1, worst: 'high' }] }] }];
  const lines = projectSummary(perBranch);
  assert.equal(lines.length, 3);
  assert.match(lines[1], /`main` unchanged, 1 open/);
  assert.match(lines[2], /npm update will not move them.*npm overrides: undici@7\.30\.1/);
});

test('esc escapes mrkdwn control characters', () => {
  assert.equal(esc('a < b & c > d'), 'a &lt; b &amp; c &gt; d');
});
