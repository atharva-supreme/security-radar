import test from 'node:test';
import assert from 'node:assert/strict';
import { candidatesFor, factIds, promptInput, validateDecisions, buildVerdict, applyVerdict, isUnused, factId, validateBody } from '../src/filter.mjs';

const unit = (over) => ({ package: 'x', line: '1', from: ['1.0.0'], to: '1.0.1', lineComplete: true, toMajor: null, closes: 1, open: 1, critical: 0, high: 1, worst: 'high', worstId: 'A', direct: true, prod: true, via: { direct: 'x', importer: '.', dev: false, depth: 0 }, tooling: false, openDays: 3, isNew: false, early: false, advisories: ['A'], tier: 'P0', reason: 'fix in line', ...over });
const app = (label, branch, upgrades) => ({ repo: 'Org/r', project: 'r', branch, label, kind: 'app', ok: true, lockfile: `${label}/pnpm-lock.yaml`, packages: 10, importers: ['.'], upgrades });
const report = {
  advisories: [{ id: 'A', severity: 'high', summary: 'a', url: 'https://x/A' }, { id: 'B', severity: 'critical', summary: 'b', url: 'https://x/B' }],
  apps: [
    app('web', 'main', [
      unit({ package: 'dompurify', line: '3', from: ['3.4.11'], to: '3.4.17', worst: 'critical', worstId: 'B', critical: 1, advisories: ['B', 'A'], direct: false }),
      unit({ package: 'jspdf', line: '3', from: ['3.0.4'], to: null, lineComplete: false, toMajor: '4.2.1', worst: 'critical', worstId: 'B', reason: 'major bump' }),
      unit({ package: 'qs', line: '6', worst: 'moderate', tier: 'P1', reason: 'moderate/low' }),
      unit({ package: 'vite', line: '7', tier: 'P2', reason: 'build tooling', tooling: true }),
      unit({ package: 'eslint', line: '9', tier: 'P2', reason: 'dev-only', prod: false, tooling: true }),
    ]),
    app('root', 'main', [unit({ package: 'dompurify', line: '3', from: ['3.3.2'], to: '3.4.17', worst: 'critical', worstId: 'B', critical: 1, advisories: ['B'], direct: false })]),
    app('web', 'staging', [
      unit({ package: 'qs', line: '6', worst: 'moderate', tier: 'P1', reason: 'moderate/low' }),
      unit({ package: 'ws', line: '8', from: ['8.19.0'], to: '8.21.0', direct: false, via: { direct: '@sanity/cli', importer: '.', dev: false, depth: 3 } }),
    ]),
  ],
};
const usage = {
  packages: { jspdf: { count: 1, imports: ['web/core/lib/pdf.ts:1 import jsPDF'], mentions: 0 }, qs: { count: 0, imports: [], mentions: 0 }, dompurify: { count: 0, imports: [], mentions: 0 } },
  signals: {},
  branches: { staging: { packages: { ws: { count: 3, imports: ['web/x.ts:1 import ws'], mentions: 0 }, qs: { count: 0, imports: [], mentions: 0 } }, signals: {} } },
};
const input = (u = usage) => candidatesFor(report, { repo: 'Org/r', name: 'R', day: '2026-11-03', usage: u });

test('candidatesFor: nothing is filtered before Claude, tooling and dev-only included, per branch', () => {
  const i = input();
  assert.deepEqual(i.candidates.map((c) => [c.app, c.package]), [['web, root', 'dompurify'], ['web', 'jspdf'], ['web', 'qs'], ['web', 'vite'], ['web', 'eslint']]);
  assert.deepEqual(i.staging.map((c) => [c.branch, c.package]), [['staging', 'qs'], ['staging', 'ws']]);
  assert.deepEqual(i.candidates[0].installed, ['3.4.11', '3.3.2']);
  assert.equal(i.staging[1].usage.count, 3, 'staging reads the staging scan');
  assert.equal(i.stagingUsageScanned, true);
});

test('promptInput: identical facts on both branches are one item; tiers and open days are not shown to Claude', () => {
  const i = input();
  const qs = i.candidates.find((c) => c.package === 'qs');
  assert.equal(qs.id, i.staging.find((c) => c.package === 'qs').id, 'same facts, same id');
  const p = promptInput(i, factIds(i));
  assert.equal(p.candidates.filter((c) => c.package === 'qs').length, 1);
  assert.deepEqual(p.candidates.find((c) => c.package === 'qs').branches, ['main', 'staging']);
  const dom = p.candidates.find((c) => c.package === 'dompurify');
  assert.deepEqual(dom.advisories.map((a) => a.id), ['B', 'A']);
  for (const hidden of ['scanTier', 'tier', 'openDays', 'isNew', 'tooling']) assert.ok(!(hidden in dom), `${hidden} is not sent`);
});

