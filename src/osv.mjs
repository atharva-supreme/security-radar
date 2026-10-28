// OSV.dev: the complete layer. For npm it mirrors the GitHub-reviewed advisory set (about a week
// behind the maintainers' own advisories) plus the MAL- malicious-package records. Its batch
// query matches versions server-side, 1000 package@version pairs per request, no key, no quota.

import { compare, parseableVersion } from './semver.mjs';

const API = 'https://api.osv.dev/v1';
const headers = { 'content-type': 'application/json', 'user-agent': 'security-radar' };

async function post(path, body) {
  const res = await fetch(`${API}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`OSV POST ${path} -> ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return res.json();
}

// pairs: [{ name, version }] -> Map "name@version" -> [{ id, modified }]
export async function queryBatch(pairs, { chunk = 1000 } = {}) {
  const out = new Map();
  for (let i = 0; i < pairs.length; i += chunk) {
    const slice = pairs.slice(i, i + chunk);
    const body = { queries: slice.map((p) => ({ package: { name: p.name, ecosystem: 'npm' }, version: p.version })) };
    let res = await post('/querybatch', body);
    // A result may be paged for a very vulnerable package@version; follow it.
    for (let k = 0; k < slice.length; k++) {
      const r = res.results[k] ?? {};
      let vulns = r.vulns ?? [];
      let token = r.next_page_token;
      while (token) {
        const more = await post('/querybatch', { queries: [{ ...body.queries[k], page_token: token }] });
        vulns = vulns.concat(more.results[0]?.vulns ?? []);
        token = more.results[0]?.next_page_token;
      }
      out.set(`${slice[k].name}@${slice[k].version}`, vulns.map((v) => ({ id: v.id, modified: v.modified })));
    }
  }
  return out;
}

export async function vuln(id) {
  const res = await fetch(`${API}/vulns/${encodeURIComponent(id)}`, { headers });
  if (!res.ok) throw new Error(`OSV GET /vulns/${id} -> ${res.status}`);
  return res.json();
}

// The fields a report needs, small enough to cache per advisory.
export function trim(v) {
  const ghsaUrl = (v.references ?? []).find((r) => /github\.com\/.+\/security\/advisories\/GHSA-/.test(r.url))?.url;
  const advisoryUrl = (v.references ?? []).find((r) => r.type === 'ADVISORY')?.url;
  const severity = (v.database_specific?.severity ?? '').toLowerCase()
    || (v.id.startsWith('MAL-') ? 'critical' : 'unknown');
  const packages = [];
  for (const a of v.affected ?? []) {
    if ((a.package?.ecosystem ?? '').toLowerCase() !== 'npm') continue;
    const fixed = [];
    const introduced = [];
    for (const r of a.ranges ?? []) {
      for (const e of r.events ?? []) {
        if (e.fixed) fixed.push(e.fixed);
        if (e.introduced) introduced.push(e.introduced);
      }
    }
    packages.push({ name: a.package.name, introduced, fixed, versions: a.versions ?? [] });
  }
  return {
    id: v.id,
    aliases: v.aliases ?? [],
    cve: (v.aliases ?? []).find((x) => x.startsWith('CVE-')) ?? null,
    summary: v.summary ?? (v.details ?? '').split('\n')[0].slice(0, 160),
    severity,
    malicious: v.id.startsWith('MAL-'),
    published_at: v.published,
    modified_at: v.modified,
    url: ghsaUrl ?? advisoryUrl ?? `https://osv.dev/vulnerability/${v.id}`,
    packages,
  };
}

// The fixed version for an installed version: the smallest "fixed" event above it on the same
// major line, else the smallest above it at all, else null.
export function fixedFor(pkg, installed) {
  const list = Array.isArray(pkg.fixed) ? pkg.fixed : pkg.fixed ? [pkg.fixed] : [];
  const candidates = list.map(parseableVersion).filter(Boolean).filter((f) => compare(f, installed) > 0).sort(compare);
  const major = installed.split('.')[0];
  return candidates.find((f) => f.split('.')[0] === major) ?? candidates[0] ?? null;
}
