#!/usr/bin/env node
// Posts the day's Slack messages from a report file: one message per reported project.
//
//   node scripts/slack.mjs data/reports/2026-10-30.json --verdicts data/verdicts/2026-10-30.json
//   node scripts/slack.mjs report.json --only Catalent       post one project only (repo or display name), for testing
//   node scripts/slack.mjs report.json --dry-run             print the payloads, post nothing
//   node scripts/slack.mjs report.json --text                print the messages as plain text (what a phone shows), post nothing
//
// Without a verdicts file (the filter did not run) every P0 is listed and the message says "unfiltered".

import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { buildMessages } from '../src/slack.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const file = args.find((a, i) => !a.startsWith('--') && !['--only', '--verdicts', '--usage'].includes(args[i - 1])) ?? 'report.json';

const report = JSON.parse(await readFile(file, 'utf8'));
if ((report.schema ?? 0) < 4) { console.error(`${file} is report schema ${report.schema}; this version needs schema 4 (run node watch.mjs first)`); process.exit(2); }
const watchlist = JSON.parse(await readFile(new URL('../watchlist.json', import.meta.url), 'utf8'));
const projects = watchlist.report?.projects ?? {};
if (!Object.keys(projects).length) { console.error('watchlist.json has no report.projects; nothing to post'); process.exit(2); }

const day = /(\d{4}-\d{2}-\d{2})/.exec(file)?.[1] ?? report.generatedAt.slice(0, 10);
const verdictsPath = value('--verdicts') ?? `data/verdicts/${day}.json`;
const verdicts = await readFile(new URL(`../${verdictsPath}`, import.meta.url), 'utf8').then(JSON.parse).catch(() => null);
if (!verdicts) console.error(`no verdicts at ${verdictsPath}: posting unfiltered P0 lines`);

const usagePath = value('--usage') ?? `data/usage/${day}.json`;
const usage = await readFile(usagePath, 'utf8').then(JSON.parse).catch(() => null);
if (!usage) console.log(`usage file ${usagePath} not found: no "Unused" lines today`);
const messages = buildMessages(report, { projects, verdicts, only: value('--only'), usage, implicitUse: watchlist.report?.implicitUse ?? [] });

if (flag('--text')) {
  for (const m of messages) {
    for (const b of m.blocks) {
      if (b.type === 'header') console.log(`\n${b.text.text}`);
      else if (b.type === 'section') console.log(b.text.text);
      else if (b.type === 'context') console.log(b.elements[0].text);
      else if (b.type === 'divider') console.log('────────');
    }
  }
  console.error(`${messages.length} message(s) built, nothing posted`);
  process.exit(0);
}
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
  console.log(`${ok ? 'posted' : 'FAILED'} ${i + 1}/${messages.length}: ${m.text.slice(0, 90)}${ok ? '' : ` -> ${res.status} ${text.slice(0, 200)}`}`);
  if (i < messages.length - 1) await sleep(1000);
}
console.log(`${messages.length - failed} of ${messages.length} Slack messages posted${failed ? `, ${failed} failed` : ''}`);
process.exit(failed ? 1 : 0);
