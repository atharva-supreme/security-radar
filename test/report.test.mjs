import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, affects, unitsFor } from '../src/report.mjs';

const now = new Date('2026-10-27T02:00:00Z');
const advisories = {
  'GHSA-aaaa': { severity: 'critical', summary: 'RCE', cve: null, url: 'u1', published_at: '2026-10-14T17:47:00Z', firstSeen: '2026-10-27T01:30:00Z', sources: ['osv', 'repo'], packages: [{ name: 'next', introduced: ['16.0.0'], fixed: ['16.4.1'], versions: [] }] },
  'GHSA-bbbb': { severity: 'low', summary: 'minor', cve: 'CVE-1', url: 'u2', published_at: '2026-08-25T00:00:00Z', firstSeen: '2026-10-20T00:00:00Z', sources: ['osv'], packages: [{ name: 'next', introduced: ['0'], fixed: ['16.3.6'], versions: [] }] },
  'GHSA-cccc': { severity: 'high', summary: 'elsewhere', cve: null, url: 'u3', published_at: '2026-10-26T12:00:00Z', firstSeen: '2026-10-27T01:30:00Z', sources: ['osv'], packages: [{ name: 'sharp', introduced: ['0'], fixed: ['0.30.0'], versions: [] }] },
  'GHSA-eeee': { severity: 'critical', summary: 'maintainer only', url: 'u4', published_at: '2026-10-20T02:00:00Z', firstSeen: '2026-10-27T00:00:00Z', sources: ['repo'], packages: [], repoPackages: [{ name: 'sharp', range: '< 0.35.5', fixed: '0.35.5' }] },
  'GHSA-ffff': { severity: 'moderate', summary: 'fix of the fix', url: 'u5', published_at: '2026-10-21T00:00:00Z', firstSeen: '2026-10-21T00:00:00Z', sources: ['osv'], packages: [{ name: 'sanitize-html', introduced: ['2.18.0'], fixed: ['2.18.1'], versions: [] }] },
};
const web = {
  repo: 'o/r', branch: 'main', label: 'web', kind: 'app', lockfile: 'web/pnpm-lock.yaml', ok: true,
  versions: new Map([['next', new Set(['16.2.12'])], ['sharp', new Set(['0.33.5', '0.34.5'])], ['sanitize-html', new Set(['2.17.8'])]]),
  direct: new Map([['next', new Set(['16.2.12'])], ['sanitize-html', new Set(['2.17.8'])]]),
  graph: { importers: ['.'], isProd: (name) => name !== 'sanitize-html', via: (name) => (name === 'sharp' ? { direct: 'next', importer: '.', dev: false, depth: 1 } : null) },
  open: [
    { id: 'GHSA-aaaa', package: 'next', installed: '16.2.12', fixed: '16.4.1', fixedAny: '16.4.1', early: false },
    { id: 'GHSA-bbbb', package: 'next', installed: '16.2.12', fixed: '16.3.6', fixedAny: '16.3.6', early: false },
    { id: 'GHSA-eeee', package: 'sharp', installed: '0.33.5', fixed: null, fixedAny: '0.35.5', early: true },
    { id: 'GHSA-eeee', package: 'sharp', installed: '0.34.5', fixed: null, fixedAny: '0.35.5', early: true },
    { id: 'GHSA-gggg', package: 'sanitize-html', installed: '2.17.8', fixed: '2.18.0', fixedAny: '2.18.0', early: false },
  ],
};
const sanity = { repo: 'o/r', branch: 'main', label: 'sanity', kind: 'app', lockfile: 'sanity/pnpm-lock.yaml', ok: true, versions: new Map([['sanity', new Set(['6.9.0'])]]), direct: new Map(), open: [] };
const adv = { ...advisories, 'GHSA-gggg': { severity: 'low', summary: 'x', url: 'u', published_at: '2026-10-20T00:00:00Z', firstSeen: '2026-10-20T00:00:00Z', sources: ['osv'], packages: [{ name: 'sanitize-html', introduced: ['2.17.7'], fixed: ['2.18.0'], versions: [] }] } };

test('affects: OSV events and repo ranges', () => {
  assert.equal(affects(advisories['GHSA-aaaa'], 'next', '16.2.12'), true);
  assert.equal(affects(advisories['GHSA-aaaa'], 'next', '16.4.1'), false);
  assert.equal(affects(advisories['GHSA-aaaa'], 'next', '15.5.27'), false);
  assert.equal(affects(advisories['GHSA-eeee'], 'sharp', '0.34.5'), true);
  assert.equal(affects(advisories['GHSA-eeee'], 'sharp', '0.35.5'), false);
});

