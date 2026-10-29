#!/usr/bin/env bash
# One-time setup on the server (Ubuntu 20.04+). Run from the cloned repo:  bash server/install.sh
# Assumes node >= 22, git, mysql client and the claude CLI (signed in) are already installed.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

echo "node $(node -v), claude $(claude --version 2>/dev/null || echo 'NOT FOUND')"
node -e 'const [m]=process.versions.node.split("."); if (+m<22) { console.error("node 22+ required"); process.exit(1) }'

npm install --omit=dev --no-audit --no-fund

if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  echo "created .env from .env.example: fill in REPO_READ_TOKEN, SLACK_WEBHOOK_URL and MYSQL_URL, then re-run"
  exit 0
fi
chmod 600 .env
set -a; . ./.env; set +a

if [ -n "${MYSQL_URL:-}" ]; then
  # mysql://user:pass@host:port/db
  node -e '
    const u = new URL(process.env.MYSQL_URL);
    const db = u.pathname.slice(1);
    console.log(`mysql -h ${u.hostname} -P ${u.port || 3306} -u ${decodeURIComponent(u.username)} -p${decodeURIComponent(u.password)} -e "CREATE DATABASE IF NOT EXISTS \\`${db}\\`" && mysql -h ${u.hostname} -P ${u.port || 3306} -u ${decodeURIComponent(u.username)} -p${decodeURIComponent(u.password)} ${db} < server/schema.sql`);
  ' | bash
  echo "MySQL schema applied"
fi

mkdir -p data/reports logs
chmod +x server/daily.sh

# cron reads the schedule in the server's own clock, so convert 08:00 Asia/Kolkata to server-local time.
LOCAL_HM="$(date -d "TZ=\"Asia/Kolkata\" 08:00" +%H:%M)"
CRON_H="${LOCAL_HM%%:*}"; CRON_M="${LOCAL_HM##*:}"
echo "08:00 Asia/Kolkata is $LOCAL_HM on this server's clock ($(date +%Z))"
CRON_LINE="$((10#$CRON_M)) $((10#$CRON_H)) * * * TZ=Asia/Kolkata $ROOT/server/daily.sh >> $ROOT/logs/cron.log 2>&1"
( crontab -l 2>/dev/null | grep -v 'security-radar\|server/daily.sh' ; echo "$CRON_LINE" ) | crontab -
echo "cron installed:"; crontab -l | grep daily.sh
echo
echo "Dry run now with:  TZ=Asia/Kolkata $ROOT/server/daily.sh"
