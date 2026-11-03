// Builds report.json: everything a reader (a person, the daily Claude filter, the Slack and HTML
// builders) needs to say what is open, where, since when, and what to upgrade. Pure: no I/O.
//
// Schema 4. Per deployed lockfile ("app") the report carries
//   open[]      one row per (advisory, package, installed version) with the same-line fix, the
//               cross-major fix, whether the app declares the package, whether it ships (prod)
//               and which declared dependency pulls it in (via)
//   upgrades[]  one unit per (package, version line): the single target that closes the most,
//               never a downgrade, pre-release or another major unless the app declares the
//               package itself (then a labelled major bump), with its tier P0/P1/P2
//   health      the project Health Score from the units (see tiers.mjs)

import { compare, lineOf, lineFix, versionsIn, satisfies, parseableVersion, minimumOf } from './semver.mjs';
import { severityRank, isUrgent } from './format.mjs';
import { tierFor, toolingMatcher, healthScore } from './tiers.mjs';

export const NEW_WINDOW_HOURS = 26;

const within = (iso, now, hours) => Boolean(iso) && now.getTime() - new Date(iso).getTime() <= hours * 3600 * 1000;
const daysSince = (iso, now) => (iso ? Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 86400000)) : null);
const sortOpen = (a, b) =>
  severityRank(a.severity) - severityRank(b.severity) || (b.published_at ?? '').localeCompare(a.published_at ?? '');
const asList = (x) => (Array.isArray(x) ? x : x ? [x] : []);
const maxVersion = (list) => list.filter(Boolean).sort(compare).at(-1) ?? null;

// Does advisory `rec` affect `version` of `name`? OSV event lists first; repo-level ranges only
// when OSV has no entry for the package (OSV's reviewed ranges beat hand-typed ones).
export function affects(rec, name, version) {
  const osvEntries = (rec.packages ?? []).filter((p) => p.name === name);
  for (const p of osvEntries) {
    if (p.range) { if (satisfies(version, p.range)) return true; continue; } // legacy GitHub-shaped entry
    if ((p.versions ?? []).includes(version)) return true;
    const intro = asList(p.introduced).map((v) => (v === '0' ? '0.0.0' : parseableVersion(v))).filter(Boolean).sort(compare);
    const fixed = versionsIn(p.fixed);
    for (const i of intro) {
      if (compare(version, i) < 0) continue;
      const f = fixed.find((x) => compare(x, i) > 0);
      if (!f || compare(version, f) < 0) return true;
    }
  }
  if (osvEntries.length) return false;
  for (const p of rec.repoPackages ?? []) {
    if (p.name === name && p.range && satisfies(version, p.range)) return true;
  }
  return false;
}

// Every fixed version an advisory names for a package, from both sources.
const fixesOf = (rec, name) => versionsIn([
  ...(rec.packages ?? []).filter((p) => p.name === name).flatMap((p) => asList(p.fixed)),
  ...(rec.repoPackages ?? []).filter((p) => p.name === name).map((p) => p.fixed),
]);

// Climb within the version line: if the target itself has an open advisory with a fix on the same
// line, move up to it, so the command never lands on a version with its own known problem.
function climb(name, to, advisories) {
  for (let i = 0; i < 10 && to; i += 1) {
    let next = null;
    for (const rec of Object.values(advisories)) {
      if (!affects(rec, name, to)) continue;
      const f = lineFix(fixesOf(rec, name), to);
      if (f && (!next || compare(f, next) > 0)) next = f;
    }
    if (!next) return to;
    to = next;
  }
  return to;
}

const tri = (values) => (values.some((v) => v === true) ? true : values.length && values.every((v) => v === false) ? false : null);