test('factId: stable across days, changes only when a fact that matters changes', () => {
  const c = input().candidates[1];
  assert.equal(factId('Org/r', c), factId('Org/r', { ...c, installed: ['3.0.9'], closes: 9 }), 'a patch moving does not re-open the decision');
  assert.notEqual(factId('Org/r', c), factId('Org/r', { ...c, to: '9.9.9' }));
  assert.notEqual(factId('Org/r', c), factId('Org/r', { ...c, worst: 'high' }));
  assert.notEqual(factId('Org/r', c), factId('Org/r', { ...c, advisoryIds: ['B', 'NEW'] }), 'a new advisory re-opens it');
  assert.notEqual(factId('Org/r', c), factId('Org/r', { ...c, usage: { count: 0, mentions: 0 } }), 'code stopped using it');
  assert.equal(factId('Org/r', c), factId('Org/r', { ...c, usage: { count: 99, mentions: 0 } }), 'import count alone does not');
});

test('validateDecisions: unknown ids dropped, bad tiers left undecided, moderate capped at P1', () => {
  const i = input();
  const id = (pkg) => i.candidates.find((c) => c.package === pkg).id;
  const { decisions, corrections } = validateDecisions({ decisions: [
    { id: id('jspdf'), tier: 'P0', reason: 'our pdf code calls it' },
    { id: id('qs'), tier: 'P0', reason: 'moderate' },
    { id: id('vite'), tier: 'maybe', reason: 'x' },
    { id: 'ghost', tier: 'P0', reason: 'invented' },
  ] }, i);
  assert.equal(decisions[id('jspdf')].tier, 'P0');
  assert.equal(decisions[id('qs')].tier, 'P1');
  assert.ok(!(id('vite') in decisions));
  assert.ok(!('ghost' in decisions));
  assert.equal(corrections.length, 3);
});

test('buildVerdict: every candidate gets a line per branch; an undecided one falls back to the scan tier and is counted', () => {
  const i = input();
  const id = (pkg) => i.candidates.find((c) => c.package === pkg).id;
  const { lines, notAssessed } = buildVerdict(i, { [id('qs')]: { tier: 'P2', reason: 'never imported' }, [id('vite')]: { tier: 'P0', reason: 'Claude can raise a tooling package' } });
  assert.equal(lines.length, 7);
  assert.equal(notAssessed, 4);
  const line = (branch, pkg) => lines.find((l) => l.branch === branch && l.package === pkg);
  assert.equal(line('main', 'qs').tier, 'P2');
  assert.equal(line('staging', 'qs').tier, 'P2', 'same fact id, same answer on both branches');
  assert.equal(line('main', 'vite').action, 'now');
  assert.equal(line('main', 'jspdf').tier, 'P0');
  assert.match(line('main', 'jspdf').reason, /not assessed/);
  assert.equal(line('main', 'jspdf').to, '4.2.1');
});

test('applyVerdict: each branch reads its own lines, Claude\'s tier replaces the scan tier, merged apps fan out', () => {
  const verdict = { lines: [
    { app: 'web, root', apps: ['web', 'root'], package: 'dompurify', line: '3', branch: 'main', tier: 'P1', action: 'later', reason: 'studio' },
    { app: 'web', apps: ['web'], package: 'dompurify', line: '3', branch: 'staging', tier: 'P0', action: 'now', reason: 'live' },
  ] };
  const units = [unit({ package: 'dompurify', line: '3' }), unit({ package: 'other', line: '1', tier: 'P2' })];
  const main = applyVerdict(units, verdict, 'root', 'main');
  assert.deepEqual([main[0].tier, main[0].action, main[0].verdictReason], ['P1', 'later', 'studio']);
  assert.deepEqual([main[1].tier, main[1].action], ['P2', null], 'no line: scan tier kept');
  assert.equal(applyVerdict(units, verdict, 'web', 'staging')[0].action, 'now');
  assert.equal(applyVerdict(units, verdict, 'root', 'staging')[0].action, null);
});

