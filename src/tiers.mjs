// Priority tiers and the project Health Score. Pure functions shared by the report, the Slack
// messages and the HTML report, so every number a reader sees comes from the same rule.
//
//   P0  deployed dependency graph of a web app, critical or high, a fix exists (same line, or a
//       major bump when the app declares the package itself). Goes to Slack.
//   P1  production but moderate/low, or critical/high with no fix the app can take, or judged
//       not reachable by the daily Claude filter. Full report only.
//   P2  dev-only in the lockfile, or in the owner's build-tooling list. Full report only; never
//       named in Slack.

import { isUrgent } from './format.mjs';

// watchlist.report.toolingPackages: regular expressions over package names, owner-editable.
export function toolingMatcher(patterns = []) {
  const res = patterns.map((p) => new RegExp(p));
  return (name) => res.some((re) => re.test(name));
}

// unit: { worst, to, fixAbove, direct, prod, tooling }: to = same-line target covering every critical/high; fixAbove = lowest fix on another line
export function tierFor(unit) {
  if (unit.prod === false) return { tier: 'P2', reason: 'dev-only' };
  if (unit.tooling) return { tier: 'P2', reason: 'build tooling' };
  if (!isUrgent(unit.worst)) return { tier: 'P1', reason: 'moderate/low' };
  if (unit.to) return { tier: 'P0', reason: 'fix in line' };
  if (unit.fixAbove && unit.direct === true) return { tier: 'P0', reason: 'major bump' };
  return { tier: 'P1', reason: unit.fixAbove ? 'fix is another major, not a direct dependency' : 'no fix published' };
}

// Colour follows P0 only: a project goes GREEN the day its P0s are fixed, whatever the P1 backlog.
//   RED    any critical P0 package open        score at most 59
//   AMBER  only high P0 packages open          score at most 89
//   GREEN  no P0                               90..100
// Inside the band the number moves with the backlog: 15% off per critical package, 3% per high
// package, and up to 10 points for the P1 list (half a point per package), floor 1.
export function healthScore({ critical = 0, high = 0, p1 = 0 }) {
  const backlog = Math.min(10, Math.ceil(p1 / 2));
  let score = Math.round(100 * 0.85 ** critical * 0.97 ** high);
  let status = 'GREEN';
  if (critical) { status = 'RED'; score = Math.min(59, score); }
  else if (high) { status = 'AMBER'; score = Math.min(89, score); }
  return { score: Math.max(1, score - backlog), status };
}

export const STATUS_EMOJI = { RED: ':red_circle:', AMBER: ':large_orange_circle:', GREEN: ':large_green_circle:', UNKNOWN: ':white_circle:' };
