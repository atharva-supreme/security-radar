#!/usr/bin/env node
// Security Radar (automated dependency vulnerability monitoring): one scan = read every lockfile
// in the watchlist, check every package in it against two advisory sources, write report.json.
//
//   node watch.mjs                 scan, then write state.json, packages.json and report.json
//   node watch.mjs --dry-run       scan and write report.json only; state and caches untouched
//   node watch.mjs --forget A,B    drop advisory ids from state first, so they count as new again
//
// Sources, in the order they matter:
//   1. The maintainers' own repository advisories on GitHub, found through each package's npm
//      "repository" field. Published the same minute as the fix. Conditional requests (ETag), so
//      an unchanged repo costs nothing against the rate limit.
//   2. OSV.dev, batch-queried for every package@version we have installed. Complete and reviewed,
//      about a week behind source 1, and the only source for MAL- (malicious package) records.
//   3. The Node.js vulnerability feed, since Node is not an npm package.
//
// Environment:
//   GITHUB_TOKEN       advisory calls (the workflow's own token is enough)
//   REPO_READ_TOKEN    read-only Contents on the repos in watchlist.json; falls back to GITHUB_TOKEN
//   SCAN_CONCURRENCY   parallel requests per source (default 4)

import { readFile, writeFile } from 'node:fs/promises';
import { makeClient, normalise } from './src/github.mjs';
import { queryBatch, vuln as osvVuln, trim as osvTrim, fixedFor } from './src/osv.mjs';
import { repoOf, published, pool } from './src/npm.mjs';
import { resolvePackages, matchInstalled } from './src/advisories.mjs';
import { installedVersions, directVersions, declaredNode } from './src/lockfile.mjs';
import { fetchFeed } from './src/feeds.mjs';
import { buildReport } from './src/report.mjs';

