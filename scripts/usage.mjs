#!/usr/bin/env node
// Where does each project's own code use the packages the scan flagged? Reads every reported
// repository's source tarball from GitHub (no clone, nothing written to disk), greps imports, and
// writes data/usage/YYYY-MM-DD.json for the Claude filter step.
//
//   node scripts/usage.mjs data/reports/2026-10-30.json            -> data/usage/2026-10-30.json
//   node scripts/usage.mjs report.json --only cytoskeleton-sanity  one repository, printed
//
// Needs REPO_READ_TOKEN (falls back to GITHUB_TOKEN). The tarball of a Next.js/Sanity repository
// is a few megabytes; node_modules, build output and lockfiles are skipped while reading.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { driftOf } from '../src/lockfile.mjs';
import { gunzipSync } from 'node:zlib';

const args = process.argv.slice(2);
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const file = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--only') ?? 'report.json';
const only = value('--only');
const outPath = value('--out');
const ROOT = new URL('..', import.meta.url);
const token = process.env.REPO_READ_TOKEN || process.env.GITHUB_TOKEN;
if (!token) { console.error('REPO_READ_TOKEN not set'); process.exit(2); }

const report = JSON.parse(await readFile(file, 'utf8'));
if ((report.schema ?? 0) < 4) { console.error(`${file} is report schema ${report.schema}; this version needs schema 4 (run node watch.mjs first)`); process.exit(2); }
const watchlist = JSON.parse(await readFile(new URL('watchlist.json', ROOT), 'utf8'));
const day = /(\d{4}-\d{2}-\d{2})/.exec(file)?.[1] ?? report.generatedAt.slice(0, 10);

