import { driftOf } from '../src/lockfile.mjs';
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

import { dependencyGraph } from '../src/lockfile.mjs';

test('dependencyGraph: pnpm v9 workspace, prod reachability and the declared dependency that pulls a package in', () => {
  const text = `
lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      vitest:
        specifier: ^3.0.0
        version: 3.2.4(vite@7.3.1)

  core:
    dependencies:
      jspdf:
        specifier: ^3.0.2
        version: 3.0.4
      next:
        specifier: 16.2.12
        version: 16.2.12(react@19.2.7)
    devDependencies:
      '@types/node':
        specifier: ^22.0.0
        version: 22.1.0

packages:

  dompurify@3.3.1:
    resolution: {integrity: sha512-x}

snapshots:

  jspdf@3.0.4:
    dependencies:
      dompurify: 3.3.1
    optionalDependencies:
      canvg: 3.0.11

  next@16.2.12(react@19.2.7):
    dependencies:
      react: 19.2.7
      sharp: 0.34.5

  vitest@3.2.4(vite@7.3.1):
    dependencies:
      vite: 7.3.1
      tinypool: 1.1.1
`;
  const g = dependencyGraph(text, 'web/pnpm-lock.yaml');
  assert.equal(g.kind, 'pnpm');
  assert.deepEqual(g.importers.sort(), ['.', 'core']);
  assert.equal(g.isProd('dompurify', '3.3.1'), true);
  assert.equal(g.isProd('sharp', '0.34.5'), true);
  assert.equal(g.isProd('tinypool', '1.1.1'), false, 'reachable from devDependencies only');
  assert.equal(g.isProd('@types/node', '22.1.0'), false);
  assert.equal(g.isProd('sharp', '0.33.0'), null, 'not in the lockfile');
  assert.deepEqual(g.via('dompurify', '3.3.1'), { direct: 'jspdf', importer: 'core', dev: false, depth: 1 });
  assert.deepEqual(g.via('next', '16.2.12'), { direct: 'next', importer: 'core', dev: false, depth: 0 });
  assert.deepEqual(g.via('tinypool', '1.1.1'), { direct: 'vitest', importer: '.', dev: true, depth: 1 });
  assert.equal(g.via('nothing', '1.0.0'), null);
});

test('dependencyGraph: package-lock v3 uses the dev flag and node resolution', () => {
  const json = {
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { dompurify: '^3.2.4', formik: '^2.4.0' }, devDependencies: { eslint: '^9.0.0' } },
      'node_modules/dompurify': { version: '3.2.6' },
      'node_modules/formik': { version: '2.4.6', dependencies: { 'lodash-es': '^4.17.21' } },
      'node_modules/lodash-es': { version: '4.17.21' },
      'node_modules/eslint': { version: '9.1.0', dev: true, dependencies: { 'js-yaml': '^4.1.0' } },
      'node_modules/js-yaml': { version: '3.14.1' },
      'node_modules/eslint/node_modules/js-yaml': { version: '4.1.0', dev: true },
    },
  };
  const g = dependencyGraph(JSON.stringify(json), 'checkout/package-lock.json');
  assert.equal(g.kind, 'npm');
  assert.equal(g.isProd('dompurify', '3.2.6'), true);
  assert.equal(g.isProd('js-yaml', '4.1.0'), false);
  assert.equal(g.isProd('lodash-es', '4.17.21'), true);
  assert.deepEqual(g.via('lodash-es', '4.17.21'), { direct: 'formik', importer: '.', dev: false, depth: 1 });
  assert.deepEqual(g.via('js-yaml', '4.1.0'), { direct: 'eslint', importer: '.', dev: true, depth: 1 });
  assert.equal(dependencyGraph('', 'yarn.lock').kind, null);
  assert.equal(dependencyGraph('{not json', 'package-lock.json').kind, null, 'a broken file is unknown, not fatal');
});

test('driftOf: compares each package.json with what its lockfile recorded; pnpm overrides are not drift', () => {
  const lockText = [
    "lockfileVersion: '9.0'",
    '',
    'overrides:',
    '  uuid: ^11.1.1',
    '  js-yaml@3.13.1: ^3.15.2',
    "  'a>adm-zip': ^0.6.1",
    '',
    'importers:',
    '',
    '  .:',
    '    dependencies:',
    '      next:',
    '        specifier: ^16.1.1',
    '        version: 16.1.5',
    '  core:',
    '    dependencies:',
    '      uuid:',
    '        specifier: ^11.1.1',
    '        version: 11.1.1',
    "      '@sanity/client':",
    '        specifier: ^7',
    '        version: 7.0.0',
    '    devDependencies:',
    '      vitest:',
    '        specifier: ^3',
    '        version: 3.0.0',
    '',
    'packages:',
    '',
    '  next@16.1.5:',
    '    resolution: {integrity: x}',
  ].join('\n');
  const manifests = {
    'web/package.json': { dependencies: { next: '^16.1.1' } },
    'web/core/package.json': { dependencies: { uuid: '^13.0.2', 'adm-zip': '^0.5.18', '@sanity/client': '^7.13.2', '@heroicons/react': '^2.2.0' }, devDependencies: { vitest: '^3' } },
  };
  assert.deepEqual(driftOf({ lockText, lockPath: 'web/pnpm-lock.yaml', manifests }), [
    { lockfile: 'web/pnpm-lock.yaml', manifest: 'web/core/package.json', package: '@sanity/client', declared: '^7.13.2', locked: '^7' },
    { lockfile: 'web/pnpm-lock.yaml', manifest: 'web/core/package.json', package: '@heroicons/react', declared: '^2.2.0', locked: null },
  ]);
  const npmLock = JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { a: '^1' } }, 'node_modules/a': { version: '1.0.0' } } });
  assert.deepEqual(driftOf({ lockText: npmLock, lockPath: 'package-lock.json', manifests: { 'package.json': { dependencies: { a: '^2' } } } }), [{ lockfile: 'package-lock.json', manifest: 'package.json', package: 'a', declared: '^2', locked: '^1' }]);
  assert.deepEqual(driftOf({ lockText: 'x', lockPath: 'yarn.lock', manifests: {} }), []);
});
