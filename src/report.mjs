// Builds report.json: everything a reader (a person, or the Claude routine that writes the
// daily email) needs to say what is open, where, since when, and what to upgrade. Pure: no I/O.

import { compare, parseableVersion, satisfies } from './semver.mjs';
import { severityRank, isUrgent } from './format.mjs';

export const NEW_WINDOW_HOURS = 26;

const within = (iso, now, hours) => Boolean(iso) && now.getTime() - new Date(iso).getTime() <= hours * 3600 * 1000;
const daysSince = (iso, now) => (iso ? Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 86400000)) : null);
const sortOpen = (a, b) =>
  severityRank(a.severity) - severityRank(b.severity) || (b.published_at ?? '').localeCompare(a.published_at ?? '');

// Does advisory `rec` affect `version` of `name`? Handles OSV event lists and repo-level ranges.
const asList = (x) => (Array.isArray(x) ? x : x ? [x] : []);

export function affects(rec, name, version) {
  for (const p of rec.packages ?? []) {
    if (p.name !== name) continue;
    if (p.range) { if (satisfies(version, p.range)) return true; continue; } // legacy GitHub-shaped entry
    if ((p.versions ?? []).includes(version)) return true;
    const intro = asList(p.introduced).map((v) => (v === '0' ? '0.0.0' : parseableVersion(v))).filter(Boolean).sort(compare);
    const fixed = asList(p.fixed).map(parseableVersion).filter(Boolean).sort(compare);
    for (const i of intro) {
      if (compare(version, i) < 0) continue;
      const f = fixed.find((x) => compare(x, i) > 0);
      if (!f || compare(version, f) < 0) return true;
    }
  }
  for (const p of rec.repoPackages ?? []) {
    if (p.name === name && p.range && satisfies(version, p.range)) return true;
  }
  return false;
}

// The upgrade target starts as the highest fixed version among the advisories that hit the
// installed version, then climbs past any advisory that hits the target itself, so the command
// never lands on a version with its own open advisory.
function climb(name, to, advisories) {
  for (let i = 0; i < 10 && to; i += 1) {
    let next = null;
    for (const rec of Object.values(advisories)) {
      if (!affects(rec, name, to)) continue;
      const candidates = [
        ...(rec.packages ?? []).filter((p) => p.name === name).flatMap((p) => asList(p.fixed)),
        ...(rec.repoPackages ?? []).filter((p) => p.name === name).map((p) => p.fixed),
      ].map(parseableVersion).filter(Boolean).filter((f) => compare(f, to) > 0).sort(compare);
      if (candidates[0] && (!next || compare(candidates[0], next) > 0)) next = candidates[0];
    }
    if (!next) return to;
    to = next;
  }
  return to;
}

function upgradesFor(open, advisories) {
  const byPkg = new Map();
  for (const o of open) {
    const row = byPkg.get(o.package) ?? { package: o.package, from: new Set(), transitive: new Set(), to: null, closes: 0, worst: o.severity };
    row.from.add(o.installed);
    if (o.direct === false) row.transitive.add(o.installed);
    row.closes += 1;
    if (severityRank(o.severity) < severityRank(row.worst)) row.worst = o.severity;
    const f = parseableVersion(o.fixed);
    if (f && (!row.to || compare(f, row.to) > 0)) row.to = f;
    byPkg.set(o.package, row);
  }
  return [...byPkg.values()]
    .sort((a, b) => severityRank(a.worst) - severityRank(b.worst) || b.closes - a.closes)
    .map((r) => ({ ...r, from: [...r.from].sort(compare), transitive: [...r.transitive].sort(compare), to: climb(r.package, r.to, advisories) }));
}

function notesFor(label, upgrades) {
  const notes = [];
  for (const u of upgrades) {
    if (!u.to) notes.push(`${u.package}: no fixed version is published yet; the only remedy is removing or replacing it.`);
    if (!u.transitive.length) continue;
    const all = u.transitive.length === u.from.length;
    notes.push(
      `${u.package} ${u.transitive.join(', ')} is not a direct dependency of ${label}: it comes through another package. ` +
      `${all ? 'pnpm up will not move it' : 'pnpm up moves only the direct copy'}; upgrade the package that pulls it in, or add a pnpm override for ${u.package}@${u.to ?? 'a fixed version'}.`,
    );
  }
  return notes;
}

