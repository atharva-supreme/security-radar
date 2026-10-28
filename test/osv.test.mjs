import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trim, fixedFor } from '../src/osv.mjs';
import { githubRepoFrom } from '../src/npm.mjs';

test('osv trim keeps what the report needs', () => {
  const v = {
    id: 'GHSA-2464-fhr4-w9xw', summary: 'RCE via SVG', published: '2026-10-22T15:52:53Z', modified: '2026-10-22T16:00:09Z',
    aliases: ['CVE-2026-96889'], database_specific: { severity: 'CRITICAL' },
    references: [{ type: 'WEB', url: 'https://github.com/vercel/next.js/security/advisories/GHSA-2464-fhr4-w9xw' }],
    affected: [
      { package: { ecosystem: 'npm', name: 'next' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '10.0.0' }, { fixed: '15.5.28' }] }] },
      { package: { ecosystem: 'npm', name: 'next' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '16.0.0' }, { fixed: '16.4.1' }] }] },
      { package: { ecosystem: 'PyPI', name: 'next' }, ranges: [] },
    ],
  };
  const t = trim(v);
  assert.equal(t.severity, 'critical');
  assert.equal(t.cve, 'CVE-2026-96889');
  assert.equal(t.url, 'https://github.com/vercel/next.js/security/advisories/GHSA-2464-fhr4-w9xw');
  assert.equal(t.packages.length, 2);
  assert.equal(fixedFor({ fixed: ['15.5.28', '16.4.1'] }, '16.2.12'), '16.4.1');
  assert.equal(fixedFor({ fixed: ['15.5.28', '16.4.1'] }, '15.5.27'), '15.5.28');
  assert.equal(fixedFor({ fixed: ['15.5.28'] }, '16.2.12'), null);
  assert.equal(trim({ id: 'MAL-2026-1', affected: [], references: [] }).severity, 'critical');
  assert.equal(trim({ id: 'MAL-2026-1', affected: [], references: [] }).malicious, true);
});

test('npm repository field to owner/repo', () => {
  assert.equal(githubRepoFrom('git+https://github.com/vercel/next.js.git'), 'vercel/next.js');
  assert.equal(githubRepoFrom({ url: 'git://github.com/lovell/sharp.git' }), 'lovell/sharp');
  assert.equal(githubRepoFrom({ url: 'https://github.com/facebook/react', directory: 'packages/react' }), 'facebook/react');
  assert.equal(githubRepoFrom('https://gitlab.com/x/y'), null);
  assert.equal(githubRepoFrom(undefined), null);
});
