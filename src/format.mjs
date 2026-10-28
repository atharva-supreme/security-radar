// Message and issue text. Plain text so it reads the same in Slack, a GitHub issue and a terminal.

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, moderate: 2, low: 3, unknown: 4 };
export const severityRank = (s) => SEVERITY_RANK[s] ?? 4;
export const isUrgent = (s) => severityRank(s) <= 1;

export function fmtDate(iso) {
  if (!iso) return 'unknown date';
  const d = new Date(iso);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()} ${months.at(d.getUTCMonth())} ${d.getUTCFullYear()} ${hh}:${mm} UTC`;
}

export function fmtIst(date = new Date()) {
  const ist = new Date(date.getTime() + 330 * 60 * 1000);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const hh = String(ist.getUTCHours()).padStart(2, '0');
  const mm = String(ist.getUTCMinutes()).padStart(2, '0');
  return `${ist.getUTCDate()} ${months.at(ist.getUTCMonth())} ${hh}:${mm} IST`;
}

const vendor = (rec) => (rec.source.startsWith('repo:') ? rec.source.slice(5) : 'GitHub Advisory Database');
const packageNames = (rec) => [...new Set(rec.packages.map((p) => p.name))].join(', ') || 'unknown package';

function repoLines(repos) {
  const lines = ['Our repos'];
  const col = (label, items) => (items.length ? `  ${label.padEnd(10)} ${items.join(', ')}` : null);
  lines.push(col('affected', repos.affected.map((r) => `${r.label} (${r.installed})`)));
  lines.push(col('clear', repos.clear));
  lines.push(col('unknown', repos.unknown));
  if (!repos.affected.length && !repos.clear.length && !repos.unknown.length) lines.push('  (no repos configured)');
  return lines.filter(Boolean);
}

export function releaseMessage(rec, repos, { issueUrl, published = new Map() } = {}) {
  const lines = [
    `${rec.severity.toUpperCase()} · ${packageNames(rec)} · ${rec.id}`,
    rec.summary,
    `Published ${fmtDate(rec.published_at)} by ${vendor(rec)} · ${rec.cve ?? 'no CVE yet'}`,
  ];
  for (const p of rec.packages) {
    const onNpm = published.get(`${p.name}@${p.fixed}`);
    const npmNote = onNpm === true ? ', on npm' : onNpm === false ? ', NOT on npm yet' : '';
    lines.push(`Affected: ${p.name} ${p.range ?? '(range not stated)'} · Fixed: ${p.fixed ?? 'not stated'}${p.fixed ? npmNote : ''}`);
  }
  lines.push('', ...repoLines(repos), '', `Advisory: ${rec.url}`);
  if (issueUrl) lines.push(`Tracking issue: ${issueUrl}`);
  return lines.join('\n');
}

export function batchMessage(entries) {
  const lines = [`${entries.length} lower-severity ${entries.length === 1 ? 'advisory' : 'advisories'}`];
  for (const { rec, issueUrl } of entries) {
    const fixed = [...new Set(rec.packages.map((p) => p.fixed).filter(Boolean))].join(', ') || 'not stated';
    lines.push(`${rec.severity} · ${packageNames(rec)} · ${rec.id} · ${rec.summary} · fixed ${fixed}${issueUrl ? ` · ${issueUrl}` : ''}`);
  }
  return lines.join('\n');
}

export function feedMessage({ feed, item }, nodeDeclared = [], issueUrl) {
  const lines = [`FEED · ${feed.name}`, item.title, `Published ${fmtDate(item.date)}`, item.link];
  if (nodeDeclared.length) {
    lines.push('', 'Our repos declare', ...nodeDeclared.map((r) => `  ${r.label.padEnd(44)} node ${r.node}`));
    lines.push('Compare these to the affected lines in the post. The watcher does not parse runtime ranges.');
  }
  if (issueUrl) lines.push('', `Tracking issue: ${issueUrl}`);
  return lines.join('\n');
}

export function quietMessage({ now = new Date(), counts, stillOpen, errors }) {
  const lines = [`Security Radar · ${fmtIst(now)} · no new advisories`];
  lines.push(`Checked ${counts.packages} packages, ${counts.feeds} feeds, ${counts.repos} repos.`);
  if (stillOpen.length) {
    const repos = new Set(stillOpen.map((o) => o.label)).size;
    lines.push(`${repos} repo${repos === 1 ? '' : 's'} still on an affected version:`);
    for (const o of stillOpen) {
      const n = o.ids.length;
      lines.push(`  ${o.label}: ${o.pkg} ${o.installed}, ${n} ${n === 1 ? 'advisory' : 'advisories'}, fixed in ${o.fixed ?? 'not stated'}, oldest open since ${fmtDate(o.since).slice(0, -10)}`);
    }
  } else if (counts.repos) {
    lines.push('All repos on patched versions.');
  }
  if (errors.length) lines.push('', 'Errors this run:', ...errors.map((e) => `  ${e}`));
  return lines.join('\n');
}

export function errorMessage(errors, now = new Date()) {
  return [`Security Radar · ${fmtIst(now)} · run had errors`, ...errors.map((e) => `  ${e}`)].join('\n');
}

export function issueTitle(rec) {
  return `[${rec.severity}] ${rec.id}: ${rec.summary}`.slice(0, 250);
}

export function issueBody(rec, repos) {
  const lines = [
    `**Severity:** ${rec.severity}`,
    `**Package(s):** ${packageNames(rec)}`,
    `**Published:** ${fmtDate(rec.published_at)} by ${vendor(rec)}`,
    `**CVE:** ${rec.cve ?? 'none yet'}`,
    `**Advisory:** ${rec.url}`,
    '',
    '| Package | Affected range | Fixed in |',
    '| --- | --- | --- |',
    ...rec.packages.map((p) => `| \`${p.name}\` | ${p.range ?? 'not stated'} | ${p.fixed ?? 'not stated'} |`),
    '',
    '### Our repos',
    '',
  ];
  if (repos.affected.length) lines.push('**Affected**', ...repos.affected.map((r) => `- ${r.label}: ${r.installed}`), '');
  if (repos.clear.length) lines.push('**Clear**', ...repos.clear.map((r) => `- ${r}`), '');
  if (repos.unknown.length) lines.push('**Could not read lockfile**', ...repos.unknown.map((r) => `- ${r}`), '');
  lines.push('---', 'Opened automatically by Security Radar. Close when every affected repo is on the fixed version.');
  return lines.join('\n');
}

export function feedIssueTitle({ feed, item }) {
  return `[feed] ${feed.name}: ${item.title}`.slice(0, 250);
}

export function feedIssueBody({ feed, item }, nodeDeclared = []) {
  const lines = [`**Feed:** ${feed.name}`, `**Published:** ${fmtDate(item.date)}`, `**Link:** ${item.link}`, ''];
  if (nodeDeclared.length) {
    lines.push('### Our repos declare', '', '| Repo | Node |', '| --- | --- |', ...nodeDeclared.map((r) => `| ${r.label} | ${r.node} |`), '');
  }
  lines.push('---', 'Opened automatically by Security Radar. Read the post, compare the affected lines to what each repo declares, close when done.');
  return lines.join('\n');
}
