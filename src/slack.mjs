// Slack messages built in code from report.json and the day's verdicts: one message per reported
// project, nothing else. Each message is
//
//   :package: VectorLabs · Health Score · staging 79 · main 29 · overall 29 · :red_circle: RED
//   *staging* · AMBER · Health Score 79 · 0 critical, 3 high · 3 packages to fix
//   • web · nodemailer 7.0.13 → 10.1.4 · closes 20 · <url|HIGH> · open 220 days · direct
//   *main* · RED · Health Score 29 · 5 critical, 4 high · 9 packages to fix  [· same as staging]
//   • same fix as staging: nodemailer 7.0.12
//   • web · next 16.2.12 → 16.4.1 · closes 11 · <url|CRITICAL> · open 68 days · direct · fixed on staging
//   *Unused* and *Out of sync*                                            (only when there are any)
//   *What to do*
//   P1 · 8 packages for later · P2 · 4 packages, no action                (counts only, never names)
//
// Claude produces everything under the header and section titles from raw facts. The code calculates
// the same body independently (composeInput) and validateBody rejects any difference, so versions and
// counts stay exact and the format never changes. The code's version is sent, with a warning, only
// when Claude's fails the check. Without a verdict every scanner P0 is listed and the message says so.

import { severityRank } from './format.mjs';
import { compare } from './semver.mjs';
import { healthScore, STATUS_EMOJI } from './tiers.mjs';
import { applyVerdict, isUnused } from './filter.mjs';
import { commandsFor } from './report.mjs';

const MAX_SECTION = 2900; // under Slack's 3,000 per section
const SEV_LABEL = { critical: 'CRITICAL', high: 'HIGH', moderate: 'MODERATE', medium: 'MODERATE', low: 'LOW' };

// mrkdwn text fields need these three escaped.
export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sevLabel = (s) => SEV_LABEL[s] ?? String(s ?? 'unknown').toUpperCase();
const section = (text) => ({ type: 'section', text: { type: 'mrkdwn', text } });
const divider = () => ({ type: 'divider' });
const header = (text) => ({ type: 'header', text: { type: 'plain_text', text: String(text).slice(0, 150), emoji: true } });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Split a list of lines into section blocks under the section size limit.
function sectionsOf(lines, { prefix = '' } = {}) {
  const blocks = [];
  let buf = prefix;
  for (const line of lines) {
    const next = buf ? `${buf}\n${line}` : line;
    if (next.length > MAX_SECTION && buf !== prefix) {
      blocks.push(section(buf));
      buf = line;
    } else buf = next;
  }
  if (buf && buf !== prefix) blocks.push(section(buf));
  return blocks;
}

// Units with action "now" across an branch's apps, merged per (package, line, target).
export function mergeLines(unitsByApp) {
  const byKey = new Map();
  for (const { app, units } of unitsByApp) {
    for (const u of units) {
      if (u.action !== 'now') continue;
      const target = u.lineComplete ? u.to : u.toMajor;
      if (!target) continue;
      const key = `${u.package}\u0000${u.line}\u0000${target}`;
      const l = byKey.get(key) ?? { package: u.package, line: u.line, to: target, major: !u.lineComplete, apps: [], from: new Set(), closes: 0, worst: u.worst, worstId: u.worstId, openDays: 0, isNew: false, early: false, direct: false, reason: u.verdictReason };
      l.apps.push(app);
      u.from.forEach((v) => l.from.add(v));
      l.closes = Math.max(l.closes, u.closes);
      if (severityRank(u.worst) < severityRank(l.worst)) { l.worst = u.worst; l.worstId = u.worstId; }
      l.openDays = Math.max(l.openDays, u.openDays ?? 0);
      l.isNew = l.isNew || u.isNew;
      l.early = l.early || u.early;
      l.direct = l.direct || u.direct === true;
      byKey.set(key, l);
    }
  }
  return [...byKey.values()]
    .map((l) => ({ ...l, from: [...l.from].sort(compare) }))
    .sort((a, b) => severityRank(a.worst) - severityRank(b.worst) || b.closes - a.closes || a.package.localeCompare(b.package));
}