function commandFor(app, upgrades) {
  const targets = upgrades.filter((u) => u.to && u.transitive.length < u.from.length).map((u) => `${u.package}@${u.to}`);
  if (!targets.length) return null;
  const dir = app.lockfile.includes('/') ? app.lockfile.slice(0, app.lockfile.lastIndexOf('/')) : '.';
  const tool = /package-lock\.json$/.test(app.lockfile) ? 'npm install' : /yarn\.lock$/.test(app.lockfile) ? 'yarn up' : 'pnpm up';
  return `${dir === '.' ? '' : `cd ${dir} && `}${tool} ${targets.join(' ')}`;
}

const statusOf = (open, broken) => {
  if (broken) return 'UNKNOWN';
  if (open.some((o) => isUrgent(o.severity))) return 'RED';
  return open.length ? 'AMBER' : 'GREEN';
};
const RANK = { RED: 0, UNKNOWN: 1, AMBER: 2, GREEN: 3 };

/**
 * @param {object} args
 * @param {Date} args.now
 * @param {Array} args.apps        [{ project, branch, label, kind, repo, lockfile, ok, error, versions: Map, direct: Map|null, node,
 *                                   open: [{ id, package, installed, fixed, early }] }]
 * @param {object} args.advisories state.advisories: id -> { severity, summary, cve, url, published_at, firstSeen, sources, malicious, packages, repoPackages }
 * @param {Map} args.published     "name@fixed" -> true | false | null
 */
export function buildReport({ now, apps, advisories, published = new Map(), feedAlerts = [], watchlist = {}, counts = {}, errors = [], warnings = [] }) {
  const byAdvisory = new Map(); // id -> { ...rec summary, hits: [{ project, branch, label, kind, installed }] }
  const fullOpen = []; // every app's complete open list, index-aligned with appRows (tooling rows omit theirs)

  const appRows = apps.map((app) => {
    const project = app.project ?? app.repo.split('/').pop();
    const branch = app.branch ?? null;
    const kind = app.kind ?? 'app';
    const base = { project, branch, kind, repo: app.repo, lockfile: app.lockfile, label: app.label };
    if (!app.ok) {
      fullOpen.push([]);
      return { ...base, ok: false, error: app.error ?? 'lockfile could not be read', installed: {}, open: [], counts: {}, upgrades: [], notes: [], command: null };
    }
    const label = app.label;
    const open = (app.open ?? []).map((o) => {
      const rec = advisories[o.id] ?? {};
      const sources = rec.sources ?? [];
      const entry = {
        id: o.id,
        severity: rec.severity ?? 'unknown',
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
        fixed: o.fixed ?? null,
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
    const slim = (o) => ({ id: o.id, severity: o.severity, package: o.package, installed: o.installed, fixed: o.fixed, fixedOnNpm: o.fixedOnNpm, direct: o.direct, early: o.early, isNew: o.isNew, openDays: o.openDays });
    const countsBySev = { critical: 0, high: 0, moderate: 0, low: 0, unknown: 0 };
    for (const o of open) countsBySev[o.severity === 'medium' ? 'moderate' : (o.severity in countsBySev ? o.severity : 'unknown')] += 1;
    const upgrades = upgradesFor(open, advisories);
    const installed = Object.fromEntries([...app.versions.entries()].map(([k, v]) => [k, [...v].sort(compare)]).filter(([, v]) => v.length));
    // Build tooling is reported by counts and its worst upgrades only; its per-advisory rows would
    // be half the report and nobody acts on them one by one.
    const tooling = kind === 'tooling';
    return {
      ...base,
      ok: true,
      packages: app.versions.size,
      installed: Object.fromEntries(Object.entries(installed).filter(([k]) => upgrades.some((u) => u.package === k))),
      node: app.node ?? null,
      open: tooling ? [] : open.map(slim),
      openOmitted: tooling ? open.length : 0,
      counts: countsBySev,
      upgrades: tooling ? upgrades.slice(0, 10) : upgrades,
      notes: tooling ? [] : notesFor(label, upgrades),
      command: commandFor(app, upgrades),
    };
  });

  const allOpen = fullOpen.flat();
  const distinct = [...byAdvisory.values()].map(({ hitKeys, projectSet, ...a }) => ({
    ...a,
    apps: hitKeys.size,
    projectBranches: new Set([...hitKeys].map((k) => k.split('/')[0])).size,
    projects: [...projectSet],
  })).sort(sortOpen);

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
      return {
        project: rows[0].project,
        branch: rows[0].branch,
        repo: rows[0].repo,
        status: statusOf(open, rows.some((a) => !a.ok)),
        appStatus: statusOf(appOpen, rows.some((a) => a.kind === 'app' && !a.ok)),
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
    schema: 3,
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
      sources: ['maintainers’ repository advisories on GitHub (same minute as release)', 'OSV.dev (reviewed, about a week later; includes malicious-package records)'],
    },
    errors,
    warnings,
  };
}
