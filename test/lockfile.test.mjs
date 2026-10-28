import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installedVersions, declaredNode } from '../src/lockfile.mjs';

const names = ['next', 'sharp', '@sanity/client', 'react'];
const versionsOf = (map, name) => [...(map.get(name) ?? [])].sort();

test('pnpm-lock v9 keys', () => {
  const text = `
lockfileVersion: '9.0'

importers:
  core:
    dependencies:
      next:
        specifier: 16.2.12
        version: 16.2.12(react-dom@19.2.7(react@19.2.7))(react@19.2.7)

packages:

  '@sanity/client@7.26.2':
    resolution: {integrity: sha512-x}

  next@16.2.12:
    resolution: {integrity: sha512-x}

  react@19.2.7:
    resolution: {integrity: sha512-x}

  sharp@0.34.5:
    resolution: {integrity: sha512-x}

  next-auth@5.0.0-beta.30:
    resolution: {integrity: sha512-x}

snapshots:

  next@16.2.12(react-dom@19.2.7(react@19.2.7))(react@19.2.7):
    dependencies:
      sharp: 0.34.5
`;
  const found = installedVersions(text, 'web/pnpm-lock.yaml', names);
  assert.deepEqual(versionsOf(found, 'next'), ['16.2.12']);
  assert.deepEqual(versionsOf(found, 'sharp'), ['0.34.5']);
  assert.deepEqual(versionsOf(found, '@sanity/client'), ['7.26.2']);
  assert.deepEqual(versionsOf(found, 'react'), ['19.2.7']);
});

test('pnpm-lock v6 keys with leading slash', () => {
  const text = `
lockfileVersion: '6.0'

packages:

  /next@15.5.20(react@19.0.0):
    resolution: {integrity: sha512-x}

  /sharp@0.33.5:
    resolution: {integrity: sha512-x}
`;
  const found = installedVersions(text, 'pnpm-lock.yaml', names);
  assert.deepEqual(versionsOf(found, 'next'), ['15.5.20']);
  assert.deepEqual(versionsOf(found, 'sharp'), ['0.33.5']);
});

test('package-lock.json', () => {
  const text = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'app' },
      'node_modules/next': { version: '16.3.8' },
      'node_modules/next/node_modules/sharp': { version: '0.35.4' },
      'node_modules/@sanity/client': { version: '7.20.0' },
    },
  });
  const found = installedVersions(text, 'package-lock.json', names);
  assert.deepEqual(versionsOf(found, 'next'), ['16.3.8']);
  assert.deepEqual(versionsOf(found, 'sharp'), ['0.35.4']);
  assert.deepEqual(versionsOf(found, '@sanity/client'), ['7.20.0']);
});

test('yarn.lock classic and berry', () => {
  const text = `
"next@^15.0.0":
  version "15.5.27"
  resolved "https://registry.yarnpkg.com/next/-/next-15.5.27.tgz"

"@sanity/client@npm:^7.0.0":
  version: 7.26.2
  resolution: "@sanity/client@npm:7.26.2"

sharp@0.35.5:
  version "0.35.5"
`;
  const found = installedVersions(text, 'yarn.lock', names);
  assert.deepEqual(versionsOf(found, 'next'), ['15.5.27']);
  assert.deepEqual(versionsOf(found, '@sanity/client'), ['7.26.2']);
  assert.deepEqual(versionsOf(found, 'sharp'), ['0.35.5']);
});

test('declaredNode prefers engines, falls back to nvmrc', () => {
  assert.equal(declaredNode({ packageJsonText: '{"engines":{"node":">=22"}}' }), '>=22');
  assert.equal(declaredNode({ packageJsonText: '{}', nvmrcText: '24.2.0\n' }), '24.2.0');
  assert.equal(declaredNode({}), null);
});

import { directVersions } from '../src/lockfile.mjs';

test('directVersions: pnpm importers say what the app declares itself', () => {
  const text = `
lockfileVersion: '9.0'

importers:
  core:
    dependencies:
      '@sanity/client':
        specifier: ^7.24.0
        version: 7.24.0
      next:
        specifier: 16.2.12
        version: 16.2.12(react@19.2.7)
    devDependencies:
      react:
        specifier: 19.2.7
        version: 19.2.7

packages:

  sharp@0.34.5:
    resolution: {integrity: sha512-x}
`;
  const d = directVersions(text, 'web/pnpm-lock.yaml', names);
  assert.deepEqual([...d.get('next')], ['16.2.12']);
  assert.deepEqual([...d.get('@sanity/client')], ['7.24.0']);
  assert.deepEqual([...d.get('react')], ['19.2.7']);
  assert.deepEqual([...d.get('sharp')], []);
});

test('directVersions: package-lock root dependencies', () => {
  const json = { packages: { '': { dependencies: { next: '16.2.12' } }, 'node_modules/next': { version: '16.2.12' }, 'node_modules/sharp': { version: '0.34.5' } } };
  const d = directVersions(JSON.stringify(json), 'package-lock.json', names);
  assert.deepEqual([...d.get('next')], ['16.2.12']);
  assert.deepEqual([...d.get('sharp')], []);
  assert.equal(directVersions('', 'yarn.lock', names), null);
});