export function lineText(l, advisories) {
  const url = advisories.get(l.worstId)?.url;
  const sev = url ? `<${url}|${sevLabel(l.worst)}>` : sevLabel(l.worst);
  const tags = [l.direct ? 'direct' : 'override', l.major ? ':arrow_up: major' : '', l.isNew ? ':new: NEW' : '', l.early ? ':zap: early' : ''].filter(Boolean);
  return `• ${esc(l.apps.join(', '))} · ${esc(l.package)} ${l.from.join(', ')} → ${l.to} · closes ${l.closes} · ${sev} · open ${plural(l.openDays, 'day')} · ${tags.join(' · ')}`;
}

function branchView(apps, verdict, branch) {
  // A verdict counts only when the filter succeeded; a failed one ({ ok: false }) must fall back
  // to every P0, exactly like a missing file, or a broken filter would paint every project GREEN.
  const decided = verdict?.ok === true;
  const unitsByApp = apps.filter((a) => a.ok).map((a) => ({
    app: a.label,
    units: decided ? applyVerdict(a.upgrades ?? [], verdict, a.label, branch) : (a.upgrades ?? []).map((u) => ({ ...u, action: u.tier === 'P0' ? 'now' : null, verdictReason: null })),
  }));
  const lines = mergeLines(unitsByApp);
  const units = unitsByApp.flatMap((x) => x.units.map((u) => ({ ...u, appLabel: x.app })));
  const pkgs = (list) => new Set(list.map((u) => u.package)).size;
  // P0 = what is listed. P1 = Claude's later. P2 leaves the score.
  const p1 = pkgs(units.filter((u) => u.tier === 'P1'));
  const health = { ...healthScore({ critical: lines.filter((l) => l.worst === 'critical').length, high: lines.filter((l) => l.worst !== 'critical').length, p1 }), p1 };
  return { branch, apps, lines, units, health, broken: apps.some((a) => !a.ok) };
}

// Flagged packages the branch declares itself but never imports or references: upgrading them is
// wasted work, removing them closes the advisories. One line per package, both branches merged.
export function unusedLines(apps, usage, implicitUse = []) {
  const scanOf = (branch) => (branch === 'main' ? usage : usage?.branches?.[branch]);
  const scanned = (branch) => { const x = scanOf(branch); return Boolean(x && !x.error); };
  const byPkg = new Map();
  for (const a of apps) {
    if (!a.ok || !scanned(a.branch)) continue;
    const scan = scanOf(a.branch);
    for (const u of a.upgrades ?? []) {
      if (!isUnused(u, scan.packages?.[u.package], implicitUse)) continue;
      const l = byPkg.get(u.package) ?? { package: u.package, apps: new Set(), branches: new Set(), from: new Set(), importers: new Set() };
      l.apps.add(a.label);
      l.branches.add(a.branch);
      u.from.forEach((v) => l.from.add(v));
      if (u.via?.importer) l.importers.add(u.via.importer);
      byPkg.set(u.package, l);
    }
  }
  const branchesScanned = new Set(apps.filter((a) => a.ok && scanned(a.branch)).map((a) => a.branch));
  return [...byPkg.values()].sort((a, b) => a.package.localeCompare(b.package)).map((l) => {
    const where = [...l.importers].filter((i) => i && i !== '.').map((i) => `${i}/package.json`);
    const scope = branchesScanned.size > 1 && l.branches.size < branchesScanned.size ? ` · ${[...l.branches].join(', ')} only` : '';
    return `• ${esc([...l.apps].join(', '))} · ${esc(l.package)} ${[...l.from].sort(compare).join(', ')} · declared in ${esc(where.length ? where.join(', ') : 'package.json')}, never imported or referenced${scope} · remove it instead of upgrading, no code change expected`;
  });
}

function branchHead(view, tag = '') {
  const status = view.broken && !view.lines.length ? 'UNKNOWN' : view.health.status;
  const crit = view.lines.filter((l) => l.worst === 'critical').length;
  const counts = view.lines.length
    ? `${crit} critical, ${view.lines.length - crit} high · ${plural(view.lines.length, 'package')} to fix`
    : `nothing to fix today${view.broken ? ' · :warning: a lockfile could not be read' : ''}`;
  return `*${view.branch}* · ${STATUS_EMOJI[status]} *${status}* · Health Score ${view.health.score} · ${counts}${tag}`;
}

