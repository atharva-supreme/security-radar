#!/usr/bin/env node
// The daily Claude filter: every package with an open advisory, unfiltered, per project and branch.
// Claude assigns P0, P1 or P2 with a reason. An answer is stored in data/decisions.json under a hash
// of its facts and reused until a fact changes, so tiers stay the same from day to day and only new
// or changed packages cost a call. Versions are never Claude's to choose.
//
//   node scripts/filter.mjs data/reports/2026-11-03.json --usage data/usage/2026-11-03.json --out data/verdicts/2026-11-03.json
//   node scripts/filter.mjs report.json --only cytoskeleton-sanity --dry-run     counts only, calls nothing
//
// Needs the `claude` CLI on PATH (signed in). FILTER_MODEL, FILTER_TIMEOUT_S, FILTER_BATCH and FILTER_CONCURRENCY are optional.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { candidatesFor, factIds, promptInput, validateDecisions, buildVerdict, validateBody } from '../src/filter.mjs';
import { composeInput } from '../src/slack.mjs';

// Runs `claude -p` with the whole prompt on stdin: a 50 KB prompt does not fit an argument list on
// every platform, and stdin keeps it out of the process table.
function askClaude(text, { timeoutMs, model }) {
  return new Promise((resolve, reject) => {
    const args = ['-p', 'Follow the instructions in the input. Reply with the JSON object only.', '--output-format', 'text'];
    if (model) args.push('--model', model);
    // A nested Claude Code session refuses to start while these are set (local testing from inside one).
    const env = { ...process.env };
    for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT']) delete env[k];
    // The CLI keeps its login under $HOME. Under cron HOME can differ from the interactive shell's
    // (Virtualmin sets /home/user/public_html for logins); CLAUDE_HOME in .env names the home that holds the login.
    if (process.env.CLAUDE_HOME) env.HOME = process.env.CLAUDE_HOME;
    const child = spawn('claude', args, { env, windowsHide: true, shell: process.platform === 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`claude timed out after ${timeoutMs / 1000} s`)); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`claude exited ${code}: ${(err || out).trim().slice(0, 400)}`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(text);
  });
}
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const positional = args.filter((a, i) => !a.startsWith('--') && !['--usage', '--out', '--only', '--decisions'].includes(args[i - 1]));
const file = positional[0] ?? 'report.json';
const only = value('--only');
const ROOT = new URL('..', import.meta.url);

const report = JSON.parse(await readFile(file, 'utf8'));
if ((report.schema ?? 0) < 4) { console.error(`${file} is report schema ${report.schema}; this version needs schema 4 (run node watch.mjs first)`); process.exit(2); }
const watchlist = JSON.parse(await readFile(new URL('watchlist.json', ROOT), 'utf8'));
const day = /(\d{4}-\d{2}-\d{2})/.exec(file)?.[1] ?? report.generatedAt.slice(0, 10);
const usagePath = value('--usage') ?? `data/usage/${day}.json`;
const usage = await readFile(new URL(usagePath, ROOT), 'utf8').then(JSON.parse).catch(() => null);
const outPath = value('--out') ?? `data/verdicts/${day}.json`;
const prompt = await readFile(new URL('server/filter.prompt.md', ROOT), 'utf8');
const messagePrompt = await readFile(new URL('server/message.prompt.md', ROOT), 'utf8');
const timeoutMs = Number(process.env.FILTER_TIMEOUT_S ?? 240) * 1000;
const batchSize = Number(process.env.FILTER_BATCH ?? 40);
const parallel = Number(process.env.FILTER_CONCURRENCY ?? 3);

const projects = Object.entries(watchlist.report?.projects ?? {}).filter(([repo]) => !only || repo === only || repo.split('/')[1] === only);
if (!projects.length) { console.error(`no reported project matches "${only}"`); process.exit(2); }
if (!usage) console.log(`usage file ${usagePath} not found: Claude decides without code search`);

// The decision memory. A decision is kept while its facts are unchanged, which is what keeps a
// package's tier the same from one day to the next. Editing the prompt starts the memory afresh,
// because the rules the old decisions followed are gone. Entries unseen for 60 days are dropped.
const decisionsUrl = new URL(value('--decisions') ?? 'data/decisions.json', ROOT);
const promptHash = createHash('sha1').update(prompt.replace(/\r\n/g, '\n')).digest('hex').slice(0, 12);
const stored = await readFile(decisionsUrl, 'utf8').then(JSON.parse).catch(() => null);
if (stored && stored.prompt !== promptHash) console.log('prompt changed: every decision is made again today');
const memory = stored?.prompt === promptHash ? stored : { prompt: promptHash, repos: {} };
// A memory that cannot be saved costs extra calls tomorrow; it must never stop today's messages.
const saveMemory = async () => {
  try {
    await mkdir(new URL('.', decisionsUrl), { recursive: true });
    await writeFile(decisionsUrl, JSON.stringify(memory) + '\n');
  } catch (e) {
    console.log(`WARNING: decisions not saved: ${e.message}`);
  }
};

const chunks = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));
async function pool(items, n, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => { while (queue.length) await fn(queue.shift()); }));
}

