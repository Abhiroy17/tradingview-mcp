#!/usr/bin/env bash
#
# Pull-based self-deploy for the Oracle Cloud instance.
#
# Runs from cron on the server. Checks origin/master for new commits and, only
# when there is a change, pulls, installs backend deps, rebuilds the UI, and
# restarts the pm2 process. This decouples deploys from inbound SSH (GitHub
# Actions runners intermittently cannot complete the TCP handshake to this
# small instance), which was the recurring "dial tcp :22 i/o timeout" failure.
#
# Setup (once, on the server):
#   chmod +x ~/tradingview-mcp/scripts/server-deploy.sh
#   ( crontab -l 2>/dev/null; echo "*/2 * * * * flock -n /tmp/tvmcp-deploy.lock $HOME/tradingview-mcp/scripts/server-deploy.sh >> $HOME/deploy.log 2>&1" ) | crontab -
#
set -euo pipefail

APP_DIR="$HOME/tradingview-mcp"
LOG="$HOME/deploy.log"
PM2_NAME="munafasutra"

cd "$APP_DIR"

git fetch origin master --quiet
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/master)

if [ "$LOCAL" = "$REMOTE" ]; then
  exit 0
fi

echo "==== $(date -u '+%Y-%m-%dT%H:%M:%SZ') deploying $REMOTE ===="

git pull origin master --quiet

echo "-- installing backend deps"
NODE_OPTIONS=--max-old-space-size=512 npm ci --omit=dev --no-audit --no-fund

echo "-- building UI"
( cd ui && npm ci --no-audit --no-fund && NODE_OPTIONS=--max-old-space-size=1024 npm run build )

echo "-- restarting $PM2_NAME"
pm2 restart "$PM2_NAME" --update-env
pm2 save

echo "==== $(date -u '+%Y-%m-%dT%H:%M:%SZ') deploy complete ===="
