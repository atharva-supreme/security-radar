import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compare, satisfies } from '../src/semver.mjs';

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