test('report: status, flags, upgrades, notes, command, distinct advisories', () => {
  const r = buildReport({ now, apps: [web, sanity], advisories: adv, published: new Map([['next@16.4.1', true]]) });
  assert.equal(r.status, 'RED');
  assert.equal(r.summary.open, 5);
  assert.equal(r.summary.distinct, 4);
  assert.equal(r.summary.critical, 3);
  assert.equal(r.summary.early, 2);
  assert.equal(r.summary.newOpen, 3);
  const w = r.apps[0];
  assert.equal(w.open[0].id, 'GHSA-eeee', 'critical first, newest first');
  const aaaa = w.open.find((o) => o.id === 'GHSA-aaaa');
  
  assert.equal(aaaa.isNew, true);
  assert.equal(aaaa.early, false);
  assert.equal(aaaa.direct, true);
  assert.equal(aaaa.fixedOnNpm, true);
  assert.equal(aaaa.openDays, 12);
  assert.equal(aaaa.prod, true);
  const sharps = w.upgrades.filter((u) => u.package === 'sharp');
  assert.deepEqual(sharps.map((u) => [u.line, u.from, u.to, u.toMajor, u.direct, u.tier, u.reason]), [
    ['0.33', ['0.33.5'], null, null, false, 'P1', 'fix is another major, not a direct dependency'],
    ['0.34', ['0.34.5'], null, null, false, 'P1', 'fix is another major, not a direct dependency'],
  ], 'two 0.x lines, neither has an in-line fix, sharp is transitive: no override across lines');
  assert.deepEqual(sharps[0].via, { direct: 'next', importer: '.', dev: false, depth: 1 });
  const next = w.upgrades.find((u) => u.package === 'next');
  assert.deepEqual([next.to, next.closes, next.tier, next.direct, next.prod], ['16.4.1', 2, 'P0', true, true]);
  const sh = w.upgrades.find((u) => u.package === 'sanitize-html');
  assert.equal(sh.to, '2.18.1', 'climbs past 2.18.0, which has its own advisory');
  assert.equal(sh.tier, 'P2', 'devDependencies only');
  assert.equal(sh.reason, 'dev-only');
  assert.equal(w.command, 'cd web && pnpm up next@16.4.1', 'P0 direct packages only');
  assert.equal(w.overrides, null);
  assert.deepEqual(w.tiers, { P0: 1, P1: 2, P2: 1 });
  const main = r.projects.find((p) => p.project === 'r' && p.branch === 'main');
  assert.deepEqual(main.health, { score: 58, status: 'RED', critical: 1, high: 0, p1: 1, p2: 1 });
  assert.equal(r.apps[1].open.length, 0);
  assert.equal(r.newNotAffecting.map((n) => n.id).join(), 'GHSA-cccc');
  const a = r.advisories.find((x) => x.id === 'GHSA-eeee');
  assert.equal(a.apps, 1, 'two installed versions in one lockfile is one app');
  assert.equal(a.hits.length, 2);
  assert.equal(a.projectBranches, 1);
  assert.deepEqual(a.projects, ['r']);
  assert.equal(r.advisories[0].id, 'GHSA-eeee', 'critical first, newest first');
});

test('report: one project row per (repo, branch), worst first, tooling kept apart', () => {
  const tooling = { repo: 'o/wp', branch: 'main', label: 'wp-content/sass', kind: 'tooling', lockfile: 'wp-content/sass/package-lock.json', ok: true, versions: new Map([['next', new Set(['16.2.12'])]]), direct: null, open: [{ id: 'GHSA-aaaa', package: 'next', installed: '16.2.12', fixed: '16.4.1', early: false }] };
  const stagingClean = { ...sanity, branch: 'staging', label: 'web', open: [] };
  const broken = { repo: 'o/broken', branch: 'main', label: 'web', kind: 'app', lockfile: 'web/pnpm-lock.yaml', ok: false };
  const r = buildReport({ now, apps: [stagingClean, web, sanity, tooling, broken], advisories: adv });
  assert.equal(r.status, 'UNKNOWN');
  assert.deepEqual(r.projects.map((p) => [p.project, p.branch, p.status, p.appStatus]), [
    ['r', 'main', 'RED', 'RED'], ['wp', 'main', 'RED', 'GREEN'], ['broken', 'main', 'UNKNOWN', 'UNKNOWN'], ['r', 'staging', 'GREEN', 'GREEN'],
  ]);
  assert.equal(r.checked.appKinds.tooling, 1);
  assert.equal(r.apps[3].open.length, 0, 'tooling rows carry counts, not per-advisory rows');
  assert.equal(r.apps[3].openOmitted, 1);
  assert.equal(r.apps[3].counts.critical, 1);
  const a = r.advisories.find((x) => x.id === 'GHSA-aaaa');
  assert.equal(a.apps, 2, 'web on main and the tooling lockfile');
  assert.deepEqual(a.projects, ['r', 'wp']);
});

