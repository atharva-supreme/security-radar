// Slack messages built in code from report.json: one summary, one message per affected project
// (both branches in one native table block), one "clear" list. Nothing here is free text from a
// model; the only model-written part is the optional narrative paragraph passed in by the caller.
//
// Slack limits that shape this file (docs.slack.dev/reference/block-kit/blocks/table-block):
//   one table block per message · 100 rows · 20 columns · 10,000 characters across all cells
//   section text 3,000 characters · 50 blocks per message
// A project that does not fit in one message is split into "Name (1/2)", "Name (2/2)": rows are
// never dropped and never wrapped (column_settings.is_wrapped = false on every column).

import { severityRank, isUrgent } from './format.mjs';

const MAX_ROWS = 90; // data rows per table, under Slack's 100 with the header row
const MAX_CELL_CHARS = 9000; // under Slack's 10,000 per message
const MAX_SECTION = 2900; // under Slack's 3,000 per section
const TOP_ISSUES = 10;

const STATUS_EMOJI = { RED: ':red_circle:', AMBER: ':large_yellow_circle:', GREEN: ':large_green_circle:', UNKNOWN: ':white_circle:' };
const SEV_LABEL = { critical: 'CRITICAL', high: 'HIGH', moderate: 'MODERATE', medium: 'MODERATE', low: 'LOW' };
const SEV_EMOJI = { critical: ':red_circle:', high: ':large_orange_circle:', moderate: ':large_yellow_circle:', medium: ':large_yellow_circle:', low: ':white_circle:' };
const COLUMNS = ['Branch', 'App', 'Package', 'Installed', 'Upgrade to', 'Closes', 'Severity', 'Open'];

// mrkdwn text fields need these three escaped; raw_text and rich_text cells do not.
export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sevLabel = (s) => SEV_LABEL[s] ?? String(s ?? 'unknown').toUpperCase();
const raw = (text) => ({ type: 'raw_text', text: String(text) });
const section = (text) => ({ type: 'section', text: { type: 'mrkdwn', text } });
const divider = () => ({ type: 'divider' });
const dateLabel = (d) => d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
const timeIst = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) + ' IST';

function richCell(parts) {
  // parts: [{ text, url?, bold? }]
  const elements = parts.map((p) => {
    const style = p.bold ? { style: { bold: true } } : {};
    return p.url ? { type: 'link', url: p.url, text: p.text, ...style } : { type: 'text', text: p.text, ...style };
  });
  return { type: 'rich_text', elements: [{ type: 'rich_text_section', elements }] };
}
const cellChars = (cell) => (cell.type === 'rich_text' ? cell.elements[0].elements.reduce((n, e) => n + e.text.length, 0) : cell.text.length);

// The worst open advisory behind an upgrade row: severity first, then longest open.
function worstBehind(app, upgrade) {
  return app.open
    .filter((o) => o.package === upgrade.package)
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || (b.openDays ?? 0) - (a.openDays ?? 0))[0];
}

// Status of a branch from its deployed (kind "app") lockfiles only, matching report.projects[].appStatus.
function branchStatus(apps) {
  if (apps.some((a) => !a.ok)) return 'UNKNOWN';
  const open = apps.flatMap((a) => a.open ?? []);
  if (open.some((o) => isUrgent(o.severity))) return 'RED';
  if (open.length) return 'AMBER';
  return 'GREEN';
}
const count = (apps, sev) => apps.reduce((n, a) => n + (a.counts?.[sev] ?? 0), 0);

export function tableRows(branchApps, advisories) {
  // branchApps: [{ branch, apps: [appRow] }] -> data rows (arrays of cells) for the table block
  const rows = [];
  for (const { branch, apps } of branchApps) {
    for (const app of apps) {
      if (!app.ok) {
        rows.push([raw(branch), raw(app.label), raw('lockfile could not be read'), raw('—'), raw('—'), raw('—'), raw('—'), raw('—')]);
        continue;
      }
      if (!app.upgrades?.length) {
        rows.push([raw(branch), raw(app.label), raw('clear'), raw('—'), raw('—'), raw('—'), raw('—'), raw('—')]);
        continue;
      }
      for (const up of app.upgrades) {
        const worst = worstBehind(app, up);
        const adv = worst ? advisories.get(worst.id) : null;
        const label = sevLabel(up.worst);
        const severity = adv?.url ? richCell([{ text: label, url: adv.url, bold: true }]) : richCell([{ text: label, bold: true }]);
        const openParts = [{ text: worst?.openDays != null ? `${worst.openDays} days` : '—' }];
        if (worst?.isNew) openParts.push({ text: ' · ' }, { text: 'NEW', bold: true });
        if (worst?.early) openParts.push({ text: ' · ' }, { text: 'early', bold: true });
        rows.push([
          raw(branch),
          raw(app.label),
          raw(up.package),
          raw(up.from.join(', ')),
          raw(up.to ?? 'none yet'),
          raw(String(up.closes)),
          severity,
          richCell(openParts),
        ]);
      }
    }
  }
  return rows;
}