const fixKey = (l) => `${l.package}\u0000${l.line}\u0000${l.to}`;
const lineKey = (l) => `${l.package}\u0000${l.line}`;

// Owner rule (2026-11-02): staging comes first and is always listed in full, because staging is
// updated first. main follows and may say "same as staging", but only for what is really the same:
// the whole section only when every line matches on target and installed versions, otherwise one
// "same fix" bullet that still names main's own versions, plus full lines for what only main has.
// main and staging can diverge in either direction, so main's differences are always shown.
const withHead = (head, lines) => (lines.length ? sectionsOf(lines, { prefix: head }) : [section(head)]);

export function stagingBlocks(staging, advisories) {
  return withHead(branchHead(staging), staging.lines.map((l) => lineText(l, advisories)));
}

// { same, lines }: whether main matches staging exactly, and what main's section lists.
export function mainSection(main, staging, advisories) {
  const fullLines = main.lines.map((l) => lineText(l, advisories));
  if (!staging || staging.broken) return { same: false, lines: fullLines };
  const exact = (l) => `${fixKey(l)}\u0000${l.from.join(',')}`;
  const stagingExact = new Set(staging.lines.map(exact));
  if (main.lines.length === staging.lines.length && main.lines.every((l) => stagingExact.has(exact(l)))) return { same: true, lines: [] };
  const stagingFix = new Set(staging.lines.map(fixKey));
  const stagingOpen = new Set(staging.units.map(lineKey));
  const shared = main.lines.filter((l) => stagingFix.has(fixKey(l)));
  const lines = shared.length ? [`• same fix as staging: ${esc(shared.map((l) => `${l.package} ${l.from.join(', ')}`).join(', '))}`] : [];
  for (const l of main.lines.filter((x) => !stagingFix.has(fixKey(x)))) {
    lines.push(`${lineText(l, advisories)}${stagingOpen.has(lineKey(l)) ? '' : ' · fixed on staging'}`);
  }
  return { same: false, lines };
}

export function mainBlocks(main, staging, advisories) {
  const { same, lines } = mainSection(main, staging, advisories);
  return withHead(branchHead(main, same ? ' · same as staging' : ''), lines);
}

export function tierLineText(main, staging, verdict) {
  const allUnits = [...main.units, ...(staging?.units ?? [])];
  const count = (tier) => new Set(allUnits.filter((u) => u.tier === tier).map((u) => u.package)).size;
  const gap = verdict?.notAssessed ? ` · :warning: ${verdict.notAssessed} not assessed today` : '';
  return `P1 · ${plural(count('P1'), 'package')} for later · P2 · ${plural(count('P2'), 'package')}, no action${gap}`;
}

// Claude's text is plain. Slack needs &, < and > escaped, except inside a <url|label> link.
export const mrkdwn = (text) => String(text).split(/(<https?:[^|>\s]+\|[^>]+>)/).map((part, i) => (i % 2 ? part : esc(part))).join('');

// package.json and lockfile disagreements found by the usage step, one line per pair of files.
export function driftLines(usage, branches) {
  const groups = new Map();
  for (const branch of branches) {
    const scan = branch === 'main' ? usage : usage?.branches?.[branch];
    const byPair = new Map();
    for (const d of scan?.drift ?? []) {
      const key = `${d.lockfile}\u0000${d.manifest}`;
      byPair.set(key, [...(byPair.get(key) ?? []), d]);
    }
    for (const [key, list] of byPair) {
      const sig = `${key}\u0000${JSON.stringify(list.map((d) => [d.package, d.declared, d.locked]))}`;
      const g = groups.get(sig) ?? { list, branches: [] };
      g.branches.push(branch);
      groups.set(sig, g);
    }
  }
  return [...groups.values()].map(({ list, branches: on }) => {
    const shown = list.slice(0, 3).map((d) => (d.locked === null ? `${d.package} missing from lockfile` : `${d.package} ${d.declared} vs ${d.locked}`)).join(', ');
    const more = list.length > 3 ? `, +${list.length - 3} more` : '';
    return `• ${esc(on.join(', '))} · ${esc(list[0].lockfile)} and ${esc(list[0].manifest)} · ${esc(shown)}${more} · run install and commit the lockfile`;
  });
}

