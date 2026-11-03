-- Security Radar history. One row in `scans` per daily run, one row in `findings` per
-- (scan, app, advisory, installed version), one row in `advisories` per advisory ever seen.
-- Loaded by scripts/store.mjs from data/reports/YYYY-MM-DD.json. Safe to re-run: idempotent.

CREATE TABLE IF NOT EXISTS scans (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  scan_date     DATE         NOT NULL,
  generated_at  DATETIME     NOT NULL,
  status        VARCHAR(8)   NOT NULL,
  open_total    INT NOT NULL, distinct_total INT NOT NULL,
  critical_n    INT NOT NULL, high_n INT NOT NULL, moderate_n INT NOT NULL, low_n INT NOT NULL,
  new_open      INT NOT NULL, early_n INT NOT NULL, malicious_n INT NOT NULL,
  packages_n    INT NOT NULL, apps_n INT NOT NULL, projects_n INT NOT NULL,
  UNIQUE KEY uq_scan_date (scan_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS advisories (
  id            VARCHAR(40)  PRIMARY KEY,
  severity      VARCHAR(12)  NOT NULL,
  malicious     TINYINT(1)   NOT NULL DEFAULT 0,
  cve           VARCHAR(24)  NULL,
  package       VARCHAR(214) NOT NULL,
  summary       VARCHAR(512) NOT NULL,
  url           VARCHAR(512) NOT NULL,
  published_at  DATETIME     NULL,
  first_seen    DATE         NOT NULL,
  last_seen     DATE         NOT NULL,
  INDEX ix_adv_package (package), INDEX ix_adv_severity (severity)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS findings (
  scan_id       INT          NOT NULL,
  row_hash      CHAR(40)     NOT NULL,  -- sha1(project|branch|app|advisory|package|installed): six text columns exceed the 3072-byte key limit
  project       VARCHAR(128) NOT NULL,
  branch        VARCHAR(128) NOT NULL,
  app           VARCHAR(255) NOT NULL,
  kind          VARCHAR(8)   NOT NULL,
  advisory_id   VARCHAR(40)  NOT NULL,
  severity      VARCHAR(12)  NOT NULL,
  package       VARCHAR(214) NOT NULL,
  installed     VARCHAR(64)  NOT NULL,
  fixed         VARCHAR(64)  NULL,
  fixed_on_npm  TINYINT(1)   NULL,
  direct        TINYINT(1)   NULL,
  early         TINYINT(1)   NOT NULL DEFAULT 0,
  is_new        TINYINT(1)   NOT NULL DEFAULT 0,
  open_days     INT          NULL,
  PRIMARY KEY (scan_id, row_hash),
  INDEX ix_f_project (project, branch), INDEX ix_f_advisory (advisory_id), INDEX ix_f_severity (severity),
  CONSTRAINT fk_findings_scan FOREIGN KEY (scan_id) REFERENCES scans(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Tooling lockfiles are stored by counts only (their per-advisory rows are not in the report).
CREATE TABLE IF NOT EXISTS app_counts (
  scan_id       INT          NOT NULL,
  project       VARCHAR(128) NOT NULL,
  branch        VARCHAR(128) NOT NULL,
  app           VARCHAR(255) NOT NULL,
  kind          VARCHAR(8)   NOT NULL,
  ok            TINYINT(1)   NOT NULL,
  packages_n    INT          NOT NULL DEFAULT 0,
  critical_n    INT NOT NULL DEFAULT 0, high_n INT NOT NULL DEFAULT 0, moderate_n INT NOT NULL DEFAULT 0, low_n INT NOT NULL DEFAULT 0,
  command       TEXT         NULL,
  PRIMARY KEY (scan_id, project, branch, app),
  CONSTRAINT fk_counts_scan FOREIGN KEY (scan_id) REFERENCES scans(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- What Claude decided and what Slack showed. Loaded by scripts/store-tiers.mjs, which also creates them
-- (src/history.mjs holds the same definitions).
CREATE TABLE IF NOT EXISTS project_health (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS package_tiers (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Example questions the history answers:
--   what got fixed in the last 30 days:
--     SELECT f.project, f.branch, f.advisory_id, MAX(s.scan_date) AS last_open FROM findings f JOIN scans s ON s.id=f.scan_id
--     GROUP BY f.project, f.branch, f.advisory_id HAVING last_open < (SELECT MAX(scan_date) FROM scans) AND last_open >= CURDATE() - INTERVAL 30 DAY;
--   how long each critical stayed open per project:
--     SELECT project, advisory_id, MIN(s.scan_date) first_day, MAX(s.scan_date) last_day, DATEDIFF(MAX(s.scan_date), MIN(s.scan_date))+1 days
--     FROM findings f JOIN scans s ON s.id=f.scan_id WHERE severity='critical' GROUP BY project, advisory_id;
--   Health Score trend for a project:
--     SELECT s.scan_date, h.branch, h.score, h.status FROM project_health h JOIN scans s ON s.id=h.scan_id WHERE h.display_name='VectorLabs' ORDER BY s.scan_date, h.branch;
--   did a package's tier ever change:
--     SELECT t.project, t.branch, t.package, t.version_line, COUNT(DISTINCT t.tier) tiers FROM package_tiers t GROUP BY 1,2,3,4 HAVING tiers > 1;
