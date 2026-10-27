import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePackages, matchInstalled } from '../src/advisories.mjs';

// Shapes copied from the live API on 27 Oct 2026.

test('global entry with an exclusive upper bound yields its own fixed version', () => {
  const out = resolvePackages(
    [{ name: 'next', range: '>= 16.0.0', fixed: '16.3.?' }],
    [{ name: 'next', range: '>= 16.0.0, < 16.3.8', fixed: null }],
  );
  assert.deepEqual(out, [{ name: 'next', range: '>= 16.0.0, < 16.3.8', fixed: '16.3.8' }]);
});

test('global entry with an inclusive upper bound borrows the maintainer fixed version for its line', () => {
  const out = resolvePackages(
    [
      { name: 'next', range: '>= 10.0.0  <= 15.5.27', fixed: '15.5.28' },
      { name: 'next', range: '> 16.0.0 <= 16.4.0', fixed: '16.4.1' },
    ],
    [
      { name: 'next', range: '>= 10.0.0, <= 15.5.27', fixed: null },
      { name: 'next', range: '>= 16.0.0, <= 16.4.0', fixed: null },
    ],
  );
  assert.deepEqual(out, [
    { name: 'next', range: '>= 10.0.0, <= 15.5.27', fixed: '15.5.28' },
    { name: 'next', range: '>= 16.0.0, <= 16.4.0', fixed: '16.4.1' },
  ]);
});

test('repo-only entry with a fixed version gets an upper bound added', () => {
  const out = resolvePackages([{ name: 'next', range: '>=16.0.0 <= 16.4.0', fixed: '16.4.1' }], []);
  assert.deepEqual(out, [{ name: 'next', range: '>= 16.0.0, <= 16.4.0', fixed: '16.4.1' }]);
  const open = resolvePackages([{ name: 'next', range: '>= 16.0.0', fixed: '16.3.8' }], []);
  assert.deepEqual(open, [{ name: 'next', range: '>= 16.0.0, < 16.3.8', fixed: '16.3.8' }]);
});

test('repo-only entry with a placeholder fixed version stays open-ended', () => {
  const out = resolvePackages([{ name: 'next', range: '>= 16.0.0', fixed: '16.3.?' }], []);
  assert.deepEqual(out, [{ name: 'next', range: '>= 16.0.0', fixed: '16.3.?' }]);
});

test('matchInstalled reports one hit per install and picks the fixed version on the same line', () => {
  const packages = [
    { name: 'next', range: '>= 15.0.0, < 15.5.27', fixed: '15.5.27' },
    { name: 'next', range: '>= 16.0.0, < 16.3.8', fixed: '16.3.8' },
    { name: 'sharp', range: '< 0.35.5', fixed: '0.35.5' },
  ];
  const versions = new Map([['next', new Set(['16.2.12'])], ['sharp', new Set(['0.33.5', '0.34.5'])]]);
  const hits = matchInstalled(packages, versions).sort((a, b) => `${a.pkg}${a.installed}`.localeCompare(`${b.pkg}${b.installed}`));
  assert.deepEqual(hits, [
    { pkg: 'next', installed: '16.2.12', fixed: '16.3.8' },
    { pkg: 'sharp', installed: '0.33.5', fixed: '0.35.5' },
    { pkg: 'sharp', installed: '0.34.5', fixed: '0.35.5' },
  ]);
  assert.deepEqual(matchInstalled(packages, new Map([['next', new Set(['16.4.1'])]])), []);
});