function tableBlock(rows) {
  return {
    type: 'table',
    column_settings: COLUMNS.map((_, i) => ({ align: i === 5 ? 'right' : 'left', is_wrapped: false })),
    rows: [COLUMNS.map(raw), ...rows],
  };
}

// Split data rows into chunks that respect the row and character limits.
export function chunkRows(rows) {
  const chunks = [];
  let current = [];
  let chars = COLUMNS.join('').length;
  for (const row of rows) {
    const n = row.reduce((s, c) => s + cellChars(c), 0);
    if (current.length && (current.length >= MAX_ROWS || chars + n > MAX_CELL_CHARS)) {
      chunks.push(current);
      current = [];
      chars = COLUMNS.join('').length;
    }
    current.push(row);
    chars += n;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

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

function projectView(report, repo, name, advisories) {
  const apps = report.apps.filter((a) => a.repo === repo && a.kind === 'app');
  const branches = [...new Set(apps.map((a) => a.branch))];
  const perBranch = branches.map((branch) => {
    const list = apps.filter((a) => a.branch === branch);
    return { branch, apps: list, status: branchStatus(list), critical: count(list, 'critical'), high: count(list, 'high') };
  });
  const affected = perBranch.some((b) => b.status !== 'GREEN');
  const notes = [...new Set(apps.flatMap((a) => a.notes ?? []))];
  return { repo, name, apps, perBranch, affected, notes, rows: tableRows(perBranch, advisories) };
}

export function projectMessages(view) {
  const chunks = chunkRows(view.rows);
  const statusLine = view.perBranch
    .map((b) => `\`${b.branch}\` · ${STATUS_EMOJI[b.status]} *${b.status}* · ${b.critical} critical, ${b.high} high`)
    .join('\n');
  const fallback = `Security Radar · ${view.name} · ${view.perBranch.map((b) => `${b.branch} ${b.status} (${b.critical} critical, ${b.high} high)`).join(' · ')}`;
  return chunks.map((rows, i) => {
    const part = chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : '';
    const blocks = [section(`*:package: ${esc(view.name)}${part}*\n${statusLine}`), tableBlock(rows)];
    if (i === chunks.length - 1 && view.notes.length) {
      blocks.push(...sectionsOf(view.notes.map((n) => `_• ${esc(n)}_`), { prefix: ':memo: _Note:_' }));
    }
    return { text: fallback + part, blocks };
  });
}

function summaryMessage(report, views, advisories, { narrative, now }) {
  const reportedProjects = new Set(views.map((v) => v.apps[0]?.project).filter(Boolean));
  const apps = views.flatMap((v) => v.apps);
  const open = apps.flatMap((a) => a.open ?? []);
  const distinct = new Set(open.map((o) => o.id));
  const critical = open.filter((o) => o.severity === 'critical').length;
  const high = open.filter((o) => o.severity === 'high').length;
  const affected = views.filter((v) => v.affected);
  const status = apps.some((a) => !a.ok) ? 'UNKNOWN' : critical + high ? 'RED' : open.length ? 'AMBER' : 'GREEN';
  const oldestCritical = Math.max(0, ...open.filter((o) => o.severity === 'critical').map((o) => o.openDays ?? 0));
  const newOpen = new Set(open.filter((o) => o.isNew).map((o) => o.id)).size;
  const early = new Set(open.filter((o) => o.early).map((o) => o.id)).size;
  const malicious = report.advisories.filter((a) => a.malicious && distinct.has(a.id)).length;
  const date = dateLabel(now);

  if (status === 'GREEN') {
    const text = `:large_green_circle: *Security Radar · ${date}* · ${views.length} projects clear, no action needed.`;
    return { text: `Security Radar · ${date} · all clear`, blocks: [section(text)] };
  }

  const header = [
    `${STATUS_EMOJI[status]} *Security Radar · ${date}*`,
    `_${affected.length} of ${views.length} projects affected · ${critical + high} critical/high open across ${distinct.size} advisories · oldest critical open ${oldestCritical} days · ${newOpen} new since yesterday${early ? `, ${early} early` : ''}${malicious ? `, ${malicious} MALICIOUS` : ''}_`,
  ];
  if (status === 'UNKNOWN') {
    const broken = apps.filter((a) => !a.ok);
    header.push(`:warning: ${broken.length} lockfile(s) could not be read: ${esc(broken[0].error ?? 'unknown error')}`);
  }
  const blocks = [section(header.join('\n'))];
  if (narrative) blocks.push(section(esc(narrative.trim())));
  blocks.push(divider());

  // Top open issues: distinct critical/high advisories that hit a reported project's deployed lockfile.
  const urgent = report.advisories.filter((a) => isUrgent(a.severity) && distinct.has(a.id));
  const lines = urgent.slice(0, TOP_ISSUES).map((a) => {
    const hits = (a.hits ?? []).filter((h) => h.kind === 'app' && reportedProjects.has(h.project));
    const projects = new Set(hits.map((h) => h.project)).size;
    const tags = [a.early ? ':zap: *early*' : '', a.isNew ? '*NEW*' : '', a.malicious ? ':skull: *MALICIOUS*' : ''].filter(Boolean);
    return `• ${SEV_EMOJI[a.severity]} *${sevLabel(a.severity)}* · <${a.url}|${a.id}> · ${esc(a.summary)} · _${esc(a.package)} · open ${a.openDays} days · hits ${hits.length} apps in ${projects} projects_${tags.length ? ' · ' + tags.join(' · ') : ''}`;
  });
  if (lines.length) {
    blocks.push(section('*:rotating_light: Open issues · critical and high*'));
    blocks.push(...sectionsOf(lines));
    if (urgent.length > TOP_ISSUES) blocks.push(section(`_… and ${urgent.length - TOP_ISSUES} more critical/high; every project's message below lists its own_`));
    blocks.push(divider());
  }
  const packages = apps.reduce((n, a) => n + (a.packages ?? 0), 0);
  blocks.push(section(`_${packages.toLocaleString('en-US')} packages in ${apps.length} lockfiles across ${views.length} projects · scan ${timeIst(report.generatedAt)}_`));
  return { text: `Security Radar · ${date} · ${status} · ${affected.length} of ${views.length} projects affected`, blocks };
}

/**
 * buildMessages(report, { projects: { 'Org/repo': 'Display name' }, narrative?, now?, only? })
 * -> [{ text, blocks }] in posting order: summary, one or more per affected project (worst first), clear list.
 * With `only` (a repo or display name) only that project's messages are returned.
 */
export function buildMessages(report, { projects, narrative = '', now = new Date(), only = null } = {}) {
  const advisories = new Map(report.advisories.map((a) => [a.id, a]));
  const order = []; // repos worst first, from report.projects[] (already sorted worst first)
  for (const p of report.projects) if (projects[p.repo] && !order.includes(p.repo)) order.push(p.repo);
  for (const repo of Object.keys(projects)) if (!order.includes(repo)) order.push(repo);
  const views = order.map((repo) => projectView(report, repo, projects[repo], advisories)).filter((v) => v.apps.length);

  if (only) {
    const v = views.find((x) => x.repo === only || x.repo.split('/')[1] === only || x.name.toLowerCase() === only.toLowerCase());
    if (!v) throw new Error(`no reported project matches "${only}"`);
    return projectMessages(v);
  }

  const messages = [summaryMessage(report, views, advisories, { narrative, now })];
  for (const v of views.filter((x) => x.affected)) messages.push(...projectMessages(v));
  const clear = views.filter((v) => !v.affected);
  if (clear.length && views.some((v) => v.affected)) {
    messages.push({ text: `Security Radar · clear: ${clear.map((v) => v.name).join(', ')}`, blocks: [section(`:large_green_circle: *Clear:* ${clear.map((v) => esc(v.name)).join(', ')}`)] });
  }
  return messages;
}
