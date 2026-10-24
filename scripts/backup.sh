#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
node scripts/backup.js