// One unit per (package, version line) in an app. `open` rows carry fixed (same line) and fixedAny.
// `manifests` ("name@version" -> { dependencies, optionalDependencies }) lets a unit with no fix on
// its own line be marked "closed by" the bump of the package that pulls it in, when that package's
// target version already requires the fixed child (next 16.4.1 requires sharp ^0.35.5).
export function unitsFor(open, advisories, { isTooling = () => false, manifests = new Map() } = {}) {
  const byKey = new Map();
  for (const o of open) {
    const line = lineOf(o.installed) ?? o.installed;
    const key = `${o.package}\u0000${line}`;
    const u = byKey.get(key) ?? { package: o.package, line, rows: [] };
    u.rows.push(o);
    byKey.set(key, u);
  }
  const units = [...byKey.values()].map(({ package: name, line, rows }) => {
    const from = [...new Set(rows.map((r) => r.installed))].sort(compare);
    const direct = tri(rows.map((r) => r.direct));
    const prod = tri(rows.map((r) => r.prod));
    const to = climb(name, maxVersion(rows.map((r) => r.fixed)), advisories);
    // A direct dependency can take a major: the lowest version above every install that closes
    // the advisories with no same-line fix. Only offered when the line itself has no complete fix.
    const unfixedInLine = rows.filter((r) => !r.fixed);
    const fixAbove = unfixedInLine.length ? maxVersion(unfixedInLine.map((r) => r.fixedAny)) : null;
    const toMajor = direct === true ? fixAbove : null;
    const closes = rows.filter((r) => (to && r.fixed && compare(r.fixed, to) <= 0) || (toMajor && r.fixedAny && compare(r.fixedAny, toMajor) <= 0)).length;
    const worst = rows.map((r) => r.severity).sort((a, b) => severityRank(a) - severityRank(b))[0];
    const urgentRows = rows.filter((r) => isUrgent(r.severity));
    const worstRow = rows.slice().sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || (b.openDays ?? 0) - (a.openDays ?? 0))[0];
    const base = {
      package: name,
      line,
      from,
      to,
      // The target only exists in the line when every critical/high advisory has a same-line fix.
      lineComplete: urgentRows.every((r) => r.fixed),
      toMajor: !urgentRows.every((r) => r.fixed) ? toMajor : null,
      fixAbove: !urgentRows.every((r) => r.fixed) ? fixAbove : null,
      closedBy: null,
      closes,
      open: rows.length,
      critical: rows.filter((r) => r.severity === 'critical').length,
      high: rows.filter((r) => r.severity === 'high').length,
      worst,
      worstId: worstRow?.id ?? null,
      direct,
      prod,
      via: rows.find((r) => r.via)?.via ?? null,
      tooling: isTooling(name),
      openDays: Math.max(0, ...rows.map((r) => r.openDays ?? 0)),
      isNew: rows.some((r) => r.isNew),
      early: rows.some((r) => r.early),
      advisories: [...new Set(rows.map((r) => r.id))],
    };
    // The tier looks at the fix a P0 can actually take: a same-line target that covers every
    // critical/high, or a major bump for a direct dependency.
    const { tier, reason } = tierFor({ worst, to: base.lineComplete ? to : null, fixAbove: base.lineComplete ? null : fixAbove, direct, prod, tooling: base.tooling });
    return { ...base, tier, reason };
  });
  // Second pass: a transitive unit with no fix on its line is closed by its parent's own bump when
  // the parent's target version declares a range whose minimum is at or above the fixed child.
  for (const u of units) {
    if (u.lineComplete || u.direct === true || !u.fixAbove || !u.via?.direct) continue;
    const parent = units.find((p) => p.package === u.via.direct && p.lineComplete && p.to);
    if (!parent) continue;
    const m = manifests.get(`${parent.package}@${parent.to}`);
    const range = m?.dependencies?.[u.package] ?? m?.optionalDependencies?.[u.package] ?? m?.peerDependencies?.[u.package];
    const min = minimumOf(range);
    if (min && compare(min, u.fixAbove) >= 0) {
      u.closedBy = { package: parent.package, version: parent.to, range, resolves: min };
      u.reason = `closed by ${parent.package} ${parent.to}`;
    }
  }
  return units.sort((a, b) => severityRank(a.worst) - severityRank(b.worst) || b.closes - a.closes || a.package.localeCompare(b.package));
}

// Which parent@target manifests the report would want, so the scanner can fetch them once:
// every transitive open row with no same-line fix whose parent has one, as "parent@parentTarget".
export function manifestKeys(open) {
  const keys = new Set();
  const targetOf = new Map();
  for (const o of open) if (o.fixed) targetOf.set(o.package, maxVersion([targetOf.get(o.package), o.fixed]));
  for (const o of open) {
    if (o.fixed || !o.fixedAny || o.direct === true || !o.via?.direct) continue;
    const t = targetOf.get(o.via.direct);
    if (t) keys.add(`${o.via.direct}@${t}`);
  }
  return [...keys];
}

