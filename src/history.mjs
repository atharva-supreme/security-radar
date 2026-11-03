// The rows that record what Claude decided and what Slack showed, for MySQL. Pure: no I/O.
//
//   project_health: one row per project and branch, plus one 'overall' row. Same numbers as the Slack header.
//   package_tiers:  one row per app, package and version line, with the tier and Claude's reason.
//
// Loaded by scripts/store-tiers.mjs after the filter step, because tiers do not exist before it.

import { createHash } from 'node:crypto';
import { applyVerdict } from './filter.mjs';
import { projectViews } from './slack.mjs';

export const HISTORY_DDL = [
  `CREATE TABLE IF NOT EXISTS project_health (
  scan_id       INT          NOT NULL,
  project       VARCHAR(128) NOT NULL,
  display_name  VARCHAR(128) NOT NULL,
  branch        VARCHAR(128) NOT NULL,  -- staging, main, or overall (the lower of the two)
  score         INT          NOT NULL,
  status        VARCHAR(8)   NOT NULL,
  critical_n    INT NOT NULL, high_n INT NOT NULL,
  p0_n          INT NOT NULL, p1_n INT NOT NULL, p2_n INT NOT NULL,
  filtered      TINYINT(1)   NOT NULL,  -- 0 when the Claude filter did not run and scanner tiers were used
  not_assessed  INT          NOT NULL DEFAULT 0,
  what_to_do    TEXT         NULL,      -- on the overall row: the section as sent to Slack
  PRIMARY KEY (scan_id, project, branch),
  INDEX ix_h_project (project, branch), INDEX ix_h_status (status),
  CONSTRAINT fk_health_scan FOREIGN KEY (scan_id) REFERENCES scans(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS package_tiers (
  scan_id       INT          NOT NULL,
  row_hash      CHAR(40)     NOT NULL,  -- sha1(project|branch|app|package|version_line)
  project       VARCHAR(128) NOT NULL,
  branch        VARCHAR(128) NOT NULL,
  app           VARCHAR(255) NOT NULL,
  package       VARCHAR(214) NOT NULL,
  version_line  VARCHAR(32)  NOT NULL,
  tier          VARCHAR(2)   NOT NULL,  -- P0 fix now, P1 later, P2 no action
  scanner_tier  VARCHAR(2)   NOT NULL,  -- what the rules alone would have said
  assessed      TINYINT(1)   NOT NULL,  -- 1 when Claude decided it
  reason        VARCHAR(255) NULL,
  severity      VARCHAR(12)  NOT NULL,
  installed     VARCHAR(255) NOT NULL,
  fix_to        VARCHAR(64)  NULL,
  direct        TINYINT(1)   NULL,
  prod          TINYINT(1)   NULL,
  via           VARCHAR(214) NULL,
  decided_on    DATE         NULL,      -- the day Claude first gave this answer
  PRIMARY KEY (scan_id, row_hash),
  INDEX ix_t_project (project, branch), INDEX ix_t_tier (tier), INDEX ix_t_package (package),
  CONSTRAINT fk_tiers_scan FOREIGN KEY (scan_id) REFERENCES scans(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

const bit = (v) => (v === null || v === undefined ? null : v ? 1 : 0);

export function historyRows(report, { projects, verdicts = null }) {
  const health = [];
  const tiers = [];
  for (const [repo, name] of Object.entries(projects)) {
    const apps = report.apps.filter((a) => a.repo === repo && a.kind === 'app');
    if (!apps.length) continue;
    const project = apps[0].project;
    const verdict = verdicts?.projects?.[repo] ?? null;
    const filtered = verdict?.ok === true;
    const { main, staging, worst, overall, status } = projectViews(report, repo, verdict);
    const row = (branch, view, score, st, todo = null) => {
      const crit = view.lines.filter((l) => l.worst === 'critical').length;
      const count = (tier) => new Set(view.units.filter((u) => u.tier === tier).map((u) => u.package)).size;
      return [project, name, branch, score, st, crit, view.lines.length - crit, view.lines.length, count('P1'), count('P2'), bit(filtered), verdict?.notAssessed ?? 0, todo];
    };
    if (staging) health.push(row('staging', staging, staging.health.score, staging.broken && !staging.lines.length ? 'UNKNOWN' : staging.health.status));
    health.push(row('main', main, main.health.score, main.broken && !main.lines.length ? 'UNKNOWN' : main.health.status));
    health.push(row('overall', worst, overall, status, Array.isArray(verdict?.todo) ? verdict.todo.join('\n') : null));

    const decided = new Map((verdict?.lines ?? []).flatMap((l) => (l.apps ?? [l.app]).map((a) => [`${l.branch}|${a}|${l.package}|${l.line}`, l])));
    for (const a of apps.filter((x) => x.ok)) {
      const units = filtered ? applyVerdict(a.upgrades ?? [], verdict, a.label, a.branch) : (a.upgrades ?? []);
      (a.upgrades ?? []).forEach((scan, i) => {
        const u = units[i];
        const l = decided.get(`${a.branch}|${a.label}|${scan.package}|${scan.line}`);
        const hash = createHash('sha1').update([project, a.branch, a.label, scan.package, scan.line].join('|')).digest('hex');
        tiers.push([hash, project, a.branch, a.label, scan.package, scan.line, u.tier, scan.tier, bit(l?.assessed === true), String(l?.reason ?? scan.reason ?? '').slice(0, 255), scan.worst, scan.from.join(', ').slice(0, 255), scan.lineComplete ? scan.to : scan.toMajor ?? null, bit(scan.direct), bit(scan.prod), scan.via?.direct ?? null, l?.decidedOn ?? null]);
      });
    }
  }
  return { health, tiers };
}
