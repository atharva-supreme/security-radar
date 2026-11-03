// What the daily Claude filter receives and what comes back. Pure: no I/O.
//
//   candidatesFor(report, { repo, name, day, usage })  -> every unit of the project, per branch, each with a fact id
//   promptInput(input, ids)                            -> the JSON Claude reads for those fact ids
//   validateDecisions(parsed, input)                   -> { decisions: { id: { tier, reason } }, corrections }
//   buildVerdict(input, decisions)                     -> { lines, notAssessed }
//   applyVerdict(units, verdict, app, branch)          -> units with `tier`, `action` and `verdictReason`
//
// Nothing is filtered before Claude: dev-only and tooling packages are sent too, and Claude assigns
// P0, P1 or P2. The scanner's own tier (scanTier) is used only when Claude could not decide.
// A decision is stored under a hash of its facts, so it changes only when a fact changes. The code
// owns versions and counts; Claude owns the relevance decision and its reason.

import { createHash } from 'node:crypto';
import { isUrgent } from './format.mjs';

const MAX_ADVISORIES = 6;
const MAX_IMPORTS = 5;
const MAX_REASON = 160;
export const ACTION_OF = { P0: 'now', P1: 'later', P2: 'skip' };

const unitKey = (app, u) => `${app}\u0000${u.package}\u0000${u.line}`;

// A flagged package the app declares itself (direct) whose name never appears in the branch's own
// source: not imported, not required, not named in a config or a package.json script. Removing it
// from package.json closes its advisories with no code change; upgrading it would be wasted work.
// Packages a framework loads by name alone (sharp under next) are listed in report.implicitUse.
export function isUnused(unit, pkgUsage, implicitUse = []) {
  // Build tools often run with no import (a peer of a loader, a config key), so removing one can
  // break the build. The tooling list no longer hides anything from Claude, but it does stop this claim.
  if (unit.direct !== true || unit.prod === false || unit.tooling) return false;
  if (!pkgUsage || typeof pkgUsage.count !== 'number') return false;
  if (implicitUse.includes(unit.package)) return false;
  return pkgUsage.count === 0 && (pkgUsage.mentions ?? 0) === 0;
}

// The facts a decision rests on. Installed versions, open days and "new" flags are left out on
// purpose: they move every day without changing whether the project needs the fix.
export function factId(repo, c) {
  const used = c.usage ? c.usage.count > 0 : null;
  const mentioned = c.usage ? (c.usage.mentions ?? 0) > 0 : null;
  const facts = [repo, [...c.apps].sort(), c.package, c.line, c.to, c.toMajor, c.direct, c.prod, c.via?.direct ?? null, c.via?.dev ?? null, c.worst, [...c.advisoryIds].sort(), used, mentioned, c.unused, c.closedBy?.package ?? null, c.closedBy?.version ?? null];
  return createHash('sha1').update(JSON.stringify(facts)).digest('hex').slice(0, 12);
}

export function candidatesFor(report, { repo, name, day, usage = null, runtimeParents = [], implicitUse = [] }) {
  const advisories = new Map(report.advisories.map((a) => [a.id, a]));
  const apps = report.apps.filter((a) => a.repo === repo && a.kind === 'app' && a.ok);
  const rank = { critical: 0, high: 1, moderate: 2, medium: 2, low: 3 };
  const toCandidate = (app, u, scan, branch) => {
    const pkgUsage = scan?.packages?.[u.package] ?? null;
    return {
      app: app.label,
      apps: [app.label],
      branch,
      package: u.package,
      line: u.line,
      installed: u.from,
      to: u.lineComplete ? u.to : null,
      toMajor: u.toMajor ?? null,
      closedBy: u.closedBy ?? null,
      direct: u.direct,
      via: u.via,
      prod: u.prod,
      worst: u.worst,
      critical: u.critical,
      high: u.high,
      closes: u.closes,
      advisoryIds: u.advisories,
      usage: pkgUsage ? { count: pkgUsage.count, imports: (pkgUsage.imports ?? []).slice(0, MAX_IMPORTS), mentions: pkgUsage.mentions ?? 0, mentioned: pkgUsage.mentioned ?? [] } : null,
      unused: isUnused(u, pkgUsage, implicitUse),
      scanTier: u.tier,
    };
  };
  // A pnpm workspace lockfile at the repo root repeats what the per-app lockfiles say, so the same
  // (package, line, target) often shows up under two or three app labels. One candidate, all its apps.
  const merge = (list) => {
    const byKey = new Map();
    for (const c of list) {
      const key = `${c.package}\u0000${c.line}\u0000${c.to ?? c.toMajor}`;
      const prev = byKey.get(key);
      if (!prev) { byKey.set(key, { ...c }); continue; }
      prev.apps.push(c.app);
      prev.installed = [...new Set([...prev.installed, ...c.installed])];
      prev.closes = Math.max(prev.closes, c.closes);
      prev.critical = Math.max(prev.critical, c.critical);
      prev.high = Math.max(prev.high, c.high);
      prev.advisoryIds = [...new Set([...prev.advisoryIds, ...c.advisoryIds])];
      prev.direct = prev.direct === true || c.direct === true ? true : prev.direct === false && c.direct === false ? false : null;
      prev.unused = prev.unused && c.unused;
      prev.prod = prev.prod === true || c.prod === true ? true : prev.prod;
      if ((rank[c.worst] ?? 9) < (rank[prev.worst] ?? 9)) prev.worst = c.worst;
      if (c.scanTier === 'P0' || (c.scanTier === 'P1' && prev.scanTier === 'P2')) prev.scanTier = c.scanTier;
      if (!prev.via?.direct || prev.via.dev) prev.via = c.via ?? prev.via;
    }
    return [...byKey.values()].map((c) => ({ ...c, app: c.apps.join(', '), id: factId(repo, c) }));
  };
  const branchList = (branch, scan) => merge(apps.filter((a) => a.branch === branch).flatMap((app) => (app.upgrades ?? []).map((u) => toCandidate(app, u, scan, branch))));
  const stagingUsage = usage?.branches?.staging ?? null;
  return {
    project: name,
    repo,
    date: day,
    apps: apps.filter((a) => a.branch === 'main').map((a) => ({ label: a.label, lockfile: a.lockfile, importers: a.importers ?? [], packages: a.packages })),
    candidates: branchList('main', usage),
    staging: branchList('staging', stagingUsage),
    stagingScanned: apps.some((a) => a.branch === 'staging'),
    stagingUsageScanned: Boolean(stagingUsage && !stagingUsage.error),
    signals: usage?.signals ?? null,
    stagingSignals: stagingUsage?.signals ?? null,
    advisories,
    rules: { runtimeParents, implicitUse },
  };
}

