#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p backups logs
chmod 700 backups logs 2>/dev/null || true
STAMP=$(date +%Y%m%d-%H%M%S)
TARGET="backups/tracker-${STAMP}.db"
node - "$TARGET" <<'NODE'
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const target = process.argv[2];
const db = new DatabaseSync(path.join('data', 'tracker.db'));
db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
db.close();
NODE
chmod 600 "$TARGET"
find backups -name 'tracker-*.db' -type f -mtime +14 -delete
echo "backup: $TARGET"
