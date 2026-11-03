import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMessages, mergeLines, lineText, esc, stagingBlocks, mainBlocks, whatToDo, driftLines, unusedLines, composeInput, mrkdwn } from '../src/slack.mjs';
import { validateBody } from '../src/filter.mjs';

const unit = (over) => ({ package: 'x', line: '1', from: ['1.0.0'], to: '1.0.1', lineComplete: true, toMajor: null, closes: 1, open: 1, critical: 0, high: 1, worst: 'high', worstId: 'A', direct: true, prod: true, via: null, tooling: false, openDays: 3, isNew: false, early: false, advisories: ['A'], tier: 'P0', reason: 'fix in line', ...over });
const app = (repo, branch, label, upgrades, extra = {}) => ({ repo, project: repo.split('/')[1], branch, label, kind: 'app', ok: true, lockfile: `${label}/pnpm-lock.yaml`, packages: 10, importers: ['.'], upgrades, command: null, overrides: null, overridesKey: 'pnpm.overrides', ...extra });
const advisories = [
  { id: 'A', severity: 'high', summary: 'a', url: 'https://x/A' },
  { id: 'B', severity: 'critical', summary: 'b', url: 'https://x/B' },
];
const projects = { 'Org/catalent': 'Catalent', 'Org/clean': 'Clean' };

function sampleReport() {
  return {
    generatedAt: '2026-10-30T02:30:00Z',
    advisories,
    projects: [{ repo: 'Org/catalent', branch: 'main', health: { score: 59 } }, { repo: 'Org/clean', branch: 'main', health: { score: 100 } }],
    apps: [
      app('Org/catalent', 'main', 'root', [
        unit({ package: 'next', line: '16', from: ['16.3.5'], to: '16.4.1', closes: 11, worst: 'critical', worstId: 'B', critical: 5, openDays: 37, isNew: true }),
        unit({ package: 'undici', line: '7', from: ['7.29.0', '7.29.1'], to: '7.30.1', closes: 34, direct: false, openDays: 55 }),
        unit({ package: 'jspdf', line: '3', from: ['3.0.4'], to: null, lineComplete: false, toMajor: '4.2.1', worst: 'critical', worstId: 'B', reason: 'major bump' }),
        unit({ package: 'qs', line: '6', worst: 'moderate', tier: 'P1', reason: 'moderate/low' }),
        unit({ package: 'vite', line: '7', tier: 'P2', reason: 'build tooling', tooling: true }),
      ], { command: 'pnpm up next@16.4.1 jspdf@4.2.1', overrides: { 'undici@7': '7.30.1' } }),
      app('Org/catalent', 'staging', 'root', [
        unit({ package: 'next', line: '16', from: ['16.3.5'], to: '16.4.1', worst: 'critical', worstId: 'B' }),
        unit({ package: 'ws', line: '8', from: ['8.19.0'], to: '8.21.0', direct: false }),
      ]),
      app('Org/clean', 'main', 'web', [unit({ package: 'qs', line: '6', worst: 'moderate', tier: 'P1', reason: 'moderate/low' })]),
    ],
  };
}
const sections = (m) => m.blocks.filter((b) => b.type === 'section').map((b) => b.text.text);

