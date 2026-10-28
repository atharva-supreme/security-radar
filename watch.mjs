#!/usr/bin/env node
// Security Radar (automated dependency vulnerability monitoring): one run = fetch every source, diff against state.json, post what is new, write state.
//
//   node watch.mjs                 normal run (posts to Slack and opens issues when configured)
//   node watch.mjs --dry-run       fetch and diff, print what would be posted, change nothing
//   node watch.mjs --baseline      record everything currently published without alerting (first run)
//   node watch.mjs --forget A,B    drop advisory ids from state first, so they alert again (testing)
//   node watch.mjs --quiet-summary post the quiet-day summary now regardless of the hour
//   node watch.mjs --scan-only     fetch, compare, write state.json and report.json; post nothing, open nothing
//                                  (what the workflow runs: the Claude routine reads report.json and does the telling)
//
// Every run writes report.json: status, what each app has installed, every open advisory with
// its fixed version, the upgrade command per app, and what is new in the last 26 hours.
//
// Environment:
//   GITHUB_TOKEN       advisory calls and issue creation (the workflow's own token is enough)
//   REPO_READ_TOKEN    read-only Contents on the repos in watchlist.json (fine-grained PAT); falls back to GITHUB_TOKEN
//   SLACK_WEBHOOK_URL  incoming webhook; when unset, nothing is posted to Slack
//   GITHUB_REPOSITORY  owner/name of the repo that holds the tracking issues (set by Actions)
//   QUIET_HOUR_UTC     hour at which the once-a-day quiet summary is posted (default 0 = 05:30 IST)

import { readFile, writeFile } from 'node:fs/promises';
import { makeClient, normalise, npmPublished } from './src/github.mjs';
import { resolvePackages, matchInstalled } from './src/advisories.mjs';
import { compare, parseableVersion } from './src/semver.mjs';
import { installedVersions, directVersions, declaredNode } from './src/lockfile.mjs';
import { fetchFeed } from './src/feeds.mjs';
import {
  severityRank, isUrgent, releaseMessage, batchMessage, feedMessage, quietMessage, errorMessage,
  issueTitle, issueBody, feedIssueTitle, feedIssueBody,
} from './src/format.mjs';
import { postSlack, openIssue } from './src/notify.mjs';
import { buildReport } from './src/report.mjs';

