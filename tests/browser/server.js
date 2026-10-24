const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const init = spawnSync(process.execPath, ['scripts/initialize.js'], { encoding: 'utf8', env: process.env });
if (init.status !== 0) throw new Error(init.stderr);
const password = init.stdout.match(/管理员临时密码：([^\r\n]+)/)[1];
fs.writeFileSync(path.join(process.env.DATA_DIR, 'test-password'), password, { mode: 0o600 });
require('../../src/server');