// The call to action, built in code so it is exact and the same every day: staging's commands
// first, then what main needs. A main fix that staging also has, or no longer needs, is closed by
// merging staging. Unused packages are never upgraded here; the Unused section says remove them.
export function whatToDo(main, staging, { usage = null, implicitUse = [] } = {}) {
  const bullets = [];
  const usable = staging && !staging.broken ? staging : null;
  const scanOf = (branch) => (branch === 'main' ? usage : usage?.branches?.[branch]);
  const commandsOf = (view, keep = () => true) => {
    const scan = scanOf(view.branch);
    for (const app of view.apps.filter((a) => a.ok)) {
      const units = (app.upgrades ?? []).map((u) => view.units.find((x) => x.appLabel === app.label && x.package === u.package && x.line === u.line) ?? u)
        .filter((u) => u.action === 'now' && !isUnused(u, scan?.packages?.[u.package], implicitUse) && keep(u));
      const { command, overrides, overridesKey } = commandsFor(app, units);
      if (command) bullets.push(`• ${view.branch} · ${esc(app.label)}: \`${esc(command)}\``);
      if (overrides) bullets.push(`• ${view.branch} · ${esc(app.label)}: add to ${esc(overridesKey)} \`${esc(Object.entries(overrides).map(([k, v]) => `"${k}": "${v}"`).join(', '))}\``);
    }
  };
  if (usable) commandsOf(usable);
  if (usable && main.lines.length) {
    const fix = new Set(usable.lines.map(fixKey));
    const open = new Set(usable.units.map(lineKey));
    const closed = (l) => fix.has(fixKey(l)) || !open.has(lineKey(l));
    const n = main.lines.filter(closed).length;
    if (n) bullets.push(`• main: merge staging, that closes ${n === main.lines.length ? `all ${n}` : `${n} of ${main.lines.length}`} ${main.lines.length === 1 ? 'fix' : 'fixes'}`);
    const rest = new Set(main.lines.filter((l) => !closed(l)).map(lineKey));
    if (rest.size) commandsOf(main, (u) => rest.has(lineKey(u)));
  } else if (!usable) {
    commandsOf(main);
  }
  // A P0 with no listed fix version. If staging runs that line with nothing open, the advisory does
  // not reach staging's version, so "no fix published" would be false for main: merging closes it.
  const noFix = new Map();
  const cleanOnStaging = new Set();
  const stagingOpen = new Set((usable?.units ?? []).map(lineKey));
  for (const view of [usable, main].filter(Boolean)) {
    for (const u of view.units) {
      if (u.action !== 'now' || (u.lineComplete ? u.to : u.toMajor)) continue;
      if (usable && view === main && !stagingOpen.has(lineKey(u))) { cleanOnStaging.add(`${u.package} ${u.line}`); continue; }
      if (!noFix.has(lineKey(u))) noFix.set(lineKey(u), `• ${esc(u.appLabel)} · ${esc(u.package)} ${esc(u.line)}: no fix published. ${esc(u.verdictReason ?? '')}`.trim());
    }
  }
  if (cleanOnStaging.size) bullets.push(`• main: ${esc([...cleanOnStaging].join(', '))} also ${cleanOnStaging.size === 1 ? 'closes' : 'close'} on merge, staging's version has nothing open`);
  bullets.push(...noFix.values());
  return bullets.length ? bullets : ['• Nothing to fix today.'];
}

// One project's two branches and its overall score. Slack and MySQL both read this, so they agree.
export function projectViews(report, repo, verdict) {
  const apps = report.apps.filter((a) => a.repo === repo && a.kind === 'app');
  const main = branchView(apps.filter((a) => a.branch === 'main'), verdict, 'main');
  const stagingApps = apps.filter((a) => a.branch === 'staging');
  const staging = stagingApps.length ? branchView(stagingApps, verdict, 'staging') : null;
  // Overall is the lower of the two scores: a project is as exposed as its weakest branch.
  const worst = staging && staging.health.score < main.health.score ? staging : main;
  return { apps, main, staging, worst, overall: worst.health.score, status: worst.broken && !worst.lines.length ? 'UNKNOWN' : worst.health.status };
}

