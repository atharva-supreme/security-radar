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
    const row = byPkg.get(o.package) ?? { package: o.package, from: new Set(), to: null, closes: 0 };
    row.from.add(o.installed);
    row.closes += 1;
    const f = parseableVersion(o.fixed);
    if (f && (!row.to || compare(f, row.to) > 0)) row.to = f;
    byPkg.set(o.package, row);
  }
  return [...byPkg.values()].map((r) => ({ ...r, from: [...r.from].sort(compare), to: climb(r.package, r.to, advisories) }));
}

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
    if (!app.ok) {
      return { repo: app.repo, lockfile: app.lockfile, label: app.label, ok: false, error: app.error ?? 'lockfile could not be read', installed: {}, open: [], counts: {}, upgrades: [], command: null };
    }
    const open = [];
    for (const [id, rec] of Object.entries(advisories)) {
      for (const h of matchInstalled(rec.packages, app.versions)) {
        openIds.add(id);
        open.push({
          id,
          severity: rec.severity,
          cve: rec.cve ?? null,
          summary: rec.summary,
          url: rec.url,
          published_at: rec.published_at,
          firstSeen: rec.firstSeen,
          isNew: within(rec.firstSeen, now, NEW_WINDOW_HOURS),
          package: h.pkg,
          installed: h.installed,
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
      repo: app.repo,
      lockfile: app.lockfile,
      label: app.label,
      ok: true,
      installed,
      node: app.node ?? null,
      open,
      counts,
      upgrades,
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

  let status = 'GREEN';
  if (allOpen.some((o) => isUrgent(o.severity))) status = 'RED';
  else if (allOpen.length) status = 'AMBER';
  if (errors.length || appRows.some((a) => !a.ok)) status = 'UNKNOWN';

  return {
    schema: 1,
    generatedAt: now.toISOString(),
    status,
    summary,
    apps: appRows,
    newNotAffecting,
    feedItemsNew: feedAlerts.map(({ feed, item }) => ({ feed: feed.name, title: item.title, link: item.link, date: item.date })),
    checked: {
      packages: watchlist.packages.map((p) => p.name),
      apps: apps.length,
      advisoriesKnown: Object.keys(advisories).length,
      sources: ['GitHub repository advisories (maintainer, same minute as release)', 'GitHub Advisory Database (reviewed, about a week later)'],
    },
    errors,
    warnings,
  };
}
