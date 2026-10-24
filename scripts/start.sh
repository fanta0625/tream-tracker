#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
mkdir -p logs data backups
chmod 700 data logs backups 2>/dev/null || true
chmod 600 data/tracker.db* data/session.secret 2>/dev/null || true
if [ -f server.pid ] && kill -0 "$(cat server.pid)" 2>/dev/null; then
  echo "team-tracker 已在运行 (PID $(cat server.pid))"
else
  # Foreground only: initial credentials must not enter logs/server.log.
  node scripts/initialize.js
  nohup node src/server.js >> logs/server.log 2>&1 &
  echo $! > server.pid
  echo "team-tracker 已启动 (PID $(cat server.pid))"
fi
sleep 2
curl -fsS "http://127.0.0.1:${PORT:-3100}/api/health" && echo
