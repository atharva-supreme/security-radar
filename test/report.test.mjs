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
  assert.deepEqual(web.upgrades, [{ package: 'next', from: ['16.2.12'], to: '16.4.1', closes: 2 }]);
  assert.equal(web.command, 'cd web && pnpm up next@16.4.1');
  assert.equal(r.apps[1].open.length, 0);
  assert.equal(r.newNotAffecting.length, 1);
  assert.equal(r.newNotAffecting[0].id, 'GHSA-cccc');
  assert.equal(r.apps[0].project, 'r');
  assert.deepEqual(r.projects.map((p) => [p.project, p.status, p.critical, p.affectedApps]), [['r', 'RED', 1, ['web']]]);
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