// ---------- arguments and files ----------

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const dryRun = flag('--dry-run');
const scanOnly = flag('--scan-only');
const forget = (option('--forget') ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const ROOT = new URL('.', import.meta.url);
const watchlist = JSON.parse(await readFile(new URL('watchlist.json', ROOT), 'utf8'));
const state = JSON.parse(await readFile(new URL('state.json', ROOT), 'utf8'));
state.advisories ??= {};
state.feeds ??= {};

const env = process.env;
const now = new Date();
const nowIso = now.toISOString();
const gh = makeClient({ token: env.GITHUB_TOKEN });
const ghRepos = env.REPO_READ_TOKEN ? makeClient({ token: env.REPO_READ_TOKEN }) : gh;
const watchedNames = new Set(watchlist.packages.map((p) => p.name));
const errors = [];   // a source or a notification failed: the run exits non-zero
const warnings = []; // degraded but usable: a lockfile could not be read, so that repo is "unknown"
const log = (...a) => console.log(...a);

for (const id of forget) {
  if (state.advisories[id]) { delete state.advisories[id]; log(`forgot ${id}`); }
}
const baseline = flag('--baseline') || Object.keys(state.advisories).length === 0;
if (baseline) log('baseline mode: recording everything currently published, alerting on nothing');

// ---------- 1. advisories from both GitHub sources ----------

// Each id keeps what every source said; the two are combined once all fetching is done.
const seen = new Map(); // id -> { meta, repoEntries, globalEntries, sources }
function merge(rec) {
  const relevant = rec.packages.length === 0 || rec.packages.some((p) => watchedNames.has(p.name));
  if (!relevant) return;
  const entry = seen.get(rec.id) ?? { meta: null, repoEntries: [], globalEntries: [], sources: [] };
  // The earliest publication is the one we quote: that is the repo-level advisory, same minute as the release.
  if (!entry.meta || (rec.published_at ?? '') < (entry.meta.published_at ?? '')) entry.meta = { ...rec, cve: rec.cve ?? entry.meta?.cve ?? null };
  else if (!entry.meta.cve && rec.cve) entry.meta.cve = rec.cve;
  (rec.source === 'global' ? entry.globalEntries : entry.repoEntries).push(...rec.packages);
  entry.sources.push(rec.source);
  seen.set(rec.id, entry);
}

const repos = [...new Set(watchlist.packages.map((p) => p.repo).filter(Boolean))];
for (const repo of repos) {
  try {
    for (const raw of await gh.repoAdvisories(repo)) merge(normalise(raw, `repo:${repo}`, watchedNames));
  } catch (e) { errors.push(`repo advisories ${repo}: ${e.message}`); }
}
for (const p of watchlist.packages) {
  try {
    for (const raw of await gh.globalAdvisories(p.name)) merge(normalise(raw, 'global', watchedNames));
  } catch (e) { errors.push(`global advisories ${p.name}: ${e.message}`); }
}

const collected = new Map();
for (const [id, entry] of seen) {
  collected.set(id, {
    ...entry.meta,
    packages: resolvePackages(entry.repoEntries, entry.globalEntries),
    sources: [...new Set(entry.sources)],
  });
}
log(`collected ${collected.size} advisories across ${watchlist.packages.length} packages`);

// ---------- 2. diff against state ----------

const olderThanWeek = (iso) => Boolean(iso) && now.getTime() - new Date(iso).getTime() > 7 * 24 * 3600 * 1000;
const fixedKey = (rec) => rec.packages.map((p) => `${p.name}:${p.fixed ?? ''}`).sort().join('|');
const newAdvisories = [];
const updatedAdvisories = [];
for (const rec of collected.values()) {
  const prev = state.advisories[rec.id];
  if (!prev) newAdvisories.push(rec);
  else if (prev.fixedKey !== fixedKey(rec)) updatedAdvisories.push(rec);
  state.advisories[rec.id] = {
    severity: rec.severity,
    summary: rec.summary,
    cve: rec.cve,
    url: rec.url,
    published_at: rec.published_at,
    updated_at: rec.updated_at,
    source: rec.source,
    sources: rec.sources,
    packages: rec.packages,
    fixedKey: fixedKey(rec),
    // An advisory we meet for the first time more than a week after it was published is history
    // (a package just added to the watchlist, or the baseline run), not news: date it by publication
    // so report.json does not flag twenty old advisories as NEW.
    firstSeen: prev?.firstSeen ?? (baseline || olderThanWeek(rec.published_at) ? rec.published_at ?? nowIso : nowIso),
  };
}

// ---------- 3. feeds ----------

const feedAlerts = [];
for (const feed of watchlist.feeds) {
  try {
    const items = await fetchFeed(feed.url);
    for (const item of items) {
      if (!item.link || state.feeds[item.link]) continue;
      state.feeds[item.link] = { feed: feed.name, title: item.title, date: item.date, firstSeen: nowIso };
      if (!baseline && !feed.informational) feedAlerts.push({ feed, item });
    }
  } catch (e) { errors.push(`feed ${feed.name}: ${e.message}`); }
}
// ---------- 4. what our repos have installed ----------

// One app per (repo row, branch). `branches` at the top of the watchlist applies to every row;
// a row's own `branches` overrides it; a row's `ref` pins a single branch or commit.
const defaultBranches = watchlist.branches ?? [null];
const appRows = watchlist.repos.flatMap((r) =>
  (r.branches ?? (r.ref ? [r.ref] : defaultBranches)).map((branch) => ({ ...r, ref: branch ?? undefined, branch: branch ?? 'default' })),
);
const repoStatus = [];
for (const r of appRows) {
  const dirOf = (p) => (p && p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const dir = dirOf(r.lockfile) || dirOf(r.packageJson);
  // project = the repo's short name; label = the app inside it (the lockfile's folder, or "root").
  const project = r.repo.split('/').pop();
  const label = r.label ?? (dir || 'root');
  try {
    const text = await ghRepos.fileText(r.repo, r.lockfile, r.ref);
    const versions = installedVersions(text, r.lockfile, [...watchedNames]);
    const direct = directVersions(text, r.lockfile, [...watchedNames]);
    let node = null;
    if (r.packageJson) {
      try { node = declaredNode({ packageJsonText: await ghRepos.fileText(r.repo, r.packageJson, r.ref) }); } catch { /* optional */ }
    }
    repoStatus.push({ ...r, project, label, versions, direct, node, ok: true });
  } catch (e) {
    repoStatus.push({ ...r, project, label, ok: false, error: e.message });
    warnings.push(`lockfile ${r.repo}/${r.lockfile}: ${e.message}${e.status === 404 && !env.REPO_READ_TOKEN ? ' (private repo and no REPO_READ_TOKEN set?)' : ''}`);
  }
}

function affectedRepos(rec) {
  const out = { affected: [], clear: [], unknown: [] };
  for (const r of repoStatus) {
    if (!r.ok) { out.unknown.push(r.label); continue; }
    const hits = matchInstalled(rec.packages, r.versions);
    if (hits.length) out.affected.push({ label: r.label, installed: hits.map((h) => `${h.pkg} ${h.installed}`).join(', '), hits });
    else out.clear.push(r.label);
  }
  return out;
}

// One row per (repo, package, installed version): how many advisories it is exposed to,
// the highest fixed version among them, and the oldest publication date.
const openByInstall = new Map();
for (const [id, rec] of Object.entries(state.advisories)) {
  for (const a of affectedRepos(rec).affected) {
    for (const h of a.hits) {
      const key = `${a.label}|${h.pkg}|${h.installed}`;
      const row = openByInstall.get(key) ?? { label: a.label, pkg: h.pkg, installed: h.installed, fixed: null, since: null, ids: [] };
      row.ids.push(id);
      const f = parseableVersion(h.fixed);
      if (f && (!row.fixed || compare(f, row.fixed) > 0)) row.fixed = f;
      if (rec.published_at && (!row.since || rec.published_at < row.since)) row.since = rec.published_at;
      openByInstall.set(key, row);
    }
  }
}
const stillOpen = [...openByInstall.values()].sort((a, b) => a.label.localeCompare(b.label) || a.pkg.localeCompare(b.pkg));
const nodeDeclared = repoStatus.filter((r) => r.ok && r.node).map((r) => ({ label: r.label, node: r.node }));

// ---------- 5. notify ----------

const issueRepo = env.GITHUB_REPOSITORY ?? null;
const webhook = env.SLACK_WEBHOOK_URL ?? null;
const alerts = baseline ? [] : [...newAdvisories, ...updatedAdvisories]
  .sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || (b.published_at ?? '').localeCompare(a.published_at ?? ''));

async function deliver(kind, text) {
  log(`\n--- ${kind}${dryRun ? ' (dry run, not posted)' : scanOnly ? ' (scan only, not posted)' : ''} ---\n${text}\n`);
  if (dryRun || scanOnly) return;
  try { await postSlack(webhook, text); } catch (e) { errors.push(`slack: ${e.message}`); }
}
async function track(title, body, labels) {
  if (dryRun || scanOnly || !issueRepo) return null;
  try { return await openIssue(gh, issueRepo, { title, body, labels }); } catch (e) { errors.push(`issue "${title}": ${e.message}`); return null; }
}

const urgent = alerts.filter((a) => isUrgent(a.severity));
const lower = alerts.filter((a) => !isUrgent(a.severity));

for (const rec of urgent) {
  const repos = affectedRepos(rec);
  const published = new Map();
  for (const p of rec.packages) {
    if (p.fixed && /^\d+\.\d+\.\d+/.test(p.fixed)) published.set(`${p.name}@${p.fixed}`, await npmPublished(p.name, p.fixed));
  }
  const issueUrl = await track(issueTitle(rec), issueBody(rec, repos), ['security', rec.severity]);
  await deliver(`${rec.severity} ${rec.id}`, releaseMessage(rec, repos, { issueUrl, published }));
}
if (lower.length) {
  const entries = [];
  for (const rec of lower) {
    const issueUrl = await track(issueTitle(rec), issueBody(rec, affectedRepos(rec)), ['security', rec.severity]);
    entries.push({ rec, issueUrl });
  }
  await deliver(`${lower.length} lower-severity`, batchMessage(entries));
}
for (const fa of feedAlerts) {
  const issueUrl = await track(feedIssueTitle(fa), feedIssueBody(fa, nodeDeclared), ['security', 'feed']);
  await deliver(`feed ${fa.feed.name}`, feedMessage(fa, nodeDeclared, issueUrl));
}

const quietHour = Number(env.QUIET_HOUR_UTC ?? 0);
const today = nowIso.slice(0, 10);
const quietDue = flag('--quiet-summary') || (now.getUTCHours() === quietHour && state.lastQuietSummary !== today);
if (!baseline && !scanOnly && !alerts.length && !feedAlerts.length && quietDue) {
  await deliver('quiet summary', quietMessage({
    now,
    counts: { packages: watchlist.packages.length, feeds: watchlist.feeds.length, repos: repoStatus.length },
    stillOpen,
    errors: [...errors, ...warnings],
  }));
  if (!dryRun) state.lastQuietSummary = today;
} else if (errors.length && !dryRun && !scanOnly) {
  await deliver('errors', errorMessage([...errors, ...warnings], now));
}

// ---------- 6. write state and report ----------

if (baseline) {
  log(`baseline recorded: ${Object.keys(state.advisories).length} advisories, ${Object.keys(state.feeds).length} feed items`);
}
log(`new: ${newAdvisories.length}, updated: ${updatedAdvisories.length}, feed items: ${feedAlerts.length}, installs still exposed: ${stillOpen.length}`);
for (const o of stillOpen) log(`  open  ${o.label}: ${o.pkg} ${o.installed} -> ${o.fixed ?? 'not stated'} (${o.ids.length} advisories, oldest ${o.since?.slice(0, 10)})`);
if (warnings.length) { log('warnings:'); for (const w of warnings) log(`  ${w}`); }
if (errors.length) { log('errors:'); for (const e of errors) log(`  ${e}`); }

if (!dryRun) {
  state.lastRun = nowIso;
  await writeFile(new URL('state.json', ROOT), JSON.stringify(state, null, 2) + '\n');
  log('state.json written');
} else {
  log('dry run: state.json not written');
}

// report.json is written on every run, dry or not: it is the hand-off to whoever does the telling.
const published = new Map();
for (const o of stillOpen) {
  for (const id of o.ids) {
    for (const p of state.advisories[id].packages) {
      if (p.name !== o.pkg || !p.fixed || !/^\d+\.\d+\.\d+/.test(p.fixed)) continue;
      const key = `${p.name}@${p.fixed}`;
      if (!published.has(key)) published.set(key, await npmPublished(p.name, p.fixed));
    }
  }
}
const report = buildReport({
  now, apps: repoStatus, advisories: state.advisories, published, feedAlerts, watchlist, errors, warnings,
});
await writeFile(new URL('report.json', ROOT), JSON.stringify(report, null, 2) + '\n');
log(`report.json written: status ${report.status}, ${report.summary.open} open (${report.summary.critical} critical, ${report.summary.high} high), ${report.summary.newOpen} new`);

try {
  const rl = await gh.rateLimit();
  log(`GitHub rate limit remaining: ${rl.resources.core.remaining}/${rl.resources.core.limit}`);
} catch { /* informational */ }

process.exitCode = errors.length ? 1 : 0;
