#!/usr/bin/env node
// Finds every lockfile in every repository of an organisation and writes them into watchlist.json.
//
//   node scripts/discover.mjs            rewrite watchlist.repos from what GitHub has today
//   node scripts/discover.mjs --dry-run  print what would change, write nothing
//
// Reads watchlist.json for: org, branches (default branches to scan when they exist), exclude
// (regexes over "repo/path"; matching lockfiles are skipped), and keeps any repo row marked
// "manual": true untouched. Everything else in repos[] is regenerated.
//
// kind: "app" for a lockfile that belongs to something we deploy (root, web/, next/, frontend/,
// sanity/, app/, studio/, checkout/); "tooling" for build tooling and vendored code (anything
// under wp-content/, migration/, scripts/, config/, starter/). Tooling is scanned too, but the
// report keeps it apart: its packages run at build time, not on the server.

import { readFile, writeFile } from 'node:fs/promises';
import { makeClient } from '../src/github.mjs';
import { installedVersions } from '../src/lockfile.mjs';

const ROOT = new URL('../', import.meta.url);
const dryRun = process.argv.includes('--dry-run');
const watchlist = JSON.parse(await readFile(new URL('watchlist.json', ROOT), 'utf8'));
const org = watchlist.org ?? 'SupremeOpti';
const gh = makeClient({ token: process.env.REPO_READ_TOKEN ?? process.env.GITHUB_TOKEN });
const exclude = (watchlist.exclude ?? []).map((p) => new RegExp(p, 'i'));

const LOCK = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/;
const VENDOR = /(^|\/)(node_modules|vendor|\.git)\//;
const TOOLING = /(^|\/)(wp-content|wp|migration|scripts|config|starter|tools|build)\//i;

const toolingPatterns = (watchlist.tooling ?? []).map((p) => new RegExp(p, "i"));
const kindOf = (repo, path) => (TOOLING.test(path) || toolingPatterns.some((re) => re.test(`${repo}/${path}`)) ? "tooling" : "app");

const repos = (await gh.orgRepos(org)).filter((r) => !r.archived);
const rows = [];
let i = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (i < repos.length) {
    const r = repos[i++];
    const branches = [...new Set([r.default_branch, ...(watchlist.branches ?? [])])];
    const perBranch = new Map(); // path -> [branches that have it with packages]
    for (const branch of branches) {
      let tree;
      try { tree = await gh.tree(`${org}/${r.name}`, branch); } catch (e) { if (e.status === 404 || e.status === 409) continue; throw e; }
      for (const e of tree.tree) {
        if (e.type !== 'blob' || !LOCK.test(e.path) || VENDOR.test(e.path)) continue;
        if (exclude.some((re) => re.test(`${r.name}/${e.path}`))) continue;
        let count = 0;
        try { count = installedVersions(await gh.fileText(`${org}/${r.name}`, e.path, branch), e.path).size; } catch { count = 0; }
        if (count === 0) continue; // an empty or unparsable lockfile is not an app
        perBranch.set(e.path, [...(perBranch.get(e.path) ?? []), branch]);
      }
    }
    // A folder with two lockfiles (a stale package-lock.json beside pnpm-lock.yaml) is one app:
    // keep the one its package manager uses, in this order of preference.
    const PREF = ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json'];
    const byDir = new Map();
    for (const path of perBranch.keys()) {
      const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      const base = path.slice(dir ? dir.length + 1 : 0);
      const prev = byDir.get(dir);
      if (!prev || PREF.indexOf(base) < PREF.indexOf(prev.slice(dir ? dir.length + 1 : 0))) byDir.set(dir, path);
    }
    for (const [path, found] of perBranch) {
      const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      if (byDir.get(dir) !== path) continue;
      rows.push({
        repo: `${org}/${r.name}`,
        lockfile: path,
        packageJson: dir ? `${dir}/package.json` : 'package.json',
        label: dir || 'root',
        kind: kindOf(r.name, path),
        branches: found,
      });
    }
  }
}));

rows.sort((a, b) => a.repo.localeCompare(b.repo) || a.lockfile.localeCompare(b.lockfile));
const manual = (watchlist.repos ?? []).filter((r) => r.manual);
const next = { ...watchlist, org, repos: [...manual, ...rows] };

const before = new Set((watchlist.repos ?? []).map((r) => `${r.repo}:${r.lockfile}`));
const after = new Set(next.repos.map((r) => `${r.repo}:${r.lockfile}`));
const added = [...after].filter((k) => !before.has(k));
const removed = [...before].filter((k) => !after.has(k));
console.log(`${repos.length} repos, ${rows.length} lockfiles (${rows.filter((r) => r.kind === 'app').length} app, ${rows.filter((r) => r.kind === 'tooling').length} tooling), ${manual.length} manual rows kept`);
if (added.length) console.log(`added:\n  ${added.join('\n  ')}`);
if (removed.length) console.log(`removed:\n  ${removed.join('\n  ')}`);
if (!dryRun) {
  await writeFile(new URL('watchlist.json', ROOT), JSON.stringify(next, null, 2) + '\n');
  console.log('watchlist.json written');
}
