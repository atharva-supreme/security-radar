import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compare, satisfies, versionsIn, lineOf, lineFix, anyFix, minimumOf } from '../src/semver.mjs';

test('minimumOf: the lowest version a dependency range can resolve to', () => {
  assert.equal(minimumOf('^0.35.5'), '0.35.5');
  assert.equal(minimumOf('^0.34.3 || ^0.35.5'), '0.34.3', 'the resolver may keep the lower alternative');
  assert.equal(minimumOf('~1.2.3'), '1.2.3');
  assert.equal(minimumOf('>=2.1.0 <3'), '2.1.0');
  assert.equal(minimumOf('1.2.3'), '1.2.3');
  assert.equal(minimumOf('*'), null);
  assert.equal(minimumOf('workspace:*'), null);
  assert.equal(minimumOf(undefined), null);
});

test('compare orders releases and prereleases', () => {
  assert.equal(compare('16.2.12', '16.4.1'), -1);
  assert.equal(compare('16.4.1', '16.4.1'), 0);
  assert.equal(compare('15.5.28', '15.5.27'), 1);
  assert.equal(compare('16.4.1-canary.3', '16.4.1'), -1);
  assert.equal(compare('v0.35.5', '0.35.4'), 1);
});

test('satisfies handles the ranges GitHub advisories emit', () => {
  // The October 14 Next.js advisories
  assert.equal(satisfies('16.2.12', '>= 16.0.0, <= 16.4.0'), true);
  assert.equal(satisfies('16.4.1', '>= 16.0.0, <= 16.4.0'), false);
  assert.equal(satisfies('15.5.27', '>= 10.0.0, < 15.5.28'), true);
  assert.equal(satisfies('15.5.28', '>= 10.0.0, < 15.5.28'), false);
  // sharp
  assert.equal(satisfies('0.34.5', '< 0.35.5'), true);
  assert.equal(satisfies('0.35.5', '< 0.35.5'), false);
  // short forms and exact
  assert.equal(satisfies('16.0.0', '>= 16'), true);
  assert.equal(satisfies('15.9.9', '>= 16'), false);
  assert.equal(satisfies('1.2.3', '= 1.2.3'), true);
  // repository advisories: space-separated comparators, no commas
  assert.equal(satisfies('16.2.12', '>=16.0.0 <= 16.4.0'), true);
  assert.equal(satisfies('16.2.12', '>= 10.0.0  <= 15.5.27'), false);
  assert.equal(satisfies('16.2.12', '>= 16.0.0'), true);
  // garbage never matches
  assert.equal(satisfies('not-a-version', '< 1.0.0'), false);
  assert.equal(satisfies('1.0.0', null), false);
});

test('versionsIn reads every version out of a fixed field, string or list', () => {
  assert.deepEqual(versionsIn('15.5.28, 16.4.1'), ['15.5.28', '16.4.1']);
  assert.deepEqual(versionsIn('16.3.?'), []);
  assert.deepEqual(versionsIn(['16.4.1', '15.5.28']), ['15.5.28', '16.4.1']);
  assert.deepEqual(versionsIn(null), []);
});

test('lineOf: major, or 0.minor for 0.x packages', () => {
  assert.equal(lineOf('16.3.5'), '16');
  assert.equal(lineOf('0.35.4'), '0.35');
  assert.equal(lineOf('junk'), null);
});

test('lineFix never downgrades, never picks a pre-release, never crosses the line', () => {
  assert.equal(lineFix(['15.5.28', '16.4.1'], '16.2.12'), '16.4.1');
  assert.equal(lineFix('15.5.28, 16.4.1', '15.5.27'), '15.5.28');
  assert.equal(lineFix(['15.5.28'], '16.2.12'), null, 'the only fix is below the install');
  assert.equal(lineFix(['0.24.52'], '0.27.10'), null, 'typebox: 0.24.52 is a downgrade');
  assert.equal(lineFix(['0.35.5'], '0.34.5'), null, '0.34 and 0.35 are different lines');
  assert.equal(lineFix(['0.34.6', '0.35.5'], '0.34.5'), '0.34.6');
  assert.equal(lineFix(['8.0.0-rc.6', '7.28.0'], '7.27.0'), '7.28.0');
  assert.equal(lineFix(['8.0.0-rc.6'], '7.27.0'), null, 'a pre-release is never a target');
  assert.equal(lineFix(['4.0.0', '4.2.1'], '3.0.4'), null);
  assert.equal(anyFix(['4.0.0', '4.2.1'], '3.0.4'), '4.0.0', 'the cross-major fallback is the lowest fix above');
  assert.equal(anyFix(['0.35.5'], '0.34.5'), '0.35.5');
});
