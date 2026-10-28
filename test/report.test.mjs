import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from '../src/report.mjs';

const now = new Date('2026-10-27T02:00:00Z');
const watchlist = { packages: [{ name: 'next' }, { name: 'sharp' }] };
const advisories = {
  'GHSA-aaaa': { severity: 'critical', summary: 'RCE', cve: null, url: 'u1', published_at: '2026-10-14T17:47:00Z', firstSeen: '2026-10-27T01:30:00Z', packages: [{ name: 'next', range: '>= 16.0.0, <= 16.4.0', fixed: '16.4.1' }] },
  'GHSA-bbbb': { severity: 'low', summary: 'minor', cve: 'CVE-1', url: 'u2', published_at: '2026-08-25T00:00:00Z', firstSeen: '2026-10-20T00:00:00Z', packages: [{ name: 'next', range: '< 16.3.6', fixed: '16.3.6' }] },
  'GHSA-cccc': { severity: 'high', summary: 'elsewhere', cve: null, url: 'u3', published_at: '2026-10-26T12:00:00Z', firstSeen: '2026-10-27T01:30:00Z', packages: [{ name: 'sharp', range: '< 0.30.0', fixed: '0.30.0' }] },
};
const apps = [
  { repo: 'o/r', lockfile: 'web/pnpm-lock.yaml', label: 'web', ok: true, versions: new Map([['next', ['16.2.12']], ['sharp', ['0.34.5']]]) },
  { repo: 'o/r', lockfile: 'sanity/pnpm-lock.yaml', label: 'sanity', ok: true, versions: new Map([['sanity', ['6.9.0']]]) },
];

test('report: status, upgrades, command, new flags', () => {
  const r = buildReport({ now, apps, advisories, watchlist, published: new Map([['next@16.4.1', true]]) });
  assert.equal(r.status, 'RED');
  assert.equal(r.summary.open, 2);
  assert.equal(r.summary.critical, 1);
  assert.equal(r.summary.newOpen, 1);
  const web = r.apps[0];
  assert.equal(web.open[0].id, 'GHSA-aaaa');
  assert.equal(web.open[0].isNew, true);
  assert.equal(web.open[0].fixedOnNpm, true);
  assert.deepEqual(web.upgrades, [{ package: 'next', from: ['16.2.12'], transitive: [], to: '16.4.1', closes: 2, worst: 'critical' }]);
  assert.equal(web.command, 'cd web && pnpm up next@16.4.1');
  assert.equal(r.apps[1].open.length, 0);
  assert.equal(r.newNotAffecting.length, 1);
  assert.equal(r.newNotAffecting[0].id, 'GHSA-cccc');
  assert.equal(r.apps[0].project, 'r');
  assert.deepEqual(r.projects.map((p) => [p.project, p.status, p.critical, p.affectedApps]), [['r', 'RED', 1, ['web']]]);
});

