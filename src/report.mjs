// Builds report.json: everything a reader (a person, or the Claude routine that writes the
// daily email) needs to say what is open, what is new, and what to upgrade. Pure: no I/O.

import { matchInstalled } from './advisories.mjs';
import { compare, parseableVersion, satisfies } from './semver.mjs';
import { severityRank, isUrgent } from './format.mjs';

export const NEW_WINDOW_HOURS = 26;

const within = (iso, now, hours) => Boolean(iso) && now.getTime() - new Date(iso).getTime() <= hours * 3600 * 1000;

const sortOpen = (a, b) =>
  severityRank(a.severity) - severityRank(b.severity) || (b.published_at ?? '').localeCompare(a.published_at ?? '');

// The upgrade target starts as the highest fixed version among the advisories that hit the
// installed version, then climbs past any advisory that hits the target itself, so the command
// never lands on a version with its own open advisory (sanitize-html 2.18.0 was fixed again in 2.18.1).
function climb(name, to, advisories) {
  for (let i = 0; i < 10 && to; i += 1) {
    let next = null;
    for (const rec of Object.values(advisories)) {
      for (const p of rec.packages) {
        if (p.name !== name || !p.range || !satisfies(to, p.range)) continue;
        const f = parseableVersion(p.fixed);
        if (f && compare(f, to) > 0 && (!next || compare(f, next) > 0)) next = f;
      }
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
    .map((r) => ({
      ...r,
      from: [...r.from].sort(compare),
      transitive: [...r.transitive].sort(compare),
      to: climb(r.package, r.to, advisories),
    }));
}

// Facts a developer needs before running the command, stated once per app.
function notesFor(label, upgrades) {
  const notes = [];
  for (const u of upgrades) {
    if (!u.transitive.length) continue;
    const all = u.transitive.length === u.from.length;
    notes.push(
      `${u.package} ${u.transitive.join(', ')} is not a direct dependency of ${label}: it comes through another package. ` +
      `${all ? 'pnpm up will not move it' : 'pnpm up moves only the direct copy'}; upgrade the package that pulls it in, or add a pnpm override for ${u.package}@${u.to}.`,
    );
  }
  return notes;
}

const daysSince = (iso, now) => (iso ? Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 86400000)) : null);

function commandFor(app, upgrades) {
  const targets = upgrades.filter((u) => u.to).map((u) => `${u.package}@${u.to}`);
  if (!targets.length) return null;
  const dir = app.lockfile.includes('/') ? app.lockfile.slice(0, app.lockfile.lastIndexOf('/')) : '.';
  return `${dir === '.' ? '' : `cd ${dir} && `}pnpm up ${targets.join(' ')}`;
}

/**
 * @param {object} args
 * @param {Date} args.now
 * @param {Array} args.apps            repoStatus rows from watch.mjs: { repo, lockfile, label, ok, versions: Map, node }
 * @param {object} args.advisories     state.advisories: id -> { severity, summary, cve, url, published_at, packages, firstSeen }
 * @param {Map} args.published         "name@fixed" -> true | false | null, from the npm registry
 * @param {Array} args.feedAlerts      [{ feed, item }] new this run
 * @param {object} args.watchlist
 * @param {string[]} args.errors
 * @param {string[]} args.warnings
 */
