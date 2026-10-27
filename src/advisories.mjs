// Combines the two GitHub sources for one advisory into one list of { name, range, fixed }.
//
// Global entries are reviewed and precise but often carry no fixed version in the REST shape.
// Repository entries arrive first, carry the fixed version the maintainer typed, but their
// ranges are hand-written and frequently open-ended, with placeholders like "16.3.?".

import { compare, satisfies, hasUpperBound, upperBound, lowerBounds, normaliseRange, parseableVersion } from './semver.mjs';

const satisfiesLower = (version, range) =>
  lowerBounds(range).every((c) => (c.op === '>=' ? compare(version, c.version) >= 0 : compare(version, c.version) > 0));

export function resolvePackages(repoEntries = [], globalEntries = []) {
  if (globalEntries.length) {
    return globalEntries.map((g) => {
      let fixed = parseableVersion(g.fixed);
      const ub = upperBound(g.range);
      if (!fixed && ub?.op === '<') fixed = ub.version;
      if (!fixed) {
        // Borrow the maintainer's fixed version for the same package and version line.
        const candidates = repoEntries
          .filter((r) => r.name === g.name)
          .map((r) => parseableVersion(r.fixed))
          .filter(Boolean)
          .sort(compare);
        fixed =
          candidates.find((f) => satisfiesLower(f, g.range) && (!ub || compare(f, ub.version) > 0)) ??
          repoEntries.find((r) => r.name === g.name && r.fixed)?.fixed ??
          null;
      }
      return { name: g.name, range: normaliseRange(g.range), fixed };
    });
  }

  return repoEntries.map((r) => {
    const fixed = r.fixed ?? null;
    const pf = parseableVersion(fixed);
    let range = r.range ?? null;
    if (range && !hasUpperBound(range) && pf) range = `${range}, < ${pf}`;
    return { name: r.name, range: normaliseRange(range), fixed };
  });
}

// One hit per (package, installed version): the entry whose fixed version shares the installed major,
// so a 16.x install is told "fixed in 16.3.8", not "fixed in 15.5.27".
export function matchInstalled(packages, versionsByName) {
  const hits = new Map();
  for (const p of packages) {
    for (const v of versionsByName.get(p.name) ?? []) {
      if (!p.range || !satisfies(v, p.range)) continue;
      const key = `${p.name}@${v}`;
      const prev = hits.get(key);
      const sameLine = (f) => f && parseableVersion(f) && parseableVersion(f).split('.')[0] === v.split('.')[0];
      if (!prev || (!sameLine(prev.fixed) && sameLine(p.fixed))) hits.set(key, { pkg: p.name, installed: v, fixed: p.fixed });
    }
  }
  return [...hits.values()];
}