// Every distinct fact id once, in the order first seen.
export function factIds(input) {
  return [...new Set([...input.candidates, ...input.staging].map((c) => c.id))];
}

// What Claude reads. Identical facts on both branches are one item, so they cannot get two answers.
export function promptInput(input, ids) {
  const wanted = new Set(ids);
  const byId = new Map();
  for (const c of [...input.candidates, ...input.staging]) {
    if (!wanted.has(c.id)) continue;
    const seen = byId.get(c.id);
    if (seen) { seen.branches = [...new Set([...seen.branches, c.branch])]; continue; }
    byId.set(c.id, {
      id: c.id,
      apps: c.apps,
      branches: [c.branch],
      package: c.package,
      line: c.line,
      installed: c.installed,
      to: c.to,
      toMajor: c.toMajor,
      closedBy: c.closedBy,
      direct: c.direct,
      via: c.via,
      prod: c.prod,
      worst: c.worst,
      critical: c.critical,
      high: c.high,
      closes: c.closes,
      advisories: c.advisoryIds.map((id) => input.advisories.get(id)).filter(Boolean)
        .sort((a, b) => (isUrgent(a.severity) ? 0 : 1) - (isUrgent(b.severity) ? 0 : 1))
        .slice(0, MAX_ADVISORIES).map((a) => ({ id: a.id, severity: a.severity, summary: a.summary })),
      usage: c.usage,
      unused: c.unused,
    });
  }
  return {
    project: input.project,
    repo: input.repo,
    apps: input.apps,
    signals: input.signals,
    stagingSignals: input.stagingSignals,
    rules: input.rules,
    candidates: [...byId.values()],
  };
}

// Only answers for ids that were asked about survive, with a valid tier. Anything else stays
// undecided and is asked again next run; a wrong answer is never stored.
export function validateDecisions(parsed, input) {
  const corrections = [];
  const all = new Map([...input.candidates, ...input.staging].map((c) => [c.id, c]));
  const decisions = {};
  for (const raw of Array.isArray(parsed?.decisions) ? parsed.decisions : []) {
    const c = all.get(String(raw?.id ?? ''));
    if (!c) { corrections.push(`dropped unknown id ${raw?.id}`); continue; }
    if (!ACTION_OF[raw.tier]) { corrections.push(`${c.package} ${c.line}: tier "${raw.tier}" not valid, left undecided`); continue; }
    let tier = raw.tier;
    // Slack carries critical and high only: a moderate or low can be P1 at most.
    if (tier === 'P0' && !isUrgent(c.worst)) { tier = 'P1'; corrections.push(`${c.package} ${c.line}: ${c.worst} cannot be P0, read as P1`); }
    decisions[c.id] = { tier, reason: String(raw.reason ?? '').trim().slice(0, MAX_REASON) };
  }
  return { decisions, corrections };
}