const SOURCE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro|mdx|hbs|html|php)$/i; // .md is documentation, not code; .mdx can import
const SKIP = /(^|\/)(node_modules|dist|build|out|\.next|\.turbo|coverage|vendor|public\/static|storybook-static|\.claude|\.github)\/|(^|\/)public\/.*\.(?:m?js|css)$/i; // built bundles under public/ and agent tooling are not our source
const MAX_HITS = 12;
// Framework features the review named as the real exposure questions for our stack.
const SIGNALS = {
  dangerouslyAllowSVG: /dangerouslyAllowSVG\s*:\s*true/,
  ImageResponse: /\bImageResponse\b/,
  useCache: /['"]use cache['"]/,
  dangerouslySetInnerHTML: /dangerouslySetInnerHTML/,
  serverActions: /['"]use server['"]/,
};

// ---------- minimal tar reader (ustar + pax long names, as GitHub's `git archive` emits) ----------
function* tarEntries(buf) {
  let off = 0;
  let paxPath = null;
  let longName = null;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const str = (start, len) => header.toString('utf8', start, start + len).replace(/\0.*$/s, '');
    let size = 0;
    if (header[124] & 0x80) { for (let i = 125; i < 136; i++) size = size * 256 + header[i]; } // base-256
    else size = parseInt(str(124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = str(345, 155);
    let name = longName ?? paxPath ?? (prefix ? `${prefix}/${str(0, 100)}` : str(0, 100));
    const dataStart = off + 512;
    const data = buf.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = data.toString('utf8').replace(/\0.*$/s, ''); continue; }
    if (type === 'x') { const m = /(?:^|\n)\d+ path=([^\n]+)/.exec(data.toString('utf8')); paxPath = m ? m[1] : null; continue; }
    if (type === 'g') continue;
    longName = paxPath = null;
    if (type === '0' || type === '\0' || type === '7') yield { name, data };
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
// The package named as a string anywhere else: a plugin list, a config, a package.json script. Not an
// import, but proof the code knows the package; "unused" needs zero of both.
const mentionRe = (pkg) => new RegExp(`['"\`]${escapeRe(pkg)}(?:/[^'"\`]*)?['"\`]`);
const scriptRe = (pkg) => new RegExp(`(^|[\\s"'=:;&|(])${escapeRe(pkg)}([\\s"'=:;&|)]|$)`);
const importRe = (pkg) => new RegExp(`(?:from\\s*|require\\(\\s*|import\\(\\s*|import\\s+)['"]${escapeRe(pkg)}(?:/[^'"]*)?['"]`);

async function tarball(repo, ref) {
  const res = await fetch(`https://api.github.com/repos/${repo}/tarball/${encodeURIComponent(ref)}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'security-radar' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`tarball ${repo}@${ref} -> ${res.status}`);
  return gunzipSync(Buffer.from(await res.arrayBuffer()));
}

// Which packages to look for in a repository: every unit in its deployed lockfiles, since Claude judges them all.
function wantedPackages(repo) {
  const names = new Set();
  for (const a of report.apps.filter((a) => a.repo === repo && a.kind === 'app' && a.ok)) {
    for (const u of a.upgrades ?? []) names.add(u.package);
  }
  return [...names];
}

async function scanRepo(repo, ref) {
  const packages = wantedPackages(repo);
  const res = { ref, files: 0, sourceFiles: 0, packages: {}, signals: {}, manifests: {}, drift: [] };
  const lockPaths = new Set((watchlist.repos ?? []).filter((r) => r.repo === repo && (r.kind ?? 'app') === 'app' && (r.branches ?? watchlist.branches ?? ['main']).includes(ref)).map((r) => r.lockfile));
  const lockTexts = {};
  const declared = {};
  const regs = packages.map((p) => [p, importRe(p), mentionRe(p), scriptRe(p)]);
  const mention = (pkg, path) => {
    const entry = res.packages[pkg] ?? (res.packages[pkg] = { count: 0, imports: [], mentions: 0, mentioned: [] });
    entry.mentions = (entry.mentions ?? 0) + 1;
    if ((entry.mentioned ??= []).length < 4) entry.mentioned.push(path);
  };
  const buf = await tarball(repo, ref);
  for (const { name, data } of tarEntries(buf)) {
    const path = name.replace(/^[^/]+\//, ''); // strip the "<org>-<repo>-<sha>/" folder GitHub adds
    res.files += 1;
    if (lockPaths.has(path)) { lockTexts[path] = data.toString('utf8'); continue; }
    if (SKIP.test(path)) continue;
    if (/(^|\/)package\.json$/.test(path)) {
      try {
        const j = JSON.parse(data.toString('utf8'));
        res.manifests[path] = { name: j.name ?? null, dependencies: Object.keys(j.dependencies ?? {}).length, devDependencies: Object.keys(j.devDependencies ?? {}).length, overrides: j.pnpm?.overrides ?? j.overrides ?? j.resolutions ?? null, scripts: Object.keys(j.scripts ?? {}) };
        declared[path] = { dependencies: j.dependencies, devDependencies: j.devDependencies, optionalDependencies: j.optionalDependencies };
        const scripts = Object.values(j.scripts ?? {}).join('\n');
        for (const [pkg, , , sre] of regs) if (sre.test(scripts)) mention(pkg, `${path}:scripts`);
      } catch { /* not ours to fix */ }
      continue;
    }
    if (!SOURCE.test(path) || data.length > 2_000_000) continue;
    res.sourceFiles += 1;
    const text = data.toString('utf8');
    for (const [pkg, re, mre] of regs) {
      if (!re.test(text)) { if (mre.test(text)) mention(pkg, path); continue; }
      const entry = res.packages[pkg] ?? (res.packages[pkg] = { count: 0, imports: [], mentions: 0, mentioned: [] });
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        entry.count += 1;
        if (entry.imports.length < MAX_HITS) entry.imports.push(`${path}:${i + 1} ${lines[i].trim().slice(0, 120)}`);
      }
    }
    for (const [key, re] of Object.entries(SIGNALS)) {
      if (!re.test(text)) continue;
      const s = res.signals[key] ?? (res.signals[key] = { count: 0, files: [] });
      s.count += 1;
      if (s.files.length < 8) s.files.push(path);
    }
  }
  for (const [lockPath, lockText] of Object.entries(lockTexts)) {
    try { res.drift.push(...driftOf({ lockText, lockPath, manifests: declared })); } catch (e) { console.log(`${repo}@${ref}: could not compare ${lockPath}: ${e.message}`); }
  }
  for (const p of packages) if (!res.packages[p]) res.packages[p] = { count: 0, imports: [], mentions: 0, mentioned: [] };
  return res;
}

const repos = Object.keys(watchlist.report?.projects ?? {}).filter((r) => !only || r === only || r.split('/')[1] === only);
if (!repos.length) { console.error(`no reported repository matches "${only}"`); process.exit(2); }
const out = { generatedAt: new Date().toISOString(), day, repos: {} };
// Every branch the watchlist scans for the repository, main first. main and staging can be hundreds of
// commits apart, so each branch's source is grepped on its own; the filter and Slack read the
// branch they are deciding about (main at the top level, others under `branches`).
const branchesOf = (repo) => {
  const rows = (watchlist.repos ?? []).filter((r) => r.repo === repo);
  const set = new Set(rows.flatMap((r) => r.branches ?? (r.ref ? [r.ref] : watchlist.branches ?? ['main'])));
  if (!set.size) (watchlist.branches ?? ['main']).forEach((b) => set.add(b));
  return [...set].sort((a, b) => (a === 'main' ? -1 : b === 'main' ? 1 : a.localeCompare(b)));
};
// Three repositories at a time: each tarball is read whole into memory, so more would not be faster.
const queue = [...repos];
await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
  while (queue.length) {
    const repo = queue.shift();
    const [ref, ...others] = branchesOf(repo);
    const scan = async (branch) => {
      const t0 = Date.now();
      try {
        const r = await scanRepo(repo, branch);
        console.log(`${repo}@${branch}: ${r.sourceFiles} source files, ${Object.values(r.packages).filter((p) => p.count).length}/${Object.keys(r.packages).length} flagged packages imported by our code, ${r.drift.length} package.json/lockfile differences, ${Date.now() - t0} ms`);
        return r;
      } catch (e) {
        console.log(`${repo}@${branch}: FAILED ${e.message}`);
        return { ref: branch, error: e.message, packages: {}, signals: {}, manifests: {} };
      }
    };
    out.repos[repo] = { ...(await scan(ref)), branches: {} };
    for (const b of others) out.repos[repo].branches[b] = await scan(b);
  }
}));

if (outPath) {
  await writeFile(outPath, JSON.stringify(out) + '\n');
  console.log(`written ${outPath}`);
} else if (only) {
  console.log(JSON.stringify(out.repos[repos[0]], null, 1));
} else {
  await mkdir(new URL('data/usage/', ROOT), { recursive: true });
  const target = new URL(`data/usage/${day}.json`, ROOT);
  await writeFile(target, JSON.stringify(out) + '\n');
  console.log(`written ${target.pathname.replace(/^\/+/, '')}`);
}