test('report: early, open-days, direct and transitive facts', () => {
  const adv = {
    'GHSA-e': { severity: 'critical', summary: 'rce', url: 'u', published_at: '2026-10-20T02:00:00Z', firstSeen: '2026-10-27T00:00:00Z', sources: ['repo:lovell/sharp'], packages: [{ name: 'sharp', range: '< 0.35.5', fixed: '0.35.5' }] },
    'GHSA-r': { severity: 'high', summary: 'dos', url: 'u', published_at: '2026-10-01T02:00:00Z', firstSeen: '2026-10-01T02:00:00Z', sources: ['repo:vercel/next.js', 'global'], packages: [{ name: 'next', range: '< 16.4.1', fixed: '16.4.1' }] },
  };
  const app = {
    repo: 'o/r', branch: 'staging', lockfile: 'web/pnpm-lock.yaml', label: 'web', ok: true,
    versions: new Map([['next', ['16.2.12']], ['sharp', ['0.33.5', '0.34.5']]]),
    direct: new Map([['next', new Set(['16.2.12'])], ['sharp', new Set()]]),
  };
  const r = buildReport({ now, apps: [app], advisories: adv, watchlist });
  const byId = Object.fromEntries(r.apps[0].open.map((o) => [`${o.id}@${o.installed}`, o]));
  assert.equal(byId['GHSA-e@0.33.5'].early, true);
  assert.equal(byId['GHSA-r@16.2.12'].early, false);
  assert.equal(byId['GHSA-e@0.33.5'].openDays, 7);
  assert.equal(byId['GHSA-r@16.2.12'].direct, true);
  assert.equal(byId['GHSA-e@0.34.5'].direct, false);
  const sharp = r.apps[0].upgrades.find((u) => u.package === 'sharp');
  assert.deepEqual(sharp.transitive, ['0.33.5', '0.34.5']);
  assert.equal(sharp.worst, 'critical');
  assert.match(r.apps[0].notes[0], /sharp 0.33.5, 0.34.5 is not a direct dependency of web/);
  assert.equal(r.summary.early, 2);
  assert.equal(r.summary.oldestCriticalOpenDays, 26);
  assert.equal(r.projects[0].branch, 'staging');
  assert.equal(r.projects[0].early, 2);
});

test('report: projects are summarised one row per repo, worst first', () => {
  const other = { repo: 'o/clean', lockfile: 'pnpm-lock.yaml', label: 'root', ok: true, versions: new Map([['next', ['16.4.1']]]) };
  const broken = { repo: 'o/broken', lockfile: 'web/pnpm-lock.yaml', label: 'web', ok: false };
  const r = buildReport({ now, apps: [other, ...apps, broken], advisories, watchlist });
  assert.equal(r.status, 'UNKNOWN');
  assert.deepEqual(r.projects.map((p) => [p.project, p.status]), [['r', 'RED'], ['broken', 'UNKNOWN'], ['clean', 'GREEN']]);
  assert.equal(r.checked.projects, 3);
});

test('report: upgrade target climbs past a fix that has its own advisory', () => {
  const adv = {
    'GHSA-one': { severity: 'low', summary: 'a', url: 'u', published_at: '2026-10-20T00:00:00Z', firstSeen: '2026-10-20T00:00:00Z', packages: [{ name: 'sanitize-html', range: '>= 2.17.7, < 2.18.0', fixed: '2.18.0' }] },
    'GHSA-two': { severity: 'moderate', summary: 'b', url: 'u', published_at: '2026-10-21T00:00:00Z', firstSeen: '2026-10-21T00:00:00Z', packages: [{ name: 'sanitize-html', range: '>= 2.18.0, < 2.18.1', fixed: '2.18.1' }] },
  };
  const app = { repo: 'o/r', lockfile: 'web/pnpm-lock.yaml', label: 'web', ok: true, versions: new Map([['sanitize-html', new Set(['2.17.8'])]]) };
  const r = buildReport({ now, apps: [app], advisories: adv, watchlist });
  assert.equal(r.apps[0].open.length, 1);
  assert.deepEqual(r.apps[0].installed, { 'sanitize-html': ['2.17.8'] });
  assert.equal(r.apps[0].upgrades[0].to, '2.18.1');
  assert.equal(r.apps[0].command, 'cd web && pnpm up sanitize-html@2.18.1');
});

test('report: unreadable lockfile makes status UNKNOWN', () => {
  const r = buildReport({ now, apps: [{ ...apps[0], ok: false }], advisories, watchlist, warnings: ['lockfile 404'] });
  assert.equal(r.status, 'UNKNOWN');
  assert.equal(r.apps[0].ok, false);
});

test('report: nothing open is GREEN', () => {
  const r = buildReport({ now, apps: [apps[1]], advisories, watchlist });
  assert.equal(r.status, 'GREEN');
  assert.equal(r.apps[0].command, null);
});
