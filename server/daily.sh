#!/usr/bin/env bash
# Security Radar, daily run on the server. Installed by server/install.sh, started by cron.
#
#   1. scan        node watch.mjs            -> report.json (+ state.json, packages.json caches)
#   2. keep        copy report.json          -> data/reports/YYYY-MM-DD.json (one file per day, never overwritten)
#   3. store       node scripts/store.mjs    -> MySQL (scans, findings, advisories) for history queries
#   4. narrate     claude -p server/narrative.prompt.md -> a short paragraph for the summary message (optional)
#   5. tell        node scripts/slack.mjs    -> Slack via the webhook: summary, one table per project, clear list
#
# Each step logs to logs/YYYY-MM-DD.log. A failed scan stops the run (there is nothing to tell);
# a failed store does not (the messages still go out; the day's file is on disk to load later).

set -uo pipefail
cd "$(dirname "$0")/.."

set -a; . ./.env; set +a
# cron starts with a bare PATH: make node and claude reachable wherever they were installed.
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"
export TZ="${TZ:-Asia/Kolkata}"
DAY="$(date +%F)"
mkdir -p data/reports logs
LOG="logs/$DAY.log"
log() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$LOG"; }

log "scan start"
if ! node watch.mjs >> "$LOG" 2>&1; then
  log "scan FAILED (see above); nothing sent"
  exit 1
fi
cp -f report.json "data/reports/$DAY.json"
log "report kept as data/reports/$DAY.json"

if [ -n "${MYSQL_URL:-}" ]; then
  if node scripts/store.mjs "data/reports/$DAY.json" >> "$LOG" 2>&1; then log "stored in MySQL"; else log "store FAILED (continuing)"; fi
else
  log "MYSQL_URL not set, history store skipped"
fi

NARRATIVE="data/narrative-$DAY.txt"
log "narrative start"
if claude -p "$(cat server/narrative.prompt.md)" --allowedTools "Bash,Read" --output-format text > "$NARRATIVE" 2>> "$LOG"; then
  log "narrative done ($(wc -c < "$NARRATIVE") bytes)"
else
  log "narrative FAILED (continuing without it)"; : > "$NARRATIVE"
fi

log "slack start"
if node scripts/slack.mjs "data/reports/$DAY.json" --narrative-file "$NARRATIVE" >> "$LOG" 2>&1; then
  log "slack done"
else
  log "slack FAILED (see above)"; exit 1
fi
