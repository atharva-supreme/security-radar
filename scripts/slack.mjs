#!/usr/bin/env node
// Posts the day's Slack messages from a report file.
//
//   node scripts/slack.mjs report.json                       post everything: summary, one per affected project, clear list
//   node scripts/slack.mjs report.json --only Catalent       post one project only (repo or display name), for testing
//   node scripts/slack.mjs report.json --dry-run             print the payloads, post nothing
//   node scripts/slack.mjs report.json --narrative-file f    include Claude's paragraph in the summary message
//
// Needs SLACK_WEBHOOK_URL (not with --dry-run). Reported projects and their names: watchlist.json "report.projects".

import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { buildMessages } from '../src/slack.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const file = args.find((a) => !a.startsWith('--') && !['--only', '--narrative-file'].includes(args[args.indexOf(a) - 1])) ?? 'report.json';

const report = JSON.parse(await readFile(file, 'utf8'));
const watchlist = JSON.parse(await readFile(new URL('../watchlist.json', import.meta.url), 'utf8'));
const projects = watchlist.report?.projects ?? {};
if (!Object.keys(projects).length) { console.error('watchlist.json has no report.projects; nothing to post'); process.exit(2); }

let narrative = '';
const nf = value('--narrative-file');
if (nf) narrative = await readFile(nf, 'utf8').catch(() => '');

const messages = buildMessages(report, { projects, narrative, only: value('--only') });

if (flag('--dry-run')) {
  for (const m of messages) console.log(JSON.stringify(m, null, 1));
  console.error(`${messages.length} message(s) built, nothing posted`);
  process.exit(0);
}

const url = process.env.SLACK_WEBHOOK_URL;
if (!url) { console.error('SLACK_WEBHOOK_URL not set'); process.exit(2); }

let failed = 0;
for (const [i, m] of messages.entries()) {
  const body = JSON.stringify(m);
  let res, text;
  for (let attempt = 1; attempt <= 3; attempt++) {
    res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    text = await res.text();
    if (res.status === 429) { await sleep(Number(res.headers.get('retry-after') ?? 5) * 1000); continue; }
    break;
  }
  const ok = res.ok && text.trim() === 'ok';
  if (!ok) failed++;
  console.log(`${ok ? 'posted' : 'FAILED'} ${i + 1}/${messages.length}: ${m.text.slice(0, 80)}${ok ? '' : ` -> ${res.status} ${text.slice(0, 200)}`}`);
  if (i < messages.length - 1) await sleep(1000);
}
console.log(`${messages.length - failed} of ${messages.length} Slack messages posted${failed ? `, ${failed} failed` : ''}`);
process.exit(failed ? 1 : 0);
