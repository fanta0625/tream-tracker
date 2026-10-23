// Explicit local HTTP development mode. Production remains HTTPS-only.
const { spawnSync, spawn } = require('node:child_process');
const env = { ...process.env, HOST: '127.0.0.1', COOKIE_SECURE: '0' };
const init = spawnSync(process.execPath, ['initialize.js'], { cwd: __dirname, env, stdio: 'inherit' });
if (init.status !== 0) process.exit(init.status || 1);
const child = spawn(process.execPath, ['--watch', 'server.js'], { cwd: __dirname, env, stdio: 'inherit' });
child.on('exit', code => process.exit(code || 0));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
