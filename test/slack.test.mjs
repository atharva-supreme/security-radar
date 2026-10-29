import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMessages, chunkRows, tableRows, esc } from '../src/slack.mjs';

const adv = (id, severity, pkg, extra = {}) => ({ id, severity, package: pkg, summary: `${pkg} issue <${id}>`, url: `https://example.test/${id}`, openDays: 10, isNew: false, early: false, malicious: false, hits: [], ...extra });
const app = (repo, branch, label, open = [], upgrades = [], extra = {}) => ({
  project: repo.split('/')[1], repo, branch, label, kind: 'app', ok: true, packages: 100,
  open, counts: { critical: open.filter((o) => o.severity === 'critical').length, high: open.filter((o) => o.severity === 'high').length }, upgrades, notes: [], ...extra,
});

function sampleReport() {
  const openNext = [{ id: 'A1', severity: 'critical', package: 'next', installed: '16.3.5', fixed: '16.4.1', isNew: true, early: false, openDays: 6 }, { id: 'A2', severity: 'high', package: 'next', installed: '16.3.5', fixed: '16.4.1', isNew: false, early: true, openDays: 20 }];
  const upNext = [{ package: 'next', from: ['16.3.5'], transitive: [], to: '16.4.1', closes: 2, worst: 'critical' }];
  return {
    status: 'RED', generatedAt: '2026-10-29T03:16:00Z',
    advisories: [adv('A1', 'critical', 'next', { isNew: true, hits: [{ project: 'catalent-sanity', branch: 'main', label: 'root', kind: 'app' }, { project: 'wp-site', branch: 'main', label: 'sass', kind: 'tooling' }] }), adv('A2', 'high', 'next', { early: true, hits: [{ project: 'catalent-sanity', branch: 'main', label: 'root', kind: 'app' }] })],
    projects: [
      { project: 'catalent-sanity', branch: 'main', repo: 'Org/catalent-sanity', appStatus: 'RED' },
      { project: 'catalent-sanity', branch: 'staging', repo: 'Org/catalent-sanity', appStatus: 'GREEN' },
      { project: 'wp-site', branch: 'main', repo: 'Org/wp-site', appStatus: 'GREEN' },
      { project: 'vectorlabs', branch: 'main', repo: 'Org/vectorlabs', appStatus: 'GREEN' },
    ],
    apps: [
      app('Org/catalent-sanity', 'main', 'root', openNext, upNext, { notes: ['next is a direct dependency.'] }),
      app('Org/catalent-sanity', 'staging', 'root'),
      app('Org/vectorlabs', 'main', 'web'),
      app('Org/vectorlabs', 'main', 'sanity'),
      { ...app('Org/wp-site', 'main', 'sass', openNext, upNext), kind: 'tooling' },
    ],
  };
}
const projects = { 'Org/catalent-sanity': 'Catalent', 'Org/vectorlabs': 'VectorLabs' };

test('summary, one table message per affected project, then the clear list; unlisted repos never appear', () => {
  const msgs = buildMessages(sampleReport(), { projects, now: new Date('2026-10-29T04:00:00Z') });
  assert.equal(msgs.length, 3);
  const [summary, catalent, clear] = msgs;
  assert.match(summary.blocks[0].text.text, /1 of 2 projects affected · 2 critical\/high open across 2 advisories/);
  const issues = summary.blocks.find((b) => b.text?.text.startsWith('• '));
  assert.match(issues.text.text, /A1.*hits 1 apps in 1 projects.*\*NEW\*/); // the tooling hit on wp-site is not counted
  assert.match(issues.text.text, /&lt;A1&gt;/); // mrkdwn escaped
  assert.match(catalent.blocks[0].text.text, /\*:package: Catalent\*\n`main` · :red_circle: \*RED\* · 1 critical, 1 high\n`staging` · :large_green_circle: \*GREEN\*/);
  const table = catalent.blocks[1];
  assert.equal(table.type, 'table');
  assert.equal(table.rows.length, 3); // header, main/next, staging/clear
  assert.ok(table.column_settings.every((c) => c.is_wrapped === false));
  const [branch, label, pkg, installed, to, closes, severity, open] = table.rows[1];
  assert.deepEqual([branch.text, label.text, pkg.text, installed.text, to.text, closes.text], ['main', 'root', 'next', '16.3.5', '16.4.1', '2']);
  assert.deepEqual(severity.elements[0].elements[0], { type: 'link', url: 'https://example.test/A1', text: 'CRITICAL', style: { bold: true } });
  assert.equal(open.elements[0].elements.map((e) => e.text).join(''), '6 days · NEW');
  assert.equal(table.rows[2][2].text, 'clear');
  assert.match(catalent.blocks[2].text.text, /:memo: _Note:_\n_• next is a direct dependency\._/);
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

test('long projects split by rows and by characters, never trimmed', () => {
  const advisories = new Map([['X', adv('X', 'high', 'p')]]);
  const open = [{ id: 'X', severity: 'high', package: 'p', openDays: 1 }];
  const many = Array.from({ length: 250 }, (_, i) => ({ package: `p${i}`, from: ['1.0.0'], transitive: [], to: '1.0.1', closes: 1, worst: 'high' }));
  const rows = tableRows([{ branch: 'main', apps: [{ ok: true, label: 'web', open: many.map((u) => ({ ...open[0], package: u.package })), upgrades: many }] }], advisories);
  assert.equal(rows.length, 250);
  const chunks = chunkRows(rows);
  assert.equal(chunks.reduce((n, c) => n + c.length, 0), 250);
  assert.ok(chunks.every((c) => c.length <= 90));
  const wide = Array.from({ length: 50 }, (_, i) => ({ package: 'x'.repeat(300), from: ['1.0.0'], transitive: [], to: '1.0.1', closes: 1, worst: 'high' }));
  const wideRows = tableRows([{ branch: 'main', apps: [{ ok: true, label: 'web', open, upgrades: wide }] }], advisories);
  const wideChunks = chunkRows(wideRows);
  assert.ok(wideChunks.length > 1);
  assert.equal(wideChunks.flat().length, 50);
  const r = sampleReport();
  r.apps[0].upgrades = many; r.apps[0].open = many.map((u) => ({ ...open[0], package: u.package }));
  const msgs = buildMessages(r, { projects, only: 'catalent' });
  assert.equal(msgs.length, 3);
  assert.match(msgs[0].blocks[0].text.text, /Catalent \(1\/3\)/);
  assert.ok(msgs.at(-1).blocks.some((b) => b.text?.text.startsWith(':memo:'))); // notes on the last part only
  assert.ok(!msgs[0].blocks.some((b) => b.text?.text.startsWith(':memo:')));
});

test('esc escapes mrkdwn control characters', () => {
  assert.equal(esc('a < b & c > d'), 'a &lt; b &amp; c &gt; d');
});