test('one message per project: staging first, three scores in the header, unfiltered lists every P0 and says so', () => {
  const msgs = buildMessages(sampleReport(), { projects, now: new Date('2026-10-30T03:00:00Z') });
  assert.equal(msgs.length, 2);
  const [catalent, clean] = msgs;
  assert.equal(catalent.blocks[0].type, 'header');
  assert.equal(catalent.blocks[0].text.text, ':package: Catalent · Health Score · staging 59 · main 58 · overall 58 · :red_circle: RED');
  const [staging, main, todo, counts] = sections(catalent);
  assert.equal(staging, '*staging* · :red_circle: *RED* · Health Score 59 · 1 critical, 1 high · 2 packages to fix\n' +
    '• root · next 16.3.5 → 16.4.1 · closes 11 · <https://x/B|CRITICAL> · open 37 days · direct · :new: NEW\n'.replace('closes 11', 'closes 1').replace('open 37 days', 'open 3 days').replace(' · :new: NEW', '') +
    '• root · ws 8.19.0 → 8.21.0 · closes 1 · <https://x/A|HIGH> · open 3 days · override');
  assert.match(main, /^\*main\* · :red_circle: \*RED\* · Health Score 58 · 2 critical, 1 high · 3 packages to fix\n/);
  assert.match(main, /• same fix as staging: next 16\.3\.5/);
  assert.match(main, /• root · jspdf 3\.0\.4 → 4\.2\.1 · closes 1 · <https:\/\/x\/B\|CRITICAL> · open 3 days · direct · :arrow_up: major · fixed on staging/);
  assert.match(main, /• root · undici 7\.29\.0, 7\.29\.1 → 7\.30\.1 · closes 34 · <https:\/\/x\/A\|HIGH> · open 55 days · override · fixed on staging$/m);
  assert.ok(!main.includes('qs') && !main.includes('vite'), 'P1 and P2 never appear as lines');
  assert.match(todo, /^\*What to do\*\n• _Unfiltered/);
  assert.match(todo, /• staging · root: `cd root &amp;&amp; pnpm up next@16\.4\.1`/);
  assert.match(todo, /• staging · root: add to pnpm\.overrides `"ws@8": "8\.21\.0"`/);
  assert.match(todo, /• main: merge staging, that closes all 3 fixes/);
  assert.equal(counts, 'P1 · 1 package for later · P2 · 1 package, no action');
  assert.ok(!catalent.blocks.some((b) => b.type === 'context'), 'no definitions footer');
  assert.equal(catalent.blocks.at(-1).type, 'divider');

  assert.equal(clean.blocks[0].text.text, ':package: Clean · Health Score · main 99 · overall 99 · :large_green_circle: GREEN');
  assert.match(sections(clean)[0], /nothing to fix today/);
  assert.ok(sections(clean)[1].includes('Nothing to fix today'));
});

test('with a verdict: Claude\'s P0 lines show, identical main collapses to "same as staging", P1 and P2 are counts', () => {
  const l = (branch, pkg, line, to, tier, action, reason) => ({ app: 'root', apps: ['root'], package: pkg, line, to, branch, tier, action, reason });
  const verdicts = { projects: { 'Org/catalent': { ok: true, notAssessed: 2, lines: [
    l('main', 'next', '16', '16.4.1', 'P0', 'now', 'framework'),
    l('main', 'undici', '7', '7.30.1', 'P2', 'skip', 'cli only'),
    l('main', 'jspdf', '3', '4.2.1', 'P1', 'later', 'major'),
    l('main', 'vite', '7', '7.3.5', 'P0', 'now', 'Claude raised a tooling package'),
    l('staging', 'next', '16', '16.4.1', 'P0', 'now', 'framework'),
    l('staging', 'ws', '8', '8.21.0', 'P2', 'skip', 'cli'),
  ] } } };
  const [m] = buildMessages(sampleReport(), { projects, verdicts, only: 'Catalent' });
  const [staging, main, todo, counts] = sections(m);
  assert.match(staging, /^\*staging\* · :red_circle: \*RED\* · Health Score 59 · 1 critical, 0 high · 1 package to fix\n• root · next/);
  assert.ok(!staging.includes('ws'));
  assert.match(main, /2 packages to fix\n/);
  assert.match(main, /• same fix as staging: next 16\.3\.5/);
  assert.match(main, /• root · vite 1\.0\.0 → 1\.0\.1 .* · fixed on staging/, 'the tooling list does not stop Claude');
  assert.ok(!main.includes('undici') && !main.includes('jspdf'));
  assert.match(todo, /• main: merge staging, that closes all 2 fixes/);
  assert.match(counts, /^P1 · 2 packages for later · P2 · 2 packages, no action · :warning: 2 not assessed today$/);

  const same = { projects: { 'Org/catalent': { ok: true, lines: [l('main', 'next', '16', '16.4.1', 'P0', 'now', 'x'), l('staging', 'next', '16', '16.4.1', 'P0', 'now', 'x')] } } };
  const main2 = sections(buildMessages(sampleReport(), { projects, verdicts: same, only: 'Catalent' })[0])[1];
  assert.match(main2, /^\*main\* · .* · 1 critical, 0 high · 1 package to fix · same as staging$/);
});