test('isUnused: direct, prod package with zero imports and zero mentions; implicitUse exempt', () => {
  const u = unit({ package: 'dompurify', direct: true, prod: true });
  assert.equal(isUnused(u, { count: 0, imports: [], mentions: 0 }), true);
  assert.equal(isUnused(u, { count: 0, imports: [], mentions: 1 }), false, 'named in a config or script');
  assert.equal(isUnused(u, { count: 2, imports: ['a.ts:1'] }), false);
  assert.equal(isUnused(u, null), false, 'no usage scan, no claim');
  assert.equal(isUnused({ ...u, direct: false }, { count: 0, mentions: 0 }), false, 'transitive packages cannot be removed');
  assert.equal(isUnused({ ...u, prod: false }, { count: 0, mentions: 0 }), false);
  assert.equal(isUnused({ ...u, tooling: true }, { count: 0, mentions: 0 }), false, 'a build tool can run with no import, so removal is not claimed safe');
  assert.equal(isUnused({ ...u, package: 'sharp' }, { count: 0, mentions: 0 }, ['sharp']), false, 'loaded by the framework by name');
});

test('candidatesFor: no staging scan means no usage claim for staging', () => {
  const i = input({ packages: usage.packages, signals: {} });
  assert.equal(i.staging[1].usage, null);
  assert.equal(i.stagingUsageScanned, false);
  assert.equal(i.candidates.find((c) => c.package === 'jspdf').unused, false);
});

test('validateBody: lines, counts and footer must match exactly; commands must match; filler is refused', () => {
  const expected = {
    stagingLines: ['• web · zod 4.2.0 → 4.6.6 · closes 3 · HIGH · open 31 days · direct'],
    mainSameAsStaging: false,
    mainLines: ['• same fix as staging: zod 4.2.0'],
    unused: [],
    outOfSync: [],
    tierLine: 'P1 · 1 package for later · P2 · 2 packages, no action',
    required: { tokens: ['zod@4.6.6', '@auth/core@0.41'], packages: ['next-auth'], merge: true },
  };
  const facts = { versions: ['4.2.0', '4.6.6', '0.41.3'] };
  const todo = ['Run on staging · web: `cd web && pnpm up -r zod@4.6.6`.', 'Add to pnpm.overrides on staging · web: `"@auth/core@0.41": "0.41.3"`.', 'Merge staging into main. That closes all 1 fixes.', 'Harden session checks: next-auth 5 has no published fix.'];
  const good = { ...expected, todo };
  delete good.required;
  const ok = validateBody(good, expected, facts);
  assert.deepEqual(ok.body.todo, todo);
  assert.equal(ok.body.tierLine, expected.tierLine);
  const problem = (over) => validateBody({ ...good, ...over }, expected, facts).problem;
  assert.match(problem({ stagingLines: ['• web · zod 4.2.0 → 4.6.5 · closes 3 · HIGH · open 31 days · direct'] }), /stagingLines\[0\].*the correct value is/);
  assert.match(problem({ mainLines: [] }), /mainLines\[0\]/);
  assert.match(problem({ unused: ['• extra'] }), /unused\[0\]/);
  assert.match(problem({ mainSameAsStaging: true }), /mainSameAsStaging must be false/);
  assert.match(problem({ tierLine: 'P1 · 2 packages for later' }), /tierLine/);
  assert.match(problem({ todo: todo.slice(1) }), /missing zod@4\.6\.6/);
  assert.match(problem({ todo: [...todo, 'Run lodash@4.18.0 too.'] }), /must not contain lodash@4\.18\.0/);
  assert.match(problem({ todo: [...todo, 'Run the suite on 9.9.9.'] }), /9\.9\.9, which is not in the facts/);
  assert.match(problem({ todo: todo.filter((b) => !b.startsWith('Merge')) }), /merge staging/);
  assert.match(problem({ todo: todo.filter((b) => !b.startsWith('Harden')) }), /does not mention next-auth/);
  assert.match(problem({ todo: [...todo, 'You should upgrade soon.'] }), /must start with a listed form/);
  assert.match(problem({ todo: [...todo, 'Run this to ensure safety.'] }), /banned wording "ensure"/);
  assert.match(problem({ todo: [...todo, 'Run this — now.'] }), /banned wording "—"/);
  assert.match(problem({ todo: [] }), /no bullets/);
  assert.match(problem({ todo: Array(7).fill(todo.join(' ')) }), /7 bullets/);
});
