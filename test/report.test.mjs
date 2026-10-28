import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, affects } from '../src/report.mjs';

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
  open: [
    { id: 'GHSA-aaaa', package: 'next', installed: '16.2.12', fixed: '16.4.1', early: false },
    { id: 'GHSA-bbbb', package: 'next', installed: '16.2.12', fixed: '16.3.6', early: false },
    { id: 'GHSA-eeee', package: 'sharp', installed: '0.33.5', fixed: '0.35.5', early: true },
    { id: 'GHSA-eeee', package: 'sharp', installed: '0.34.5', fixed: '0.35.5', early: true },
    { id: 'GHSA-gggg', package: 'sanitize-html', installed: '2.17.8', fixed: '2.18.0', early: false },
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
  const sharp = w.upgrades.find((u) => u.package === 'sharp');
  assert.deepEqual(sharp.transitive, ['0.33.5', '0.34.5']);
  assert.equal(sharp.worst, 'critical');
  const sh = w.upgrades.find((u) => u.package === 'sanitize-html');
  assert.equal(sh.to, '2.18.1', 'climbs past 2.18.0, which has its own advisory');
  assert.match(w.notes[0], /sharp 0.33.5, 0.34.5 is not a direct dependency of web/);
  assert.equal(w.command, 'cd web && pnpm up next@16.4.1 sanitize-html@2.18.1', 'transitive-only packages are left out of the command');
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

test('report: nothing open is GREEN', () => {
  const r = buildReport({ now, apps: [sanity], advisories: adv });
  assert.equal(r.status, 'GREEN');
  assert.equal(r.apps[0].command, null);
});
