const { defineConfig } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dataDir = process.env.E2E_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-browser-'));
process.env.E2E_DATA_DIR = dataDir;
const port = Number(process.env.E2E_PORT || 3219);
module.exports = defineConfig({
  testDir: './tests/browser', workers: 1, timeout: 60000,
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'retain-on-failure', ...(process.env.E2E_BROWSER_CHANNEL ? { channel: process.env.E2E_BROWSER_CHANNEL } : {}) },
  webServer: {
    command: 'node tests/browser/server.js', url: `http://127.0.0.1:${port}/api/health`, reuseExistingServer: false,
    env: { DATA_DIR: dataDir, HOST: '127.0.0.1', PORT: String(port), COOKIE_SECURE: '0', SEED_DEMO: '0', TRUST_PROXY: '', TRUSTED_PROXIES: '', PUBLIC_ORIGIN: '' },
  },
});