// ---------- arguments and files ----------

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const dryRun = flag('--dry-run');
const forget = (option('--forget') ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const ROOT = new URL('.', import.meta.url);
const readJson = async (name, fallback) => { try { return JSON.parse(await readFile(new URL(name, ROOT), 'utf8')); } catch { return fallback; } };
const watchlist = await readJson('watchlist.json', null);
if (!watchlist) throw new Error('watchlist.json missing');
const state = await readJson('state.json', {});
state.advisories ??= {};
state.etags ??= {};
state.feeds ??= {};
const packages = await readJson('packages.json', {}); // npm name -> { repo, checkedAt }

const env = process.env;
const now = new Date();
const nowIso = now.toISOString();
const concurrency = Number(env.SCAN_CONCURRENCY ?? 4);
const gh = makeClient({ token: env.GITHUB_TOKEN });
const ghRepos = env.REPO_READ_TOKEN ? makeClient({ token: env.REPO_READ_TOKEN }) : gh;
const errors = [];   // a whole source failed: the run exits non-zero
const warnings = []; // degraded but usable: one lockfile or one repo could not be read
const log = (...a) => console.log(...a);
const olderThanWeek = (iso) => Boolean(iso) && now.getTime() - new Date(iso).getTime() > 7 * 24 * 3600 * 1000;

for (const id of forget) {
  if (state.advisories[id]) { delete state.advisories[id]; log(`forgot ${id}`); }
}

// ---------- 1. apps: one per (repo row, branch), with everything each lockfile has installed ----------

const defaultBranches = watchlist.branches ?? [null];
const appRows = (watchlist.repos ?? []).flatMap((r) =>
  (r.branches ?? (r.ref ? [r.ref] : defaultBranches)).map((branch) => {
    const dirOf = (p) => (p && p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
    const dir = dirOf(r.lockfile) || dirOf(r.packageJson);
    return {
      ...r,
      ref: branch ?? undefined,
      branch: branch ?? 'default',
      project: r.repo.split('/').pop(),
      label: r.label ?? (dir || 'root'),
      kind: r.kind ?? 'app',
    };
  }),
);

const apps = await pool(appRows, concurrency, async (r) => {
  try {
    const text = await ghRepos.fileText(r.repo, r.lockfile, r.ref);
    const versions = installedVersions(text, r.lockfile);
    const direct = directVersions(text, r.lockfile);
    let node = null;
    if (r.packageJson) {
      try { node = declaredNode({ packageJsonText: await ghRepos.fileText(r.repo, r.packageJson, r.ref) }); } catch { /* optional */ }
    }
    return { ...r, versions, direct, node, ok: true };
  } catch (e) {
    warnings.push(`lockfile ${r.repo}@${r.branch}/${r.lockfile}: ${e.message}${e.status === 404 && !env.REPO_READ_TOKEN ? ' (private repo and no REPO_READ_TOKEN set?)' : ''}`);
    return { ...r, ok: false, error: e.message };
  }
});

const pairKeys = new Set();
const names = new Set();
for (const a of apps) {
  if (!a.ok) continue;
  for (const [name, vs] of a.versions) { names.add(name); for (const v of vs) pairKeys.add(`${name}@${v}`); }
}
const pairs = [...pairKeys].map((k) => { const i = k.lastIndexOf('@'); return { name: k.slice(0, i), version: k.slice(i + 1) }; });
log(`${apps.length} apps (${apps.filter((a) => a.ok).length} read), ${names.size} packages, ${pairs.length} package@version pairs`);

// ---------- 2. OSV: every pair, batched ----------

let osvHits = new Map(); // "name@version" -> [{ id, modified }]
try {
  osvHits = await queryBatch(pairs);
} catch (e) { errors.push(`osv querybatch: ${e.message}`); }

const osvIds = new Map(); // id -> latest modified seen
for (const list of osvHits.values()) for (const v of list) {
  if (!osvIds.has(v.id) || osvIds.get(v.id) < v.modified) osvIds.set(v.id, v.modified);
}
// Refetch only when OSV's own "modified" stamp moved. The batch and detail endpoints format the
// stamp differently, so the batch value is remembered as-is and compared as a string next time.
const stale = [...osvIds].filter(([id, modified]) => !state.advisories[id]?.osv || state.advisories[id].osvModified !== modified);
log(`osv: ${osvIds.size} advisories hit, ${stale.length} to fetch`);
await pool(stale, concurrency * 2, async ([id, modified]) => {
  try {
    const rec = osvTrim(await osvVuln(id));
    const prev = state.advisories[id] ?? {};
    state.advisories[id] = {
      ...prev,
      ...rec,
      osv: true,
      osvModified: modified,
      repoPackages: prev.repoPackages ?? null,
      sources: [...new Set([...(prev.sources ?? []), 'osv'])],
      firstSeen: prev.firstSeen ?? (olderThanWeek(rec.published_at) ? rec.published_at : nowIso),
    };
  } catch (e) { warnings.push(`osv vuln ${id}: ${e.message}`); }
});

// ---------- 3. repository-level advisories for every package's GitHub repo ----------

const unknownNames = [...names].filter((n) => !packages[n] || (packages[n].repo === null && olderThanWeek(packages[n].checkedAt) && !packages[n].missing));
log(`npm: ${names.size} packages, ${unknownNames.length} repo lookups`);
await pool(unknownNames, concurrency * 2, async (name) => {
  try { packages[name] = await repoOf(name); } catch (e) { warnings.push(`npm ${name}: ${e.message}`); }
});

const repoToNames = new Map();
for (const n of names) {
  const repo = packages[n]?.repo;
  if (!repo) continue;
  repoToNames.set(repo, [...(repoToNames.get(repo) ?? []), n]);
}
// Budget: never spend the last 150 requests of the hour. A 304 answer is free, so repos with a
// cached ETag go first; repos never polled before are spread over as many runs as the limit needs.
let budget = Infinity;
try {
  const rl = await gh.rateLimit();
  budget = rl.resources.core.remaining - 150;
  log(`github: ${rl.resources.core.remaining}/${rl.resources.core.limit} requests left this hour, budget ${Math.max(0, budget)}`);
} catch { /* unknown limit: go ahead */ }
const repoQueue = [...repoToNames].sort(([a], [b]) => (state.etags[b] ? 1 : 0) - (state.etags[a] ? 1 : 0));
const repoStats = { polled: 0, unchanged: 0, updated: 0, failed: 0, deferred: 0 };
let rateLimited = false;
await pool(repoQueue, concurrency, async ([repo, pkgNames]) => {
  if (rateLimited || budget <= 0) { repoStats.deferred += 1; return; }
  repoStats.polled += 1;
  budget -= 1;
  try {
    const res = await gh.repoAdvisories(repo, state.etags[repo]);
    if (res.notModified) { repoStats.unchanged += 1; budget += 1; return; }
    repoStats.updated += 1;
    state.etags[repo] = res.etag;
    const wanted = new Set(pkgNames);
    for (const raw of res.data) {
      const rec = normalise(raw, `repo:${repo}`, wanted);
      const relevant = rec.packages.filter((p) => wanted.has(p.name));
      if (!relevant.length) continue;
      const prev = state.advisories[rec.id] ?? {};
      state.advisories[rec.id] = {
        ...prev,
        id: rec.id,
        cve: prev.cve ?? rec.cve,
        summary: prev.summary ?? rec.summary,
        severity: prev.severity && prev.severity !== 'unknown' ? prev.severity : rec.severity,
        published_at: prev.published_at && prev.published_at < rec.published_at ? prev.published_at : rec.published_at,
        updated_at: rec.updated_at,
        url: prev.url ?? rec.url,
        packages: prev.packages ?? [],
        repoPackages: relevant,
        repo,
        sources: [...new Set([...(prev.sources ?? []), 'repo'])],
        firstSeen: prev.firstSeen ?? (olderThanWeek(rec.published_at) ? rec.published_at : nowIso),
      };
    }
  } catch (e) {
    repoStats.failed += 1;
    if (e.status === 403 && /rate limit/i.test(e.message)) { rateLimited = true; errors.push(`github rate limit hit after ${repoStats.polled} repos: ${e.message}`); }
    else if (e.status === 404) { /* repo moved or private: nothing to read */ }
    else warnings.push(`repo advisories ${repo}: ${e.message}`);
  }
});
log(`github: ${repoStats.polled} repos polled, ${repoStats.unchanged} unchanged, ${repoStats.updated} updated, ${repoStats.failed} failed, ${repoStats.deferred} deferred to the next run`);
if (repoStats.deferred) warnings.push(`${repoStats.deferred} package repositories not polled this run (rate-limit budget); they are picked up on the next run`);

// ---------- 4. feeds ----------

const feedAlerts = [];
for (const feed of watchlist.feeds ?? []) {
  try {
    const items = await fetchFeed(feed.url);
    for (const item of items) {
      if (!item.link || state.feeds[item.link]) continue;
      state.feeds[item.link] = { feed: feed.name, title: item.title, date: item.date, firstSeen: nowIso };
      if (!olderThanWeek(item.date)) feedAlerts.push({ feed, item });
    }
  } catch (e) { errors.push(`feed ${feed.name}: ${e.message}`); }
}

// ---------- 5. match: what is open in each app ----------

// id -> resolved repo-level ranges, computed once
const repoRanges = new Map();
for (const [id, rec] of Object.entries(state.advisories)) {
  if (rec.repoPackages?.length) repoRanges.set(id, resolvePackages(rec.repoPackages, []));
}

for (const a of apps) {
  a.open = [];
  if (!a.ok) continue;
  const seen = new Set();
  // OSV: exact hits per pair
  for (const [name, vs] of a.versions) {
    for (const v of vs) {
      for (const hit of osvHits.get(`${name}@${v}`) ?? []) {
        const rec = state.advisories[hit.id];
        if (!rec) continue;
        const key = `${hit.id}|${name}|${v}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const pkg = (rec.packages ?? []).find((p) => p.name === name);
        a.open.push({ id: hit.id, package: name, installed: v, fixed: pkg ? fixedFor(pkg, v) : null, early: false });
      }
    }
  }
  // Repository-level: range matching, for advisories OSV has not caught up with
  for (const [id, pkgs] of repoRanges) {
    for (const h of matchInstalled(pkgs, a.versions)) {
      const key = `${id}|${h.pkg}|${h.installed}`;
      if (seen.has(key)) continue;
      seen.add(key);
      a.open.push({ id, package: h.pkg, installed: h.installed, fixed: h.fixed ?? null, early: true });
    }
  }
}

// Is the named fixed version actually on npm? Checked once per package@fixed.
const fixedKeys = new Set();
for (const a of apps) for (const o of a.open) if (o.fixed && /^\d+\.\d+\.\d+/.test(o.fixed)) fixedKeys.add(`${o.package}@${o.fixed}`);
const publishedMap = new Map();
await pool([...fixedKeys], concurrency * 2, async (key) => {
  const i = key.lastIndexOf('@');
  publishedMap.set(key, await published(key.slice(0, i), key.slice(i + 1)));
});

// ---------- 6. write ----------

// Caches first: the scan's network work must survive a bug in report building.
if (!dryRun) {
  state.lastRun = nowIso;
  await writeFile(new URL('state.json', ROOT), JSON.stringify(state, null, 1) + '\n');
  await writeFile(new URL('packages.json', ROOT), JSON.stringify(packages, null, 1) + '\n');
  log('state.json and packages.json written');
} else {
  log('dry run: state.json and packages.json not written');
}

const report = buildReport({
  now,
  apps,
  advisories: state.advisories,
  published: publishedMap,
  feedAlerts,
  watchlist,
  counts: { packages: names.size, pairs: pairs.length, reposPolled: repoStats.polled, reposDeferred: repoStats.deferred, osvAdvisories: osvIds.size },
  errors,
  warnings,
});
// Compact on purpose: pretty-printing this file would double its size for nothing a reader needs.
await writeFile(new URL('report.json', ROOT), JSON.stringify(report) + '\n');
log(`report.json written: ${report.status}, ${report.summary.open} open (${report.summary.critical} critical, ${report.summary.high} high), ${report.summary.newOpen} new, ${report.summary.early} early, ${report.advisories.length} distinct advisories across ${report.projects.length} project-branches`);
if (warnings.length) { log(`warnings (${warnings.length}):`); for (const w of warnings.slice(0, 20)) log(`  ${w}`); }
if (errors.length) { log('errors:'); for (const e of errors) log(`  ${e}`); }

try {
  const rl = await gh.rateLimit();
  log(`GitHub rate limit remaining: ${rl.resources.core.remaining}/${rl.resources.core.limit}`);
} catch { /* informational */ }

process.exitCode = errors.length ? 1 : 0;
