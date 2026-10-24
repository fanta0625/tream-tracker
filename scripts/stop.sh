#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f server.pid ] && kill -0 "$(cat server.pid)" 2>/dev/null; then
  kill "$(cat server.pid)"
  rm -f server.pid
  echo "team-tracker 已停止"
else
  echo "team-tracker 未运行"
fi
