const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { once } = require('node:events');
const { RateLimiter } = require('../rate-limit');
const root = path.resolve(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-tracker-tests-'));
const env = { ...process.env, DATA_DIR: dataDir, HOST: '127.0.0.1', PORT: '0', COOKIE_SECURE: '0', SEED_DEMO: '0', TRUST_PROXY: '', TRUSTED_PROXIES: '', PUBLIC_ORIGIN: '' };

function initialize(overrides = {}) {
  return spawnSync(process.execPath, ['initialize.js'], { cwd: root, env: { ...env, ...overrides }, encoding: 'utf8' });
}

async function serve(t, overrides = {}) {
  // SMTP is stubbed in the child; these tests never deliver real mail.
  const boot = "const mail=require('./mailer'); mail.isConfigured=()=>true; mail.sendVerificationCode=async()=>{}; mail.sendPasswordResetCode=async()=>{}; mail.sendApproved=async()=>{}; require('./server');";
  const child = spawn(process.execPath, ['-e', boot], { cwd: root, env: { ...env, ...overrides }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  let errors = '';
  child.stderr.on('data', data => { errors += data; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
  });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timed out')), 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Server exited: ${errors}`)); });
    child.stdout.on('data', data => {
      logs += data;
      const match = logs.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
  });
  return async function request(route, { method = 'GET', body, cookie, headers = {} } = {}) {
    const response = await fetch(url + route, {
      method, redirect: 'manual', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    let json;
    try { json = JSON.parse(buffer.toString()); } catch { /* HTML / export */ }
    return { status: response.status, headers: response.headers, cookie: response.headers.get('set-cookie')?.split(';')[0], json, buffer };
  };
}

test('security and application regression', async t => {
  const init = initialize();
  assert.equal(init.status, 0, init.stderr);
  const initialPassword = init.stdout.match(/管理员临时密码：([^\r\n]+)/)?.[1];
  assert(initialPassword && initialPassword.length >= 24);
  assert.equal(initialize().stdout, '', 'restart must not print or reset credentials');
  process.env.DATA_DIR = dataDir;
  process.env.SEED_DEMO = '0';
  const db = require('../db');
  const security = require('../security');
  const auth = require('../auth');
  const request = await serve(t);
  const password = 'Regression-password-2026';
  let adminCookie;

  await t.test('initial admin must change password before any protected API or export', async () => {
    assert.equal((await request('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } })).status, 401);
    const login = await request('/api/auth/login', { method: 'POST', body: { username: 'admin', password: initialPassword } });
    assert.equal(login.status, 200);
    assert.equal(login.json.user.must_change_password, 1);
    for (const route of ['/api/members', '/api/users', '/api/export/xlsx', '/api/projects']) {
      const result = await request(route, { cookie: login.cookie });
      assert.equal(result.status, 403);
      assert.equal(result.json.code, 'PASSWORD_CHANGE_REQUIRED');
    }
    assert.equal((await request('/', { cookie: login.cookie })).headers.get('location'), '/change-password');
    assert.equal((await request('/change-password', { cookie: login.cookie })).status, 200);
    const unchanged = await request('/api/auth/password', { method: 'POST', cookie: login.cookie, body: { old_password: initialPassword, new_password: initialPassword } });
    assert.equal(unchanged.status, 400);
    const change = await request('/api/auth/password', { method: 'POST', cookie: login.cookie, body: { old_password: initialPassword, new_password: password } });
    assert.equal(change.status, 200);
    adminCookie = change.cookie;
    assert.equal((await request('/api/members', { cookie: adminCookie })).status, 200);
    assert.equal((await request('/api/auth/me', { cookie: login.cookie })).status, 401);
    assert.equal(db.getUserByUsername('admin').must_change_password, 0);
  });

  await t.test('HTTP origin checks, CSP and admin self-disable guard', async () => {
    assert.equal((await request('/api/auth/logout', { method: 'POST', cookie: adminCookie, headers: { Origin: 'https://attacker.invalid' } })).status, 403);
    assert.equal((await request('/api/auth/me', { cookie: adminCookie })).status, 200);
    assert.equal((await request('/api/users/1', { method: 'PATCH', cookie: adminCookie, body: { active: false } })).status, 400);
    const page = await request('/');
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  });

  let alice, bob, project, group, publicReport;
  const admin = db.getUserByUsername('admin');
  await t.test('create members, promote/revoke leaders, preserve leadership in other groups', async () => {
    const create = async username => db.createUser({ username, password, member_id: db.createMember({ name: username }).id });
    alice = await create('alice'); bob = await create('bob');
    group = db.createGroup({ name: 'Review', leader_user_id: alice.id });
    const other = db.createGroup({ name: 'Other', leader_user_id: alice.id });
    db.updateGroup(group.id, { leader_user_id: bob.id });
    assert.equal(db.getUserById(alice.id).role, 'leader');
    db.removeGroupMember(other.id, alice.id);
    alice = db.getUserById(alice.id);
    assert.equal(alice.role, 'member');
    assert.equal(auth.isLeader(alice), false);
    db.updateGroup(group.id, { leader_user_id: null });
    bob = db.getUserById(bob.id);
    assert.equal(bob.role, 'member');
    db.removeGroupMember(group.id, bob.id);
    project = db.createProject({ group_id: group.id, name: 'Private project', description: 'CONFIDENTIAL_PROJECT_DESCRIPTION' }, admin);
  });

  await t.test('report visibility matrix and author access after leaving a group', async () => {
    publicReport = db.createReport(project.id, { report_date: '2026-10-24', visibility: 'public', done: 'Public text' }, alice);
    assert.equal(db.getReport(publicReport.id, bob).done, 'Public text');
    assert.equal(db.getReport(publicReport.id, bob).project.description, undefined);
    const privateReport = db.createReport(project.id, { report_date: '2026-10-23', visibility: 'private', done: 'Secret' }, alice);
    const groupReport = db.createReport(project.id, { report_date: '2026-10-22', visibility: 'group' }, alice);
    assert.throws(() => db.getReport(privateReport.id, bob), error => error.status === 403);
    assert.throws(() => db.getReport(groupReport.id, bob), error => error.status === 403);
    db.addGroupMembers(group.id, [bob.id]);
    assert.equal(db.getReport(groupReport.id, bob).id, groupReport.id);
    assert.throws(() => db.getReport(privateReport.id, bob), error => error.status === 403);
    db.removeGroupMember(group.id, alice.id);
    assert.equal(db.getReport(privateReport.id, alice).done, 'Secret');
    assert.equal(db.updateReport(privateReport.id, { done: 'Updated' }, alice).done, 'Updated');
    db.addGroupMembers(group.id, [alice.id]);
  });

  await t.test('transfer updates use current owner while preserving historical attribution', () => {
    const item = db.createItem({ member_id: alice.member_id, title: 'Transfer', update_date: '2026-10-24' }, admin);
    db.updateItemMeta(item.id, { member_id: bob.member_id }, admin);
    const updateId = item.timeline[0].id;
    assert.equal(db.getWorkUpdate(updateId, alice).can_edit, false);
    assert.equal(db.getWorkUpdate(updateId, bob).can_edit, true);
    assert.throws(() => db.updateWorkUpdate(updateId, { note: 'unauthorized' }, alice), error => error.status === 403);
    assert.equal(db.updateWorkUpdate(updateId, { note: 'Owner edit' }, bob).update.note, 'Owner edit');
    assert.equal(db.getWorkUpdate(updateId, admin).update.member_id, alice.member_id);
  });

  await t.test('Markdown member filter and Excel exports including report export', async () => {
    db.createItem({ member_id: alice.member_id, title: 'Alice-only-task', update_date: '2026-10-24' }, admin);
    db.createItem({ member_id: bob.member_id, title: 'Bob-only-task', update_date: '2026-10-24' }, admin);
    const md = await request(`/api/export/markdown?date=2026-10-24&member_id=${bob.member_id}`, { cookie: adminCookie });
    assert.match(md.buffer.toString(), /Bob-only-task/);
    assert.doesNotMatch(md.buffer.toString(), /Alice-only-task/);
    const ExcelJS = require('exceljs');
    for (const route of ['/api/export/xlsx?date=2026-10-24', `/api/projects/${project.id}/reports/export?format=xlsx`]) {
      const result = await request(route, { cookie: adminCookie });
      assert.equal(result.status, 200);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(result.buffer);
      assert(workbook.worksheets[0].rowCount > 1);
    }
  });

  await t.test('admin reset, verified email reset and logout revoke old sessions', async () => {
    const login = await request('/api/auth/login', { method: 'POST', body: { username: 'bob', password } });
    assert.equal(login.status, 200);
    const reset = await request(`/api/users/${bob.id}`, { method: 'PATCH', cookie: adminCookie, body: { password: 'New-password-2026', email: 'bob@example.invalid' } });
    assert.equal(reset.status, 200);
    assert.equal((await request('/api/auth/me', { cookie: login.cookie })).status, 401);
    const temporary = await request('/api/auth/login', { method: 'POST', body: { username: 'bob', password: 'New-password-2026' } });
    assert.equal(temporary.json.user.must_change_password, 1);
    db.createEmailCode('bob@example.invalid', 'reset_password', security.hashCode('123456'), Date.now() + 60000);
    const emailReset = await request('/api/auth/forgot/reset', { method: 'POST', body: { email: 'bob@example.invalid', code: '123456', password } });
    assert.equal(emailReset.status, 200);
    assert.equal((await request('/api/auth/me', { cookie: temporary.cookie })).status, 401);
    const finalLogin = await request('/api/auth/login', { method: 'POST', body: { username: 'bob', password } });
    assert.equal(finalLogin.json.user.must_change_password, 0);
    await request('/api/auth/logout', { method: 'POST', cookie: finalLogin.cookie });
    assert.equal((await request('/api/auth/me', { cookie: finalLogin.cookie })).status, 401);
  });

  await t.test('public report HTTP endpoint works for outsiders without granting project access', async () => {
    db.removeGroupMember(group.id, bob.id);
    const login = await request('/api/auth/login', { method: 'POST', body: { username: 'bob', password } });
    assert.equal((await request(`/api/reports/${publicReport.id}`, { cookie: login.cookie })).status, 200);
    assert.equal((await request(`/api/projects/${project.id}`, { cookie: login.cookie })).status, 403);
  });

  await t.test('registration requires valid single-use code and preserves pending approval', async () => {
    const email = 'new-user@example.invalid';
    db.createEmailCode(email, 'register', security.hashCode('654321'), Date.now() + 60000);
    assert.equal((await request('/api/auth/register', { method: 'POST', body: { email, code: '654320', password } })).status, 400);
    const result = await request('/api/auth/register', { method: 'POST', body: { email, code: '654321', password } });
    assert.equal(result.status, 201);
    assert.equal(result.json.user.status, 'pending');
    assert.equal((await request('/api/auth/login', { method: 'POST', body: { username: email, password } })).status, 401);
    assert.equal((await request(`/api/admin/registrations/${result.json.user.id}/approve`, { method: 'POST', cookie: adminCookie, body: {} })).status, 200);
    // This server stubs approval notices as well as verification messages.
    assert.equal((await request('/api/auth/login', { method: 'POST', body: { username: email, password } })).status, 200);
  });

  await t.test('mail IP quota cannot be bypassed by changing recipients or forwarded headers', async () => {
    for (let i = 0; i < 10; i++) {
      assert.equal((await request('/api/auth/register/send-code', { method: 'POST', body: { email: `mail${i}@example.invalid` }, headers: { 'X-Forwarded-For': `192.0.2.${i}` } })).status, 200);
    }
    assert.equal((await request('/api/auth/register/send-code', { method: 'POST', body: { email: 'mail10@example.invalid' } })).status, 429);
  });

  await t.test('global account limiter survives IP changes and shares username/email budget', async () => {
    for (let i = 0; i < 10; i++) {
      await assert.rejects(auth.login(i % 2 ? 'bob@example.invalid' : 'bob', 'wrong', `192.0.2.${i}`), error => error.status === 401);
    }
    await assert.rejects(auth.login('bob', password, '192.0.2.200'), error => error.status === 429);
  });

  await t.test('async password operations cap concurrency and do not block event loop', async () => {
    const hash = db.getUserByUsername('admin').password_hash;
    const jobs = Array.from({ length: 6 }, () => security.verifyPasswordAsync(password, hash));
    const completion = Promise.allSettled(jobs);
    await new Promise(resolve => setImmediate(resolve));
    const results = await completion;
    assert(results.some(result => result.status === 'rejected' && result.reason.status === 429));
    assert(results.filter(result => result.status === 'fulfilled').every(result => result.value));
  });

  await t.test('revocation during async hashing prevents stale admin mutations', async () => {
    const actor = db.getUserByUsername('admin');
    const pending = db.updateUser(bob.id, { password: 'Should-not-be-saved' }, { actor });
    const rejected = assert.rejects(pending, error => error.status === 401);
    db.revokeSessions(actor.id);
    await rejected;
    assert(await security.verifyPasswordAsync(password, db.getUserById(bob.id).password_hash));
  });
});

test('bounded limiter expires entries and fails closed at capacity', () => {
  let now = 100000;
  const limiter = new RateLimiter({ maxEntries: 2, now: () => now });
  limiter.consume('a', 1, 100);
  limiter.consume('b', 1, 100);
  assert.throws(() => limiter.consume('c', 1, 100), error => error.status === 429);
  assert.throws(() => limiter.consume('a', 1, 100), error => error.status === 429);
  now += 60001;
  limiter.consume('c', 1, 100);
  assert.equal(limiter.entries.size, 1);
});

test('production transport rejects spoofed proxy headers; trusted HTTPS sets Secure cookie', async t => {
  const direct = await serve(t, { COOKIE_SECURE: '1', TRUSTED_PROXIES: '192.0.2.10' });
  assert.equal((await direct('/login', { headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '127.0.0.1' } })).status, 400);
  const proxied = await serve(t, { COOKIE_SECURE: '1', TRUSTED_PROXIES: '127.0.0.1' });
  assert.equal((await proxied('/login')).status, 400);
  const login = await proxied('/api/auth/login', { method: 'POST', headers: { 'X-Forwarded-Proto': 'https' }, body: { username: 'admin', password: 'Regression-password-2026' } });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /; Secure/);
  assert(login.headers.get('strict-transport-security'));
});

test('legacy migration preserves disabled accounts and restart never seeds demo data', () => {
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-tracker-legacy-'));
  const legacy = new DatabaseSync(path.join(legacyDir, 'tracker.db'));
  legacy.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT UNIQUE, password_hash TEXT, display_name TEXT, role TEXT, member_id INTEGER, active INTEGER, created_at TEXT, last_login_at TEXT); INSERT INTO users VALUES (1, 'disabled', 'unused', 'Disabled', 'admin', NULL, 0, '2026-01-01', NULL);");
  legacy.close();
  const init = initialize({ DATA_DIR: legacyDir });
  assert.equal(init.status, 0, init.stderr);
  const migrated = new DatabaseSync(path.join(legacyDir, 'tracker.db'));
  assert.equal(migrated.prepare('SELECT status FROM users WHERE id=1').get().status, 'disabled');
  migrated.close();
  const cleanDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-tracker-empty-'));
  assert.equal(initialize({ DATA_DIR: cleanDir }).status, 0);
  assert.equal(initialize({ DATA_DIR: cleanDir, SEED_DEMO: '1' }).status, 0);
  const clean = new DatabaseSync(path.join(cleanDir, 'tracker.db'));
  assert.equal(clean.prepare('SELECT COUNT(*) AS count FROM members').get().count, 0);
  assert.equal(clean.prepare('SELECT COUNT(*) AS count FROM items').get().count, 0);
  clean.close();
});

test('upgrade rotates known admin credentials and disables known demo credentials once', () => {
  const security = require('../security');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-tracker-credentials-'));
  assert.equal(initialize({ DATA_DIR: dir, SEED_DEMO: '1' }).status, 0);
  const database = new DatabaseSync(path.join(dir, 'tracker.db'));
  database.prepare("DELETE FROM settings WHERE key = 'security_hardening_v1'").run();
  database.prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE username = 'admin'").run(security.hashPassword('admin123'));
  database.prepare("UPDATE users SET password_hash = ?, status = 'active', active = 1 WHERE username = 'zhangsan'").run(security.hashPassword('123456'));
  const upgraded = initialize({ DATA_DIR: dir });
  assert.equal(upgraded.status, 0, upgraded.stderr);
  const temporary = upgraded.stdout.match(/管理员临时密码：([^\r\n]+)/)?.[1];
  assert(temporary);
  const admin = database.prepare("SELECT * FROM users WHERE username = 'admin'").get();
  assert(security.verifyPassword(temporary, admin.password_hash));
  assert.equal(admin.must_change_password, 1);
  assert.equal(database.prepare("SELECT status FROM users WHERE username = 'zhangsan'").get().status, 'disabled');
  assert.equal(initialize({ DATA_DIR: dir }).stdout, '');
  database.close();
});