test('a failed verdict ({ ok: false }) falls back to every P0 and names the error', () => {
  const verdicts = { projects: { 'Org/catalent': { ok: false, error: 'claude exited 1: Not logged in · Please run /login', candidates: 3 } } };
  const [m] = buildMessages(sampleReport(), { projects, verdicts, only: 'Catalent' });
  assert.equal(m.blocks[0].text.text, ':package: Catalent · Health Score · staging 59 · main 58 · overall 58 · :red_circle: RED');
  const text = sections(m).join('\n');
  assert.match(text, /Unfiltered: the daily filter did not run \(claude exited 1: Not logged in/);
  assert.match(text, /2 critical, 1 high/);
});

test('--only matches repo, short name or display name; unknown throws', () => {
  for (const only of ['Org/catalent', 'catalent', 'Catalent']) assert.equal(buildMessages(sampleReport(), { projects, only }).length, 1);
  assert.throws(() => buildMessages(sampleReport(), { projects, only: 'nope' }), /no reported project/);
});

test('mergeLines joins the same target across apps and keeps the worst advisory', () => {
  const lines = mergeLines([
    { app: 'web', units: [unit({ package: 'dompurify', line: '3', from: ['3.4.11'], to: '3.4.17', worst: 'high', action: 'now' })] },
    { app: 'root', units: [unit({ package: 'dompurify', line: '3', from: ['3.3.2'], to: '3.4.17', worst: 'critical', worstId: 'B', action: 'now', direct: false })] },
    { app: 'root', units: [unit({ package: 'ws', action: 'skip' })] },
  ]);
  assert.equal(lines.length, 1);
  assert.deepEqual([lines[0].apps, lines[0].from, lines[0].worst, lines[0].worstId, lines[0].direct], [['web', 'root'], ['3.3.2', '3.4.11'], 'critical', 'B', true]);
  assert.match(lineText(lines[0], new Map(advisories.map((a) => [a.id, a]))), /^• web, root · dompurify 3.3.2, 3.4.11 → 3.4.17 · closes 1 · <https:\/\/x\/B\|CRITICAL> · open 3 days · direct$/);
});

test('long line lists split into several sections under the limit', () => {
  const r = sampleReport();
  r.apps[0].upgrades = Array.from({ length: 120 }, (_, i) => unit({ package: `package-number-${i}-with-a-long-name`, from: ['1.0.0'], to: '1.0.1' }));
  const [m] = buildMessages(r, { projects, only: 'Catalent' });
  const lineSections = m.blocks.filter((b) => b.type === 'section' && /• root · package-number/.test(b.text.text));
  assert.ok(lineSections.length > 1);
  assert.ok(lineSections.every((b) => b.text.text.length <= 3000));
  assert.match(lineSections[0].text.text, /120 packages to fix/);
});

test('esc escapes mrkdwn control characters', () => {
  assert.equal(esc('a < b & c > d'), 'a &lt; b &amp; c &gt; d');
});

const line = (pkg, ln, from, to, worst = 'high', apps = ['web']) => ({ package: pkg, line: ln, from, to, worst, apps, closes: 1, openDays: 3, direct: true });
const view = (branch, lines, score, status, extraUnits = []) => ({ branch, lines, apps: [], units: [...lines, ...extraUnits].map((l) => ({ package: l.package, line: l.line })), health: { score, status }, broken: false });
const textOf = (blocks) => blocks.map((b) => b.text.text).join('\n');
const noAdv = new Map();

test('staging is always listed; main says "same as staging" only for what truly matches (VectorLabs 2026-11-02)', () => {
  const mainLines = [line('next', '16', ['16.2.12'], '16.4.1', 'critical'), line('nodemailer', '7', ['7.0.12'], '10.1.4'), line('zod', '4', ['4.2.0', '4.4.3'], '4.6.6')];
  const main = view('main', mainLines, 27, 'RED');

  // identical on target and versions: the list is on staging, main is one line
  const same = view('staging', mainLines.map((l) => ({ ...l })), 27, 'RED');
  assert.match(textOf(stagingBlocks(same, noAdv)), /^\*staging\* · :red_circle: \*RED\* · Health Score 27 · 1 critical, 2 high · 3 packages to fix\n• web · next 16\.2\.12 → 16\.4\.1/);
  assert.equal(textOf(mainBlocks(main, same, noAdv)), '*main* · :red_circle: *RED* · Health Score 27 · 1 critical, 2 high · 3 packages to fix · same as staging');

  // same fix from other versions: never "same as staging", main's own versions are named
  const ahead = view('staging', [line('nodemailer', '7', ['7.0.13'], '10.1.4'), line('zod', '4', ['4.1.11'], '4.6.6')], 79, 'AMBER');
  const m = textOf(mainBlocks(main, ahead, noAdv));
  assert.ok(!m.includes('same as staging'));
  assert.match(m, /• same fix as staging: nodemailer 7\.0\.12, zod 4\.2\.0, 4\.4\.3\n/);
  assert.match(m, /• web · next 16\.2\.12 → 16\.4\.1 .* · fixed on staging$/);

  // staging still carries the package at another target or a lower tier: not "fixed on staging"
  const other = view('staging', [line('next', '16', ['16.4.0'], '16.4.3', 'critical')], 59, 'RED', [{ package: 'nodemailer', line: '7' }]);
  const o = textOf(mainBlocks(main, other, noAdv));
  assert.match(o, /next 16\.2\.12 → 16\.4\.1 [^\n]*direct$/m);
  assert.match(o, /nodemailer 7\.0\.12 → 10\.1\.4 [^\n]*direct$/m);
  assert.match(o, /zod 4\.2\.0, 4\.4\.3 → 4\.6\.6 [^\n]* · fixed on staging$/m);

  // staging worse than main (RayBiotech): staging's extras stay on staging, main is not told to copy them
  const worse = view('staging', [...mainLines, line('ws', '8', ['8.19.0'], '8.21.0')], 20, 'RED');
  assert.ok(textOf(mainBlocks(main, worse, noAdv)).includes('same fix as staging'));
  assert.ok(!textOf(mainBlocks(main, worse, noAdv)).includes('ws'));

  // both clean, and no staging branch at all
  const clean = view('main', [], 100, 'GREEN');
  assert.equal(textOf(mainBlocks(clean, view('staging', [], 100, 'GREEN'), noAdv)), '*main* · :large_green_circle: *GREEN* · Health Score 100 · nothing to fix today · same as staging');
  assert.match(textOf(mainBlocks(main, null, noAdv)), /• web · nodemailer 7\.0\.12/);
});

test('whatToDo: exact commands, staging first, main closed by merge; unused never upgraded; no-fix items named', () => {
  const u = (over) => ({ ...over, appLabel: 'web' });
  const app = (branch, importers) => ({ ok: true, label: 'web', branch, lockfile: 'web/pnpm-lock.yaml', importers, upgrades: [] });
  const unit = (pkg, ln, to, direct, action = 'now', reason = null) => ({ package: pkg, line: ln, to, lineComplete: Boolean(to), toMajor: null, direct, tier: action === 'now' ? 'P0' : 'P1', action, verdictReason: reason, prod: true, from: ['1.0.0'] });
  const stagingUnits = [unit('zod', '4', '4.6.6', true), unit('proxy-addr', '2', '2.0.8', false), unit('gone', '1', '1.0.1', true), unit('sanitize-html', '2', null, true, 'now', 'Harden the xmp config.')];
  const stagingApp = { ...app('staging', ['.', 'core']), upgrades: stagingUnits };
  const staging = { branch: 'staging', apps: [stagingApp], units: stagingUnits.map(u), lines: [line('zod', '4', ['4.1.11'], '4.6.6'), line('proxy-addr', '2', ['2.0.7'], '2.0.8')], broken: false };
  const mainUnits = [unit('zod', '4', '4.6.6', true), unit('next', '16', '16.4.1', true), unit('lodash', '4', '4.18.0', true)];
  const mainApp = { ...app('main', ['.', 'core']), upgrades: mainUnits };
  const main = { branch: 'main', apps: [mainApp], units: mainUnits.map(u), lines: [line('zod', '4', ['4.2.0'], '4.6.6'), line('next', '16', ['16.2.12'], '16.4.1', 'critical'), line('lodash', '4', ['4.17.0'], '4.18.0')], broken: false };
  // lodash stays open on staging at a lower tier, so merging staging would not close it on main
  staging.units.push(u(unit('lodash', '4', '4.18.0', true, 'later')));
  const usage = { packages: {}, branches: { staging: { packages: { gone: { count: 0, imports: [], mentions: 0 } } } } };
  assert.deepEqual(whatToDo(main, staging, { usage }), [
    '• staging · web: `cd web &amp;&amp; pnpm up -r zod@4.6.6`',
    '• staging · web: add to pnpm.overrides `"proxy-addr@2": "2.0.8"`',
    '• main: merge staging, that closes 2 of 3 fixes',
    '• main · web: `cd web &amp;&amp; pnpm up -r lodash@4.18.0`',
    '• web · sanitize-html 2: no fix published. Harden the xmp config.',
  ]);
  // a no-fix P0 on main that staging has no open advisory for is closed by the merge, not "no fix"
  const authUnit = unit('next-auth', '5', null, true, 'now', 'Auth uses it.');
  const main2 = { ...main, units: [...main.units, u(authUnit)] };
  const out = whatToDo(main2, staging, { usage });
  assert.ok(out.includes("• main: next-auth 5 also closes on merge, staging's version has nothing open"));
  assert.ok(!out.some((b) => b.includes('next-auth 5: no fix published')));
  assert.ok(whatToDo(main2, null).some((b) => b.includes('next-auth 5: no fix published')), 'with no staging it really is no fix');
  // no staging: main gets the commands itself; nothing open: says so
  assert.ok(whatToDo(main, null)[0].startsWith('• main · web: `cd web &amp;&amp; pnpm up -r zod@4.6.6 next@16.4.1 lodash@4.18.0`'));
  const empty = { branch: 'main', apps: [], units: [], lines: [], broken: false };
  assert.deepEqual(whatToDo(empty, null), ['• Nothing to fix today.']);
});

test('driftLines: one line per file pair, identical branches merged, long lists cut', () => {
  const d = (pkg, declared, locked) => ({ lockfile: 'pnpm-lock.yaml', manifest: 'next/package.json', package: pkg, declared, locked });
  const list = [d('a', '^1', null), d('b', '^2', '^1'), d('c', '^3', '^2'), d('e', '^4', '^3')];
  assert.deepEqual(driftLines({ drift: list, branches: { staging: { drift: list } } }, ['staging', 'main']), ['• staging, main · pnpm-lock.yaml and next/package.json · a missing from lockfile, b ^2 vs ^1, c ^3 vs ^2, +1 more · run install and commit the lockfile']);
  assert.deepEqual(driftLines({ drift: [] }, ['main']), []);
  assert.deepEqual(driftLines(null, ['main']), []);
});

test('Unused section: flagged direct packages the code never imports or mentions, per branch', () => {
  const usage = { repos: { 'Org/catalent': {
    packages: { next: { count: 40, imports: ['x'], mentions: 0 }, jspdf: { count: 0, imports: [], mentions: 0 }, undici: { count: 0, imports: [], mentions: 0 } },
    branches: { staging: { packages: { next: { count: 41, imports: ['x'], mentions: 0 }, ws: { count: 0, imports: [], mentions: 0 } } } },
  } } };
  const report = sampleReport();
  report.apps[1].upgrades[1] = { ...report.apps[1].upgrades[1], direct: true, via: { direct: 'ws', importer: 'core', dev: false, depth: 0 } }; // ws declared by staging core
  const [m] = buildMessages(report, { projects, only: 'Catalent', usage });
  const unused = sections(m).find((x) => x.startsWith('*Unused*'));
  assert.equal(unused, '*Unused* · declared but never used in the code\n' +
    '• root · jspdf 3.0.4 · declared in package.json, never imported or referenced · main only · remove it instead of upgrading, no code change expected\n' +
    '• root · ws 8.19.0 · declared in core/package.json, never imported or referenced · staging only · remove it instead of upgrading, no code change expected');
  assert.ok(!unused.includes('undici'), 'transitive packages are never "unused"');
  // no usage file: no section at all, no claim
  assert.ok(!sections(buildMessages(sampleReport(), { projects, only: 'Catalent' })[0]).some((x) => x.startsWith('*Unused*')));
  // implicitUse exempts framework-loaded packages
  assert.deepEqual(unusedLines(report.apps.filter((a) => a.repo === 'Org/catalent'), usage.repos['Org/catalent'], ['jspdf', 'ws']), []);
});

test('Claude\'s body renders byte for byte like the code\'s, only What to do differs; a failed check goes out labelled', () => {
  const lines = [
    { app: 'root', apps: ['root'], package: 'next', line: '16', to: '16.4.1', branch: 'main', tier: 'P0', action: 'now', reason: 'framework' },
    { app: 'root', apps: ['root'], package: 'jspdf', line: '3', to: '4.2.1', branch: 'main', tier: 'P0', action: 'now', reason: 'pdf' },
    { app: 'root', apps: ['root'], package: 'next', line: '16', to: '16.4.1', branch: 'staging', tier: 'P0', action: 'now', reason: 'framework' },
  ];
  const verdict = { ok: true, lines };
  const { facts, expected } = composeInput(sampleReport(), 'Org/catalent', 'Catalent', verdict, {});
  const answer = { stagingLines: expected.stagingLines, mainSameAsStaging: expected.mainSameAsStaging, mainLines: expected.mainLines, unused: expected.unused, outOfSync: expected.outOfSync, tierLine: expected.tierLine, todo: ['Run on staging · root: `cd root && pnpm up next@16.4.1`.', 'Merge staging into main. That closes all 2 fixes.'] };
  const checked = validateBody(answer, expected, facts);
  assert.ok(checked.body, checked.problem);
  const render = (v) => buildMessages(sampleReport(), { projects, verdicts: { projects: { 'Org/catalent': v } }, only: 'Catalent' })[0].blocks;
  const fromClaude = render({ ...verdict, body: checked.body });
  const fromCode = render(verdict);
  assert.equal(fromClaude.length, fromCode.length);
  fromClaude.forEach((b, i) => {
    if (b.text?.text?.startsWith('*What to do*')) return;
    assert.deepEqual(b, fromCode[i], `block ${i} has the same format`);
  });
  const todoOf = (blocks) => blocks.find((b) => b.text?.text?.startsWith('*What to do*')).text.text;
  assert.equal(todoOf(fromClaude), '*What to do*\n• Run on staging · root: `cd root &amp;&amp; pnpm up next@16.4.1`.\n• Merge staging into main. That closes all 2 fixes.');
  assert.match(todoOf(fromCode), /^\*What to do\*\n• _:warning: Claude could not produce this message today, so the code built it\._/);
});

test('composeInput: raw facts for Claude; the code\'s answer is kept apart', () => {
  const lines = [{ app: 'root', apps: ['root'], package: 'next', line: '16', to: '16.4.1', branch: 'main', tier: 'P0', action: 'now', reason: 'framework' }];
  const { facts, expected } = composeInput(sampleReport(), 'Org/catalent', 'Catalent', { ok: true, lines }, {});
  const row = facts.branches.main.p0[0];
  assert.deepEqual([row.app, row.package, row.from, row.target, row.direct, row.url, row.reason], ['root', 'next', ['16.3.5'], '16.4.1', true, 'https://x/B', 'framework']);
  assert.ok(!JSON.stringify(facts).includes('• root'), 'no finished lines reach Claude');
  assert.ok(!('required' in facts) && !('draft' in facts));
  assert.match(expected.mainLines[0], /^• root · next 16\.3\.5 → 16\.4\.1/);
  assert.ok(!expected.tierLine.includes('full report'));
  assert.deepEqual(expected.required.tokens, ['next@16.4.1']);
  assert.equal(facts.branches.staging.p0.length, 0);
});

test('mrkdwn escapes text but leaves links alone', () => {
  assert.equal(mrkdwn('a & b <c> <https://x/y?a=1&b=2|HIGH> d'), 'a &amp; b &lt;c&gt; <https://x/y?a=1&b=2|HIGH> d');
});