test('unitsFor: a transitive package with no in-line fix is "closed by" the parent bump when the parent target requires the fixed child', () => {
  const via = { direct: 'next', importer: '.', dev: false, depth: 1 };
  const rows = [
    { id: 'N1', severity: 'critical', package: 'next', installed: '16.3.4', fixed: '16.4.1', fixedAny: '16.4.1', direct: true, prod: true, openDays: 10 },
    { id: 'S1', severity: 'high', package: 'sharp', installed: '0.34.5', fixed: null, fixedAny: '0.35.5', direct: false, prod: true, via, openDays: 20 },
  ];
  const closed = unitsFor(rows, {}, { manifests: new Map([['next@16.4.1', { dependencies: {}, optionalDependencies: { sharp: '^0.35.5' } }]]) });
  const sharp = closed.find((u) => u.package === 'sharp');
  assert.deepEqual([sharp.tier, sharp.to, sharp.fixAbove, sharp.reason], ['P1', null, '0.35.5', 'closed by next 16.4.1']);
  assert.deepEqual(sharp.closedBy, { package: 'next', version: '16.4.1', range: '^0.35.5', resolves: '0.35.5' });
  // a range that may still resolve to the vulnerable line does not count
  const open = unitsFor(rows, {}, { manifests: new Map([['next@16.4.1', { dependencies: {}, optionalDependencies: { sharp: '^0.34.3 || ^0.35.5' } }]]) });
  assert.equal(open.find((u) => u.package === 'sharp').closedBy, null);
  assert.equal(unitsFor(rows, {}).find((u) => u.package === 'sharp').reason, 'fix is another major, not a direct dependency');
});

test('report: nothing open is GREEN', () => {
  const r = buildReport({ now, apps: [sanity], advisories: adv });
  assert.equal(r.status, 'GREEN');
  assert.equal(r.apps[0].command, null);
  assert.deepEqual(r.projects[0].health, { score: 100, status: 'GREEN', critical: 0, high: 0, p1: 0, p2: 0 });
});

test('unitsFor: a direct dependency with no in-line fix gets a labelled major bump; a transitive one does not', () => {
  const rows = (direct) => [
    { id: 'J1', severity: 'critical', package: 'jspdf', installed: '3.0.4', fixed: null, fixedAny: '4.0.0', direct, prod: true, openDays: 10 },
    { id: 'J2', severity: 'high', package: 'jspdf', installed: '3.0.4', fixed: null, fixedAny: '4.2.1', direct, prod: true, openDays: 5 },
    { id: 'J3', severity: 'low', package: 'jspdf', installed: '3.0.4', fixed: null, fixedAny: null, direct, prod: true, openDays: 5 },
  ];
  const [d] = unitsFor(rows(true), {});
  assert.deepEqual([d.to, d.toMajor, d.closes, d.tier, d.reason, d.worst], [null, '4.2.1', 2, 'P0', 'major bump', 'critical']);
  const [t] = unitsFor(rows(false), {});
  assert.deepEqual([t.to, t.toMajor, t.tier], [null, null, 'P1']);
  // one in-line fix covering every critical/high: P0 on the line even if a low has no fix
  const [u] = unitsFor([
    { id: 'D1', severity: 'high', package: 'dompurify', installed: '3.2.6', fixed: '3.4.17', fixedAny: '3.4.17', direct: true, prod: true, openDays: 1 },
    { id: 'D2', severity: 'low', package: 'dompurify', installed: '3.2.6', fixed: null, fixedAny: null, direct: true, prod: true, openDays: 1 },
  ], {});
  assert.deepEqual([u.to, u.closes, u.open, u.tier, u.lineComplete], ['3.4.17', 1, 2, 'P0', true]);
  // the tooling list and dev-only win over severity
  const [v] = unitsFor([{ id: 'V1', severity: 'critical', package: 'vite', installed: '7.3.1', fixed: '7.3.7', fixedAny: '7.3.7', direct: false, prod: true, openDays: 1 }], {}, { isTooling: (n) => n === 'vite' });
  assert.deepEqual([v.tier, v.reason], ['P2', 'build tooling']);
  const [w] = unitsFor([{ id: 'V1', severity: 'critical', package: 'esbuild', installed: '0.19.1', fixed: '0.19.2', fixedAny: '0.19.2', direct: false, prod: false, openDays: 1 }], {});
  assert.deepEqual([w.tier, w.reason], ['P2', 'dev-only']);
});