// Claude produces the message body from these facts. `expected` is the code's own calculation of the
// same body, never shown to Claude up front: validateBody compares the two before anything is sent.
export function composeInput(report, repo, name, verdict, { usage = null, implicitUse = [] } = {}) {
  const advisories = new Map(report.advisories.map((a) => [a.id, a]));
  const { apps, main, staging } = projectViews(report, repo, verdict);
  const scanOf = (branch) => (branch === 'main' ? usage : usage?.branches?.[branch]);
  const target = (u) => (u.lineComplete ? u.to : u.toMajor) ?? null;
  const branchFacts = (view) => {
    const scan = scanOf(view.branch);
    const searched = scan && !scan.error;
    return {
      broken: view.broken,
      apps: view.apps.filter((a) => a.ok).map((a) => ({ label: a.label, lockfile: a.lockfile, importers: a.importers?.length ?? 1 })),
      p0: view.units.filter((u) => u.action === 'now' && target(u)).map((u) => ({ app: u.appLabel, package: u.package, line: u.line, from: u.from, target: target(u), major: !u.lineComplete, lineFix: Boolean(u.to && u.lineComplete), closes: u.closes, worst: u.worst, url: advisories.get(u.worstId)?.url ?? null, openDays: u.openDays ?? 0, direct: u.direct === true, isNew: Boolean(u.isNew), early: Boolean(u.early), reason: u.verdictReason })),
      p0NoFix: view.units.filter((u) => u.action === 'now' && !target(u)).map((u) => ({ app: u.appLabel, package: u.package, line: u.line, reason: u.verdictReason })),
      open: [...new Set(view.units.map((u) => `${u.package} ${u.line}`))],
      declared: searched ? view.units.filter((u) => u.direct === true && u.prod !== false && !u.tooling).map((u) => ({ app: u.appLabel, package: u.package, from: u.from, importer: u.via?.importer ?? '.', imports: scan.packages?.[u.package]?.count ?? null, mentions: scan.packages?.[u.package]?.mentions ?? 0 })) : [],
      drift: (scan?.drift ?? []).map((d) => ({ lockfile: d.lockfile, manifest: d.manifest, package: d.package, declared: d.declared, locked: d.locked })),
    };
  };
  const units = [...main.units, ...(staging?.units ?? [])];
  const names = (tier) => [...new Set(units.filter((u) => u.tier === tier).map((u) => u.package))].sort();
  const facts = {
    project: name,
    hasStaging: Boolean(staging),
    notAssessed: verdict?.notAssessed ?? 0,
    implicitUse,
    branches: { staging: staging ? branchFacts(staging) : null, main: branchFacts(main) },
    tiers: { P1: names('P1'), P2: names('P2') },
  };
  const plain = (x) => x.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const mainPart = mainSection(main, staging, advisories);
  const steps = whatToDo(main, staging, { usage, implicitUse }).map(plain).join('\n');
  const usable = staging && !staging.broken ? staging : null;
  return {
    facts,
    expected: {
      stagingLines: staging ? staging.lines.map((l) => plain(lineText(l, advisories))) : [],
      mainSameAsStaging: mainPart.same,
      mainLines: mainPart.lines.map(plain),
      unused: unusedLines(apps, usage, implicitUse).map(plain),
      outOfSync: driftLines(usage, staging ? ['staging', 'main'] : ['main']).map(plain),
      tierLine: tierLineText(main, staging, verdict),
      // What "What to do" must contain. Its wording is Claude's; its commands are checked.
      required: {
        tokens: steps.match(/(?:@[\w.-]+\/)?[\w.-]+@[\w.-]+/g) ?? [],
        packages: [...new Set([usable, main].filter(Boolean).flatMap((v) => v.units.filter((u) => u.action === 'now' && !target(u)).map((u) => u.package)))],
        merge: /merge staging, that closes/.test(steps),
      },
    },
  };
}

