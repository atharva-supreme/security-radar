// Which watchlist rows a scan reads. watchlist.scan:
//   "reported"  only the repositories in watchlist.report.projects, deployed (kind "app") lockfiles only.
//               Discovery still writes every repository into watchlist.repos; the rows just sit there.
//   "all"       every row (the organisation-wide scan). Slack still posts the reported projects only.
// Missing or unknown values behave as "all", so an old watchlist keeps working.

export function scanRows(watchlist) {
  const rows = watchlist.repos ?? [];
  const mode = watchlist.scan ?? 'all';
  if (mode !== 'reported') return { mode: 'all', rows, skipped: 0 };
  const reported = new Set(Object.keys(watchlist.report?.projects ?? {}));
  const kept = rows.filter((r) => reported.has(r.repo) && (r.kind ?? 'app') === 'app');
  return { mode, rows: kept, skipped: rows.length - kept.length };
}