// The commands a developer runs: direct packages by upgrade, transitive ones by same-line override.
export function commandsFor(app, units) {
  const dir = app.lockfile.includes('/') ? app.lockfile.slice(0, app.lockfile.lastIndexOf('/')) : '.';
  const npm = /package-lock\.json$/.test(app.lockfile);
  const yarn = /yarn\.lock$/.test(app.lockfile);
  const actionable = units.filter((u) => u.tier === 'P0');
  const direct = [...new Set(actionable.filter((u) => u.direct === true && (u.lineComplete ? u.to : u.toMajor)).map((u) => `${u.package}@${u.lineComplete ? u.to : u.toMajor}`))];
  const overrides = {};
  for (const u of actionable.filter((u) => u.direct !== true && u.to && u.lineComplete)) {
    overrides[npm ? `${u.package}@${u.line.startsWith('0.') ? `~${u.line}.0` : `^${u.line}.0.0`}` : `${u.package}@${u.line}`] = u.to;
  }
  const tool = npm ? 'npm install' : yarn ? 'yarn up' : (app.importers?.length ?? 0) > 1 ? 'pnpm up -r' : 'pnpm up';
  const command = direct.length ? `${dir === '.' ? '' : `cd ${dir} && `}${tool} ${direct.join(' ')}` : null;
  const overridesKey = npm ? 'overrides' : yarn ? 'resolutions' : 'pnpm.overrides';
  return { command, overrides: Object.keys(overrides).length ? overrides : null, overridesKey };
}

const statusOf = (open, broken) => {
  if (broken) return 'UNKNOWN';
  if (open.some((o) => isUrgent(o.severity))) return 'RED';
  return open.length ? 'AMBER' : 'GREEN';
};
const RANK = { RED: 0, UNKNOWN: 1, AMBER: 2, GREEN: 3 };

// Health of one project branch from its units: P0 packages by worst severity, P1 packages.
export function healthOf(units) {
  const pkgs = (list) => new Set(list.map((u) => u.package)).size;
  const p0 = units.filter((u) => u.tier === 'P0');
  const critical = pkgs(p0.filter((u) => u.worst === 'critical'));
  const high = pkgs(p0) - critical;
  const p1 = pkgs(units.filter((u) => u.tier === 'P1'));
  return { ...healthScore({ critical, high, p1 }), critical, high, p1, p2: pkgs(units.filter((u) => u.tier === 'P2')) };
}

/**
 * @param {object} args
 * @param {Date} args.now
 * @param {Array} args.apps        [{ project, branch, label, kind, repo, lockfile, ok, error, versions: Map, direct: Map|null,
 *                                   graph: { isProd(name, v), via(name, v) } | null, node,
 *                                   open: [{ id, package, installed, fixed, fixedAny, early }] }]
 * @param {object} args.advisories state.advisories: id -> { severity, summary, cve, url, published_at, firstSeen, sources, malicious, packages, repoPackages }
 * @param {Map} args.published     "name@fixed" -> true | false | null
 */
