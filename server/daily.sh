#!/usr/bin/env bash
# Security Radar, daily run on the server. Installed by server/install.sh, started by cron.
#
#   1. scan     node watch.mjs            -> report.json (+ state.json, packages.json caches): every finding, tiered P0/P1/P2
#   2. keep     copy report.json          -> data/reports/YYYY-MM-DD.json (one file per day, never overwritten)
#   3. store    node scripts/store.mjs    -> MySQL (scans, findings, advisories) for history queries
#   4. usage    node scripts/usage.mjs    -> data/usage/YYYY-MM-DD.json: where each project's own code imports the flagged packages, per branch
#   5. filter   node scripts/filter.mjs   -> data/verdicts/YYYY-MM-DD.json: Claude decides per project what is worth fixing today
#   6. tell     node scripts/slack.mjs    -> Slack via the webhook: one message per project (staging, main, What to do, Health Score)
#
# Each step logs to logs/YYYY-MM-DD.log. A failed scan stops the run (there is nothing to tell).
# A failed store, usage or filter does not: Slack still goes out, with every P0 line and an
# "unfiltered" note when the filter did not run.

set -uo pipefail
cd "$(dirname "$0")/.."

set -a; . ./.env; set +a
# cron starts with a bare PATH: make node and claude reachable wherever they were installed.
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"
export TZ="${TZ:-Asia/Kolkata}"
DAY="$(date +%F)"
mkdir -p data/reports data/usage data/verdicts logs
LOG="logs/$DAY.log"
log() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$LOG"; }
REPORT="data/reports/$DAY.json"
USAGE="data/usage/$DAY.json"
VERDICTS="data/verdicts/$DAY.json"

log "scan start"
if ! node watch.mjs >> "$LOG" 2>&1; then
  log "scan FAILED (see above); nothing sent"
  exit 1
fi
cp -f report.json "$REPORT"
log "report kept as $REPORT"

if [ -n "${MYSQL_URL:-}" ]; then
  if node scripts/store.mjs "$REPORT" >> "$LOG" 2>&1; then log "stored in MySQL"; else log "store FAILED (continuing)"; fi
else
  log "MYSQL_URL not set, history store skipped"
fi

log "usage start"
if node scripts/usage.mjs "$REPORT" >> "$LOG" 2>&1; then log "usage done"; else log "usage FAILED (continuing; the filter runs without code search)"; fi

log "filter start"
if node scripts/filter.mjs "$REPORT" --usage "$USAGE" --out "$VERDICTS" >> "$LOG" 2>&1; then
  log "filter done"
else
  log "filter FAILED (continuing; Slack gets the unfiltered P0 lines)"
fi

if [ -n "${MYSQL_URL:-}" ]; then
  if node scripts/store-tiers.mjs "$REPORT" --verdicts "$VERDICTS" >> "$LOG" 2>&1; then log "tiers and health stored in MySQL"; else log "tiers store FAILED (continuing)"; fi
fi

log "slack start"
if node scripts/slack.mjs "$REPORT" --verdicts "$VERDICTS" --usage "$USAGE" >> "$LOG" 2>&1; then
  log "slack done"
else
  log "slack FAILED (see above)"; SLACK_FAILED=1
fi


[ -z "${SLACK_FAILED:-}" ] || exit 1
