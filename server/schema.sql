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
  PRIMARY KEY (scan_id, project, branch, app, advisory_id, package, installed),
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

-- Example questions the history answers:
--   what got fixed in the last 30 days:
--     SELECT f.project, f.branch, f.advisory_id, MAX(s.scan_date) AS last_open FROM findings f JOIN scans s ON s.id=f.scan_id
--     GROUP BY f.project, f.branch, f.advisory_id HAVING last_open < (SELECT MAX(scan_date) FROM scans) AND last_open >= CURDATE() - INTERVAL 30 DAY;
--   how long each critical stayed open per project:
--     SELECT project, advisory_id, MIN(s.scan_date) first_day, MAX(s.scan_date) last_day, DATEDIFF(MAX(s.scan_date), MIN(s.scan_date))+1 days
--     FROM findings f JOIN scans s ON s.id=f.scan_id WHERE severity='critical' GROUP BY project, advisory_id;