export function buildReport({ now, apps, advisories, published = new Map(), manifests = new Map(), feedAlerts = [], watchlist = {}, counts = {}, errors = [], warnings = [] }) {
  const isTooling = toolingMatcher(watchlist.report?.toolingPackages ?? []);
  const byAdvisory = new Map(); // id -> { ...rec summary, hits: [{ project, branch, label, kind, installed }] }
  const fullOpen = []; // every app's complete open list, index-aligned with appRows (tooling rows omit theirs)

  const appRows = apps.map((app) => {
    const project = app.project ?? app.repo.split('/').pop();
    const branch = app.branch ?? null;
    const kind = app.kind ?? 'app';
    const base = { project, branch, kind, repo: app.repo, lockfile: app.lockfile, label: app.label };
    if (!app.ok) {
      fullOpen.push([]);
      return { ...base, ok: false, error: app.error ?? 'lockfile could not be read', installed: {}, open: [], counts: {}, upgrades: [], command: null, overrides: null };
    }
    const graph = app.graph ?? null;
    const open = (app.open ?? []).map((o) => {
      const rec = advisories[o.id] ?? {};
      const sources = rec.sources ?? [];
      const entry = {
        id: o.id,
        severity: rec.severity === 'medium' ? 'moderate' : rec.severity ?? 'unknown',
        malicious: Boolean(rec.malicious),
        cve: rec.cve ?? null,
        summary: rec.summary ?? '',
        url: rec.url ?? `https://github.com/advisories/${o.id}`,
        published_at: rec.published_at ?? null,
        openDays: daysSince(rec.published_at, now),
        firstSeen: rec.firstSeen ?? null,
        isNew: within(rec.firstSeen, now, NEW_WINDOW_HOURS),
        // Published by the maintainers but not yet reviewed into the GitHub Advisory Database:
        // the window in which pnpm audit, Dependabot and OSV still say "clean".
        early: Boolean(o.early) || (sources.includes('repo') && !sources.includes('osv')),
        package: o.package,
        installed: o.installed,
        // true = the app declares it; false = pulled in by another package; null = lockfile does not say
        direct: app.direct ? app.direct.get(o.package)?.has(o.installed) ?? false : null,
        // true = in the deployed dependency graph; false = devDependencies only; null = unknown
        prod: graph ? graph.isProd(o.package, o.installed) : null,
        via: graph ? graph.via(o.package, o.installed) : null,
        fixed: o.fixed ?? null,
        fixedAny: o.fixedAny ?? o.fixed ?? null,
        fixedOnNpm: o.fixed ? published.get(`${o.package}@${o.fixed}`) ?? null : null,
      };
      const agg = byAdvisory.get(o.id) ?? { id: o.id, severity: entry.severity, malicious: entry.malicious, cve: entry.cve, summary: entry.summary, url: entry.url, published_at: entry.published_at, openDays: entry.openDays, isNew: entry.isNew, early: entry.early, package: o.package, fixed: entry.fixed, hits: [], hitKeys: new Set(), projectSet: new Set() };
      agg.early = agg.early && entry.early;
      // Per-hit detail only for critical and high (what the messages list); the rest keep counts.
      if (isUrgent(entry.severity)) agg.hits.push({ project, branch, label: app.label, kind, installed: o.installed, fixed: entry.fixed });
      agg.hitKeys.add(`${project}@${branch}/${app.label}`);
      agg.projectSet.add(project);
      byAdvisory.set(o.id, agg);
      return entry;
    });
    open.sort(sortOpen);
    fullOpen.push(open);
    // Per-app rows carry the matching facts only; the advisory's own text lives once in advisories[].
    const slim = (o) => ({ id: o.id, severity: o.severity, package: o.package, installed: o.installed, fixed: o.fixed, fixedAny: o.fixedAny, fixedOnNpm: o.fixedOnNpm, direct: o.direct, prod: o.prod, via: o.via, early: o.early, isNew: o.isNew, openDays: o.openDays });
    const countsBySev = { critical: 0, high: 0, moderate: 0, low: 0, unknown: 0 };
    for (const o of open) countsBySev[o.severity === 'medium' ? 'moderate' : (o.severity in countsBySev ? o.severity : 'unknown')] += 1;
    const upgrades = unitsFor(open, advisories, { isTooling, manifests });
    const installed = Object.fromEntries([...app.versions.entries()].map(([k, v]) => [k, [...v].sort(compare)]).filter(([, v]) => v.length));
    // Build tooling is reported by counts and its worst upgrades only; its per-advisory rows would
    // be half the report and nobody acts on them one by one.
    const tooling = kind === 'tooling';
    const { command, overrides, overridesKey } = commandsFor(app, upgrades);
    return {
      ...base,
      ok: true,
      packages: app.versions.size,
      importers: graph?.importers ?? [],
      installed: Object.fromEntries(Object.entries(installed).filter(([k]) => upgrades.some((u) => u.package === k))),
      node: app.node ?? null,
      open: tooling ? [] : open.map(slim),
      openOmitted: tooling ? open.length : 0,
      counts: countsBySev,
      tiers: { P0: upgrades.filter((u) => u.tier === 'P0').length, P1: upgrades.filter((u) => u.tier === 'P1').length, P2: upgrades.filter((u) => u.tier === 'P2').length },
      upgrades: tooling ? upgrades.slice(0, 10) : upgrades,
      command,
      overrides,
      overridesKey,
    };
  });

  const allOpen = fullOpen.flat();
  const distinct = [...byAdvisory.values()].map(({ hitKeys, projectSet, ...a }) => ({
    ...a,
    apps: hitKeys.size,
    projectBranches: new Set([...hitKeys].map((k) => k.split('/')[0])).size,
    projects: [...projectSet],
  })).sort(sortOpen);

  const appUnits = appRows.filter((a) => a.ok && a.kind === 'app').flatMap((a) => a.upgrades);
  const summary = {
    open: allOpen.length,
    distinct: distinct.length,
    critical: allOpen.filter((o) => o.severity === 'critical').length,
    high: allOpen.filter((o) => o.severity === 'high').length,
    moderate: allOpen.filter((o) => o.severity === 'moderate' || o.severity === 'medium').length,
    low: allOpen.filter((o) => o.severity === 'low').length,
    malicious: allOpen.filter((o) => o.malicious).length,
    newOpen: allOpen.filter((o) => o.isNew).length,
    early: allOpen.filter((o) => o.early).length,
    oldestCriticalOpenDays: Math.max(0, ...allOpen.filter((o) => isUrgent(o.severity)).map((o) => o.openDays ?? 0)),
    units: appUnits.length,
    tiers: { P0: appUnits.filter((u) => u.tier === 'P0').length, P1: appUnits.filter((u) => u.tier === 'P1').length, P2: appUnits.filter((u) => u.tier === 'P2').length },
  };

  const newNotAffecting = Object.entries(advisories)
    .filter(([id, rec]) => !byAdvisory.has(id) && within(rec.firstSeen, now, NEW_WINDOW_HOURS))
    .map(([id, rec]) => ({ id, severity: rec.severity, packages: [...new Set([...(rec.packages ?? []), ...(rec.repoPackages ?? [])].map((p) => p.name))], summary: rec.summary, url: rec.url, published_at: rec.published_at }))
    .sort(sortOpen);
  summary.newNotAffecting = newNotAffecting.length;

  const status = statusOf(allOpen, errors.length > 0 || appRows.some((a) => !a.ok));

  const keyOf = (a) => `${a.project}\u0000${a.branch ?? ''}`;
  const projects = [...new Set(appRows.map(keyOf))]
    .map((key) => {
      const idx = appRows.map((a, i) => (keyOf(a) === key ? i : -1)).filter((i) => i >= 0);
      const rows = idx.map((i) => appRows[i]);
      const open = idx.flatMap((i) => fullOpen[i]);
      const appOpen = idx.filter((i) => appRows[i].kind === 'app').flatMap((i) => fullOpen[i]);
      const units = rows.filter((a) => a.ok && a.kind === 'app').flatMap((a) => a.upgrades);
      return {
        project: rows[0].project,
        branch: rows[0].branch,
        repo: rows[0].repo,
        status: statusOf(open, rows.some((a) => !a.ok)),
        appStatus: statusOf(appOpen, rows.some((a) => a.kind === 'app' && !a.ok)),
        health: healthOf(units),
        kinds: [...new Set(rows.map((a) => a.kind))],
        open: open.length,
        critical: open.filter((o) => o.severity === 'critical').length,
        high: open.filter((o) => o.severity === 'high').length,
        malicious: open.filter((o) => o.malicious).length,
        newOpen: open.filter((o) => o.isNew).length,
        early: open.filter((o) => o.early).length,
        apps: rows.map((a) => a.label),
        affectedApps: idx.filter((i) => fullOpen[i].length).map((i) => appRows[i].label),
      };
    })
    .sort((a, b) => RANK[a.status] - RANK[b.status] || a.project.localeCompare(b.project) || String(a.branch).localeCompare(String(b.branch)));

  return {
    schema: 4,
    generatedAt: now.toISOString(),
    status,
    summary,
    projects,
    advisories: distinct,
    apps: appRows,
    newNotAffecting,
    feedItemsNew: feedAlerts.map(({ feed, item }) => ({ feed: feed.name, title: item.title, link: item.link, date: item.date })),
    checked: {
      ...counts,
      projects: projects.length,
      apps: apps.length,
      appKinds: { app: apps.filter((a) => (a.kind ?? 'app') === 'app').length, tooling: apps.filter((a) => a.kind === 'tooling').length },
      advisoriesKnown: Object.keys(advisories).length,
      toolingPackages: watchlist.report?.toolingPackages ?? [],
      sources: ['maintainers’ repository advisories on GitHub (same minute as release)', 'OSV.dev (reviewed, about a week later; includes malicious-package records)'],
    },
    errors,
    warnings,
  };
}