// One line per candidate on each branch. A candidate with no decision falls back to the scanner's
// tier, is counted in notAssessed, and is never stored.
export function buildVerdict(input, decisions) {
  let notAssessed = 0;
  const lines = [...input.candidates, ...input.staging].map((c) => {
    const d = decisions[c.id];
    if (!d) notAssessed += 1;
    const tier = d?.tier ?? c.scanTier;
    return { id: c.id, app: c.app, apps: c.apps, package: c.package, line: c.line, to: c.to ?? c.toMajor, branch: c.branch, tier, action: ACTION_OF[tier], assessed: Boolean(d), decidedOn: d?.decidedOn ?? null, reason: d?.reason ?? `not assessed by the filter, scanner tier ${c.scanTier} shown` };
  });
  return { lines, notAssessed };
}

// Attach the verdict to an app's units. Each branch reads its own lines only.
export function applyVerdict(units, verdict, appLabel, branch = 'main') {
  const byKey = new Map();
  for (const l of verdict?.lines ?? []) {
    if ((l.branch ?? 'main') !== branch) continue;
    for (const app of l.apps ?? [l.app]) byKey.set(unitKey(app, l), l);
  }
  return units.map((u) => {
    const l = byKey.get(unitKey(appLabel, u));
    return { ...u, tier: l?.tier ?? u.tier, action: l?.action ?? null, verdictReason: l?.reason ?? null };
  });
}

// Claude produces the message body; the code compares it with its own calculation. Lines and counts
// must match exactly. "What to do" may be worded freely, but its commands must match, with
// no package@version missing or added, and no filler. Returns { body } or { problem }.
const MAX_TODO_BULLETS = 6;
const MAX_TODO_CHARS = 400;
const SLOP = /—|\b(ensure|crucial|robust|seamless|leverage|utilize|streamline|comprehensive|delve|in order to|it'?s important|please note)\b/i;
const OPENERS = /^(Run|Add|Merge|Remove|Harden|Nothing)\b/;

export function validateBody(parsed, expected, facts) {
  const problems = [];
  const same = (name, got, want) => {
    const list = Array.isArray(got) ? got.map((x) => String(x).trim()) : null;
    if (!list) { problems.push(`${name} must be an array`); return null; }
    for (let i = 0; i < Math.max(list.length, want.length); i += 1) {
      if (list[i] !== want[i]) problems.push(`${name}[${i}] is ${JSON.stringify(list[i] ?? null)}, the correct value is ${JSON.stringify(want[i] ?? null)}`);
    }
    return list;
  };
  const stagingLines = same('stagingLines', parsed?.stagingLines, expected.stagingLines);
  const mainLines = same('mainLines', parsed?.mainLines, expected.mainLines);
  const unused = same('unused', parsed?.unused, expected.unused);
  const outOfSync = same('outOfSync', parsed?.outOfSync, expected.outOfSync);
  if (parsed?.mainSameAsStaging !== expected.mainSameAsStaging) problems.push(`mainSameAsStaging must be ${expected.mainSameAsStaging}`);
  if (String(parsed?.tierLine ?? '').trim() !== expected.tierLine) problems.push(`tierLine is ${JSON.stringify(parsed?.tierLine ?? null)}, the correct value is ${JSON.stringify(expected.tierLine)}`);

  const todo = (Array.isArray(parsed?.todo) ? parsed.todo : []).map((b) => String(b).trim().replace(/^[•*-]\s*/, '')).filter(Boolean);
  if (!todo.length) problems.push('todo has no bullets');
  if (todo.length > MAX_TODO_BULLETS) problems.push(`todo has ${todo.length} bullets, the limit is ${MAX_TODO_BULLETS}`);
  for (const b of todo) {
    if (b.length > MAX_TODO_CHARS) problems.push(`a todo bullet is ${b.length} characters, the limit is ${MAX_TODO_CHARS}`);
    if (!OPENERS.test(b)) problems.push(`todo bullet must start with a listed form: ${JSON.stringify(b.slice(0, 60))}`);
    const slop = SLOP.exec(b);
    if (slop) problems.push(`todo uses the banned wording "${slop[0]}"`);
  }
  const text = todo.join('\n');
  const allowed = JSON.stringify(facts);
  const stray = (text.match(/\b\d+\.\d+(?:\.\d+)*(?:-[\w.]+)?\b/g) ?? []).find((v) => !allowed.includes(v));
  if (stray) problems.push(`todo names version ${stray}, which is not in the facts`);
  const tokens = text.match(/(?:@[\w.-]+\/)?[\w.-]+@[\w.-]+/g) ?? [];
  const { required } = expected;
  for (const t of new Set(required.tokens)) if (!tokens.includes(t)) problems.push(`todo is missing ${t}`);
  for (const t of new Set(tokens)) if (!required.tokens.includes(t)) problems.push(`todo must not contain ${t}`);
  for (const p of required.packages) if (!text.includes(p)) problems.push(`todo does not mention ${p}, which has no target`);
  if (required.merge && !/merge staging/i.test(text)) problems.push('todo must say to merge staging into main');

  if (problems.length) return { problem: problems.slice(0, 12).join('; ') };
  return { body: { stagingLines, mainSameAsStaging: parsed.mainSameAsStaging, mainLines, unused, outOfSync, todo, tierLine: expected.tierLine } };
}