// Claude produces the message body. An answer is kept while its facts and the prompt are unchanged;
// open days move daily, so a project with packages to fix normally gets one call a day. A rejected
// answer is asked for again, naming each difference, up to three attempts in all.
const parseJson = (stdout) => {
  const raw = stdout.trim().replace(/^\`\`\`(?:json)?\s*/i, '').replace(/\s*\`\`\`$/, '');
  return JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
};
async function writeBody(repo, { facts, expected }) {
  const hash = createHash('sha1').update(messagePrompt.replace(/\r\n/g, '\n') + JSON.stringify(facts)).digest('hex').slice(0, 12);
  const kept = (memory.bodies ??= {})[repo];
  if (kept?.hash === hash) return { body: kept.body, reused: true, attempts: 0 };
  let problem = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const again = problem ? `\n\nYour previous answer was rejected. Correct these: ${problem}` : '';
      const stdout = await askClaude(`${messagePrompt}${again}\n\nINPUT:\n${JSON.stringify(facts)}`, { timeoutMs, model: process.env.FILTER_MODEL || null });
      const checked = validateBody(parseJson(stdout), expected, facts);
      if (checked.body) {
        memory.bodies[repo] = { hash, body: checked.body, writtenOn: day };
        return { body: checked.body, reused: false, attempts: attempt };
      }
      problem = checked.problem;
    } catch (e) {
      problem = String(e.message ?? e).slice(0, 300);
    }
  }
  return { problem };
}

const out = { generatedAt: new Date().toISOString(), day, prompt: 'server/filter.prompt.md', projects: {} };
let failed = 0;
for (const [repo, name] of projects) {
  const input = candidatesFor(report, { repo, name, day, usage: usage?.repos?.[repo] ?? null, runtimeParents: watchlist.report?.runtimeParents ?? [], implicitUse: watchlist.report?.implicitUse ?? [] });
  const ids = factIds(input);
  const known = (memory.repos[repo] ??= {});
  const pending = ids.filter((id) => !known[id]);
  if (flag('--dry-run')) { console.log(`${name}: ${ids.length} distinct items, ${pending.length} to ask Claude, ${chunks(pending, batchSize).length} calls`); continue; }
  const t0 = Date.now();
  const errors = [];
  const corrections = [];
  await pool(chunks(pending, batchSize), parallel, async (batch) => {
    try {
      const stdout = await askClaude(`${prompt}\n\nINPUT:\n${JSON.stringify(promptInput(input, batch))}`, { timeoutMs, model: process.env.FILTER_MODEL || null });
      const raw = stdout.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      const checked = validateDecisions(JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)), input);
      corrections.push(...checked.corrections);
      for (const id of batch) if (checked.decisions[id]) known[id] = { ...checked.decisions[id], decidedOn: day };
    } catch (e) {
      errors.push(String(e.message ?? e).slice(0, 300));
    }
  });
  const decisions = Object.fromEntries(ids.filter((id) => known[id]).map((id) => [id, known[id]]));
  for (const id of ids) if (known[id]) known[id].lastSeen = day;
  for (const [id, d] of Object.entries(known)) if (d.lastSeen && (Date.parse(day) - Date.parse(d.lastSeen)) / 86400000 > 60) delete known[id];
  await saveMemory();
  const { lines, notAssessed } = buildVerdict(input, decisions);
  // Nothing decided at all means the filter did not run: Slack must say "unfiltered", not guess.
  if (ids.length && !Object.keys(decisions).length && errors.length) {
    failed += 1;
    out.projects[repo] = { ok: false, error: errors[0], candidates: ids.length };
    console.log(`${name}: FAILED ${errors[0].slice(0, 200)}`);
    continue;
  }
  out.projects[repo] = { ok: true, lines, notAssessed, candidates: ids.length, asked: pending.length, reused: ids.length - pending.length, corrections, errors, ms: Date.now() - t0 };
  const counts = { P0: 0, P1: 0, P2: 0 };
  for (const l of lines) counts[l.tier] += 1;
  console.log(`${name}: ${ids.length} items, ${ids.length - pending.length} kept from earlier days, ${pending.length} asked, P0 ${counts.P0}, P1 ${counts.P1}, P2 ${counts.P2}${notAssessed ? `, ${notAssessed} NOT ASSESSED` : ''}, ${Math.round((Date.now() - t0) / 1000)} s`);
  for (const c of corrections) console.log(`  corrected: ${c}`);
  for (const e of errors) console.log(`  batch failed: ${e.slice(0, 200)}`);
  const written = await writeBody(repo, composeInput(report, repo, name, out.projects[repo], { usage: usage?.repos?.[repo] ?? null, implicitUse: watchlist.report?.implicitUse ?? [] }));
  if (written.body) {
    out.projects[repo].body = written.body;
    out.projects[repo].todo = written.body.todo;
    console.log(`  message: ${written.reused ? 'kept from earlier' : `written by Claude, attempt ${written.attempts}`}`);
  } else {
    out.projects[repo].bodyError = written.problem;
    console.log(`  message FAILED the check, the code's version goes out: ${written.problem.slice(0, 400)}`);
  }
  await saveMemory();
}

if (!flag('--dry-run')) {
  await mkdir(new URL(outPath.replace(/[^/]+$/, ''), ROOT), { recursive: true });
  await writeFile(new URL(outPath, ROOT), JSON.stringify(out, null, 1) + '\n');
  console.log(`written ${outPath}: ${projects.length - failed} of ${projects.length} projects decided`);
}
process.exit(failed === projects.length && projects.length ? 1 : 0);
