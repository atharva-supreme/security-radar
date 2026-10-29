import test from 'node:test';
import assert from 'node:assert/strict';
import { scanRows } from '../src/scope.mjs';

const repos = [
  { repo: 'Org/catalent-sanity', lockfile: 'pnpm-lock.yaml', kind: 'app' },
  { repo: 'Org/raybiotech', lockfile: 'web/pnpm-lock.yaml', kind: 'app' },
  { repo: 'Org/raybiotech', lockfile: 'migration/pnpm-lock.yaml', kind: 'tooling' },
  { repo: 'Org/some-wordpress', lockfile: 'wp-content/sass/package-lock.json', kind: 'tooling' },
  { repo: 'Org/some-magento', lockfile: 'package-lock.json' }, // kind defaults to app
];
const report = { projects: { 'Org/catalent-sanity': 'Catalent', 'Org/raybiotech': 'RayBiotech' } };

test('reported mode keeps only app lockfiles of reported repositories', () => {
  const { mode, rows, skipped } = scanRows({ scan: 'reported', report, repos });
  assert.equal(mode, 'reported');
  assert.deepEqual(rows.map((r) => r.lockfile), ['pnpm-lock.yaml', 'web/pnpm-lock.yaml']);
  assert.equal(skipped, 3);
});

test('all mode and a missing setting scan every row', () => {
  assert.equal(scanRows({ scan: 'all', report, repos }).rows.length, 5);
  assert.equal(scanRows({ report, repos }).rows.length, 5);
  assert.equal(scanRows({ scan: 'reported', repos }).rows.length, 0); // reported mode with no reported list scans nothing
});