export function buildReport({ now, apps, advisories, published = new Map(), feedAlerts = [], watchlist, errors = [], warnings = [] }) {
  const openIds = new Set();
  const appRows = apps.map((app) => {
    const project = app.project ?? app.repo.split('/').pop();
    const branch = app.branch ?? null;
    if (!app.ok) {
      return { project, branch, repo: app.repo, lockfile: app.lockfile, label: app.label, ok: false, error: app.error ?? 'lockfile could not be read', installed: {}, open: [], counts: {}, upgrades: [], notes: [], command: null };
    }
    const open = [];
    for (const [id, rec] of Object.entries(advisories)) {
      for (const h of matchInstalled(rec.packages, app.versions)) {
        openIds.add(id);
        const sources = rec.sources ?? (rec.source ? [rec.source] : []);
        open.push({
          id,
          severity: rec.severity,
          cve: rec.cve ?? null,
          summary: rec.summary,
          url: rec.url,
          published_at: rec.published_at,
          openDays: daysSince(rec.published_at, now),
          firstSeen: rec.firstSeen,
          isNew: within(rec.firstSeen, now, NEW_WINDOW_HOURS),
          // Published by the maintainers but not yet reviewed into the GitHub Advisory Database:
          // the window in which pnpm audit, Dependabot and OSV still say "clean".
          early: sources.length > 0 && !sources.includes('global'),
          package: h.pkg,
          installed: h.installed,
          // true = the app declares it; false = pulled in by another package; null = lockfile does not say
          direct: app.direct ? app.direct.get(h.pkg)?.has(h.installed) ?? false : null,
          fixed: h.fixed ?? null,
          fixedOnNpm: published.get(`${h.pkg}@${h.fixed}`) ?? null,
        });
      }
    }
    open.sort(sortOpen);
    const counts = { critical: 0, high: 0, moderate: 0, low: 0, unknown: 0 };
    for (const o of open) counts[o.severity === 'medium' ? 'moderate' : (o.severity in counts ? o.severity : 'unknown')] += 1;
    const upgrades = upgradesFor(open, advisories);
    const installed = Object.fromEntries(
      [...app.versions.entries()].map(([k, v]) => [k, [...v].sort(compare)]).filter(([, v]) => v.length),
    );
    return {
      project,
      branch,
      repo: app.repo,
      lockfile: app.lockfile,
      label: app.label,
      ok: true,
      installed,
      node: app.node ?? null,
      open,
      counts,
      upgrades,
      notes: notesFor(app.label, upgrades),
      command: commandFor(app, upgrades),
    };
  });

  const allOpen = appRows.flatMap((a) => a.open);
  const summary = {
    open: allOpen.length,
    critical: allOpen.filter((o) => o.severity === 'critical').length,
    high: allOpen.filter((o) => o.severity === 'high').length,
    moderate: allOpen.filter((o) => o.severity === 'moderate' || o.severity === 'medium').length,
    low: allOpen.filter((o) => o.severity === 'low').length,
    newOpen: allOpen.filter((o) => o.isNew).length,
    early: allOpen.filter((o) => o.early).length,
    oldestCriticalOpenDays: Math.max(0, ...allOpen.filter((o) => isUrgent(o.severity)).map((o) => o.openDays ?? 0)),
  };

  const newNotAffecting = Object.entries(advisories)
    .filter(([id, rec]) => !openIds.has(id) && within(rec.firstSeen, now, NEW_WINDOW_HOURS))
    .map(([id, rec]) => ({
      id,
      severity: rec.severity,
      packages: [...new Set(rec.packages.map((p) => p.name))],
      summary: rec.summary,
      url: rec.url,
      published_at: rec.published_at,
      fixed: rec.packages.map((p) => p.fixed).find(Boolean) ?? null,
    }))
    .sort(sortOpen);
  summary.newNotAffecting = newNotAffecting.length;

  const statusOf = (open, broken) => {
    if (broken) return 'UNKNOWN';
    if (open.some((o) => isUrgent(o.severity))) return 'RED';
    return open.length ? 'AMBER' : 'GREEN';
  };
  const status = statusOf(allOpen, errors.length > 0 || appRows.some((a) => !a.ok));

  // One row per (repo, branch), so a reader can say "project X on main is RED, on staging AMBER,
  // projects Y and Z are clear" without walking every app. Order: worst first, then name, then branch.
  const RANK = { RED: 0, UNKNOWN: 1, AMBER: 2, GREEN: 3 };
  const keyOf = (a) => `${a.project}\u0000${a.branch ?? ''}`;
  const projects = [...new Set(appRows.map(keyOf))]
    .map((key) => {
      const rows = appRows.filter((a) => keyOf(a) === key);
      const open = rows.flatMap((a) => a.open);
      return {
        project: rows[0].project,
        branch: rows[0].branch,
        repo: rows[0].repo,
        status: statusOf(open, rows.some((a) => !a.ok)),
        open: open.length,
        critical: open.filter((o) => o.severity === 'critical').length,
        high: open.filter((o) => o.severity === 'high').length,
        newOpen: open.filter((o) => o.isNew).length,
        early: open.filter((o) => o.early).length,
        apps: rows.map((a) => a.label),
        affectedApps: rows.filter((a) => a.open.length).map((a) => a.label),
      };
    })
    .sort((a, b) => RANK[a.status] - RANK[b.status] || a.project.localeCompare(b.project) || String(a.branch).localeCompare(String(b.branch)));

  return {
    schema: 2,
    generatedAt: now.toISOString(),
    status,
    summary,
    projects,
    apps: appRows,
    newNotAffecting,
    feedItemsNew: feedAlerts.map(({ feed, item }) => ({ feed: feed.name, title: item.title, link: item.link, date: item.date })),
    checked: {
      packages: watchlist.packages.map((p) => p.name),
      projects: projects.length,
      apps: apps.length,
      advisoriesKnown: Object.keys(advisories).length,
      sources: ['GitHub repository advisories (maintainer, same minute as release)', 'GitHub Advisory Database (reviewed, about a week later)'],
    },
    errors,
    warnings,
  };
}