function projectMessage(report, repo, name, { verdict, advisories, usage = null, implicitUse = [] }) {
  const { apps, main, staging, worst, overall, status } = projectViews(report, repo, verdict);
  const scores = [staging ? `staging ${staging.health.score}` : '', `main ${main.health.score}`, `overall ${overall}`].filter(Boolean).join(' · ');

  const blocks = [header(`:package: ${name} · Health Score · ${scores} · ${STATUS_EMOJI[status]} ${status}`)];
  // Claude produces the body. It reached this point only after matching the code's own calculation.
  // With no such answer the code's version is sent and says so, and the format is the same either way.
  const body = verdict?.ok === true ? verdict.body ?? null : null;
  const part = body
    ? { stagingLines: body.stagingLines.map(mrkdwn), same: body.mainSameAsStaging, mainLines: body.mainLines.map(mrkdwn), unused: body.unused.map(mrkdwn), drift: body.outOfSync.map(mrkdwn), todo: body.todo.map((b) => `• ${mrkdwn(b)}`), tierLine: mrkdwn(body.tierLine) }
    : (() => {
      const m = mainSection(main, staging, advisories);
      const todo = whatToDo(main, staging, { usage, implicitUse });
      if (verdict?.ok === true) todo.unshift('• _:warning: Claude could not produce this message today, so the code built it._');
      else {
        const why = verdict && verdict.ok === false ? ` (${esc(String(verdict.error ?? 'error').slice(0, 120))})` : '';
        todo.unshift(`• _Unfiltered: the daily filter did not run${why}, so every P0 from the scan is listed._`);
      }
      return { stagingLines: staging ? staging.lines.map((l) => lineText(l, advisories)) : [], same: m.same, mainLines: m.lines, unused: unusedLines(apps, usage, implicitUse), drift: driftLines(usage, staging ? ['staging', 'main'] : ['main']), todo, tierLine: tierLineText(main, staging, verdict) };
    })();
  if (staging) blocks.push(...withHead(branchHead(staging), part.stagingLines));
  blocks.push(...withHead(branchHead(main, part.same ? ' · same as staging' : ''), part.mainLines));
  if (part.unused.length) blocks.push(...sectionsOf(part.unused, { prefix: '*Unused* · declared but never used in the code' }));
  if (part.drift.length) blocks.push(...sectionsOf(part.drift, { prefix: '*Out of sync* · package.json and lockfile disagree, versions for these packages may be wrong' }));
  blocks.push(...sectionsOf(part.todo, { prefix: '*What to do*' }));
  blocks.push(section(part.tierLine));
  blocks.push(divider());
  const text = `Security Radar · ${name} · Health Score ${scores} · ${status}`;
  return { text, blocks, health: worst.health, status };
}

/**
 * buildMessages(report, { projects: { 'Org/repo': 'Display name' }, verdicts?, now?, only?, usage?, implicitUse? })
 * -> [{ text, blocks }] one per reported project, worst Health Score first.
 * With `only` (a repo or display name) only that project's message is returned.
 */
export function buildMessages(report, { projects, verdicts = null, now = new Date(), only = null, usage = null, implicitUse = [] } = {}) {
  const advisories = new Map(report.advisories.map((a) => [a.id, a]));
  const repos = Object.keys(projects).filter((repo) => report.apps.some((a) => a.repo === repo && a.kind === 'app'));
  const messages = repos.map((repo) => ({ repo, ...projectMessage(report, repo, projects[repo], { verdict: verdicts?.projects?.[repo] ?? null, advisories, now, usage: usage?.repos?.[repo] ?? null, implicitUse }) }));
  messages.sort((a, b) => a.health.score - b.health.score || a.repo.localeCompare(b.repo));
  if (only) {
    const m = messages.find((x) => x.repo === only || x.repo.split('/')[1] === only || projects[x.repo].toLowerCase() === only.toLowerCase());
    if (!m) throw new Error(`no reported project matches "${only}"`);
    return [m].map(({ text, blocks }) => ({ text, blocks }));
  }
  return messages.map(({ text, blocks }) => ({ text, blocks }));
}
