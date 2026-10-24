const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const db = require('./db');
const auth = require('./auth');
const mailer = require('./mailer');
const { verifyPasswordAsync, validatePassword, hashCode } = require('./security');
const { RateLimiter } = require('./rate-limit');
const { configureNetwork } = require('./network-security');

const app = express();
const { port: PORT } = require('./config');

app.use(require('./lib/observability').requests);
const HOST = configureNetwork(app);
app.use(express.json({ limit: '1mb' }));
app.use('/api', require('./lib/validation').validateRequest);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const handle = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch(next);

const { resolveRange, buildMarkdown, buildWorkbook, buildReportsMarkdown, buildReportsWorkbook } = require('./services/exports');

function canEdit(user, item) {
  return db.canEditItem(user, item);
}

function itemWithAccess(id, user) {
  const item = db.getItemDetail(id, user);
  item.can_edit = canEdit(user, item);
  return item;
}

// ---------- public auth ----------

app.get('/api/health', (req, res) => {
  res.json({ status: db.health() ? 'UP' : 'DOWN', database: 'UP', time: new Date().toISOString() });
});

app.post('/api/auth/login', handle(async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    const user = await auth.login(username, password, req.ip);
    auth.setSessionCookie(res, user.id);
    res.json({ user: auth.publicUser(user) });
  } catch (err) {
    next(err);
  }
}));

app.post('/api/auth/logout', (req, res) => {
  const user = auth.getUserFromRequest(req);
  if (user) db.revokeSessions(user.id);
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const user = auth.getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: '请先登录' });
  res.json({ user: auth.publicUser(user) });
});


const codeRequests = new RateLimiter();
const passwordChanges = new RateLimiter();
function checkCodeRateLimit(ip, email) {
  codeRequests.consume('global', 100, 3600000);
  codeRequests.consume(`ip:${ip}`, 10, 3600000);
  codeRequests.consume(`email:${email}:hour`, 5, 3600000);
  codeRequests.consume(`email:${email}:minute`, 1, 60000);
}

function usernameFromEmail(email) {
  let base = String(email).split('@')[0].toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 24);
  if (base.length < 3) base = 'user';
  let candidate = base;
  let suffix = 2;
  while (db.getUserByUsername(candidate)) {
    candidate = `${base}${suffix}`;
    suffix += 1;
  }
  return candidate;
}


function consumeEmailCode(email, purpose, code) {
  const record = db.getLatestEmailCode(email, purpose);
  if (!record) throw new HttpError(400, '请先获取验证码');
  if (Number(record.attempts) >= 5) throw new HttpError(400, '验证码尝试次数过多，请重新获取');
  if (Number(record.expires_at) < Date.now()) throw new HttpError(400, '验证码已过期，请重新获取');
  db.incrementEmailCodeAttempts(record.id);
  if (hashCode(code) !== record.code_hash) throw new HttpError(400, '验证码不正确');
  db.markEmailCodeUsed(record.id);
  return record;
}

app.post('/api/auth/register/send-code', handle(async (req, res) => {
  const email = db.normalizeEmail(req.body && req.body.email);
  if (!db.isValidEmail(email)) throw new HttpError(400, '邮箱格式不正确');
  if (db.getUserByEmail(email)) throw new HttpError(409, '该邮箱已注册或正在审核');
  if (!mailer.isConfigured()) throw new HttpError(503, '管理员尚未配置邮件服务，暂时无法自助注册');

  checkCodeRateLimit(req.ip, email);
  const code = String(crypto.randomInt(100000, 1000000));
  db.createEmailCode(email, 'register', hashCode(code), Date.now() + 10 * 60 * 1000);
  await mailer.sendVerificationCode(email, code);
  res.json({ ok: true, message: '验证码已发送，请检查邮箱（包括垃圾邮件）' });
}));

app.post('/api/auth/register', handle(async (req, res) => {
  const body = req.body || {};
  const email = db.normalizeEmail(body.email);
  const code = String(body.code || '').trim();
  const password = String(body.password || '');
  const displayName = String(body.display_name || '').trim();

  if (!db.isValidEmail(email)) throw new HttpError(400, '邮箱格式不正确');
  if (!/^\d{6}$/.test(code)) throw new HttpError(400, '验证码应为 6 位数字');
  validatePassword(password);
  if (db.getUserByEmail(email)) throw new HttpError(409, '该邮箱已注册或正在审核');

  consumeEmailCode(email, 'register', code);

  const username = usernameFromEmail(email);
  const user = await db.createUser({
    username,
    email,
    password,
    display_name: displayName || username,
    role: 'member',
    status: 'pending',
  });

  res.status(201).json({
    pending: true,
    message: '注册成功，等待管理员审核',
    user: { id: user.id, email: user.email, display_name: user.display_name, status: user.status },
  });
}));


app.post('/api/auth/forgot/send-code', handle(async (req, res) => {
  const email = db.normalizeEmail(req.body && req.body.email);
  if (!db.isValidEmail(email)) throw new HttpError(400, '邮箱格式不正确');
  if (!mailer.isConfigured()) throw new HttpError(503, '管理员尚未配置邮件服务，暂时无法找回密码');
  checkCodeRateLimit(req.ip, email);
  const user = db.getUserByEmail(email);
  if (!user || user.status !== 'active') return res.json({ ok: true, message: '如果该邮箱关联可用账号，验证码将发送至邮箱' });
  const code = String(crypto.randomInt(100000, 1000000));
  db.createEmailCode(email, 'reset_password', hashCode(code), Date.now() + 10 * 60 * 1000);
  await mailer.sendPasswordResetCode(email, code);
  res.json({ ok: true, message: '验证码已发送，请检查邮箱（包括垃圾邮件）' });
}));

app.post('/api/auth/forgot/reset', handle(async (req, res) => {
  const body = req.body || {};
  const email = db.normalizeEmail(body.email);
  const code = String(body.code || '').trim();
  const password = String(body.password || '');

  if (!db.isValidEmail(email)) throw new HttpError(400, '邮箱格式不正确');
  if (!/^\d{6}$/.test(code)) throw new HttpError(400, '验证码应为 6 位数字');
  validatePassword(password);

  const user = db.getUserByEmail(email);
  if (!user) throw new HttpError(404, '该邮箱未注册');
  if (user.status !== 'active') throw new HttpError(403, '账号当前不可用，请联系管理员');

  consumeEmailCode(email, 'reset_password', code);
  await db.updateUser(user.id, { password }, { passwordVerified: true, expectedVersion: user.session_version });
  res.json({ ok: true, message: '密码已重置，请使用新密码登录' });
}));

// ---------- authenticated APIs ----------

app.use('/api', auth.requireAuth);


require('./routes/operations')(app, { db, auth });

app.get('/api/admin/mail', auth.requireAdmin, (req, res) => {
  res.json({ config: mailer.publicConfig() });
});

app.put('/api/admin/mail', auth.requireAdmin, (req, res) => {
  res.json({ config: mailer.saveMailConfig(req.body || {}) });
});

app.post('/api/admin/mail/test', auth.requireAdmin, handle(async (req, res) => {
  const to = db.normalizeEmail((req.body && req.body.to) || req.user.email);
  if (!db.isValidEmail(to)) throw new HttpError(400, '请填写有效的收件邮箱');
  await mailer.sendTest(to);
  res.json({ ok: true, message: `测试邮件已发送到 ${to}` });
}));

app.get('/api/admin/registrations', auth.requireAdmin, (req, res) => {
  res.json({ users: db.listPendingUsers() });
});

app.post('/api/admin/registrations/:id/approve', auth.requireAdmin, handle(async (req, res) => {
  const groupIds = Array.isArray(req.body && req.body.group_ids) ? req.body.group_ids : [];
  const user = db.approveUser(req.params.id, groupIds);
  if (user.email) {
    mailer.sendApproved(user.email, user.display_name).catch((err) => {
      console.error('[mail] 审核通过通知发送失败:', err.message);
    });
  }
  res.json({ user });
}));

app.post('/api/admin/registrations/:id/reject', auth.requireAdmin, (req, res) => {
  const user = db.rejectUser(req.params.id);
  res.json({ user });
});

app.get('/api/groups', (req, res) => {
  res.json({ groups: db.listGroups(req.user) });
});

app.post('/api/groups', auth.requireAdmin, (req, res) => {
  res.status(201).json({ group: db.createGroup(req.body || {}, req.user) });
});

app.patch('/api/groups/:id', auth.requireAdmin, (req, res) => {
  res.json({ group: db.updateGroup(req.params.id, req.body || {}, req.user) });
});

app.post('/api/groups/:id/members', auth.requireAdmin, (req, res) => {
  const userIds = Array.isArray(req.body && req.body.user_ids) ? req.body.user_ids : [];
  res.json({ group: db.addGroupMembers(req.params.id, userIds, req.user) });
});

app.delete('/api/groups/:id/members/:userId', auth.requireAdmin, (req, res) => {
  res.json({ group: db.removeGroupMember(req.params.id, req.params.userId, req.user) });
});


require('./routes/projects')(app, { db, auth, handle, HttpError, canEdit, itemWithAccess, resolveRange, buildMarkdown, buildWorkbook, buildReportsMarkdown, buildReportsWorkbook });

app.post('/api/auth/password', handle(async (req, res) => {
  const { old_password, new_password } = req.body || {};
  passwordChanges.consume(`user:${req.user.id}`, 5, 600000);
  if (!await verifyPasswordAsync(old_password, req.user.password_hash)) {
    return res.status(400).json({ error: '原密码不正确' });
  }
  validatePassword(new_password);
  if (new_password === old_password) throw new HttpError(400, '新密码不能与原密码相同');
  await db.updateUser(req.user.id, { password: new_password }, { passwordVerified: true, expectedVersion: req.user.session_version });
  auth.setSessionCookie(res, req.user.id);
  res.json({ ok: true });
}));

app.get('/api/members', (req, res) => {
  res.json({ members: db.listMembers() });
});

app.post('/api/members', auth.requireAdmin, (req, res) => {
  const member = db.createMember(req.body || {});
  res.status(201).json({ member });
});

app.get('/api/users', auth.requireAdmin, (req, res) => {
  res.json({ users: db.listUsers() });
});

app.post('/api/users', auth.requireAdmin, handle(async (req, res) => {
  const user = await db.createUser(req.body || {}, { actor: req.user });
  res.status(201).json({ user });
}));

app.patch('/api/users/:id', auth.requireAdmin, handle(async (req, res) => {
  const targetId = Number(req.params.id);
  const body = req.body || {};
  if (body.active !== undefined && body.status === undefined) body.status = body.active ? 'active' : 'disabled';
  const target = db.getUserById(targetId);
  if (!target) return res.status(404).json({ error: '用户不存在' });

  if (targetId === req.user.id) {
    if (body.active === 0 || (body.status && body.status !== 'active')) {
      return res.status(400).json({ error: '不能停用当前登录账号' });
    }
    if (body.role && body.role !== 'admin') {
      return res.status(400).json({ error: '不能修改自己的管理员角色' });
    }
  }

  const removingAdmin = target.role === 'admin'
    && ((body.role && body.role !== 'admin') || (body.status && body.status !== 'active') || body.active === 0);
  if (removingAdmin && db.countActiveAdmins(targetId) === 0) {
    return res.status(400).json({ error: '至少需要保留一个启用的管理员' });
  }

  const user = await db.updateUser(targetId, body, { actor: req.user });
  res.json({ user });
}));

require('./routes/items')(app, { db, auth, handle, HttpError, canEdit, itemWithAccess, resolveRange, buildMarkdown, buildWorkbook, buildReportsMarkdown, buildReportsWorkbook });

app.use('/api', (req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

// ---------- pages ----------

app.get('/change-password', (req, res) => {
  if (!auth.getUserFromRequest(req)) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'change-password.html'));
});

app.get('/login', (req, res) => {
  if (auth.getUserFromRequest(req)) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/register', (req, res) => {
  if (auth.getUserFromRequest(req)) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

app.get('/forgot', (req, res) => {
  if (auth.getUserFromRequest(req)) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'forgot.html'));
});

app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/index.html') {
    const user = auth.getUserFromRequest(req);
    if (!user) return res.redirect('/login');
    if (user.must_change_password) return res.redirect('/change-password');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  const user = auth.getUserFromRequest(req);
  if (!user) return res.redirect('/login');
  if (user.must_change_password) return res.redirect('/change-password');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  if (status === 429) res.setHeader('Retry-After', '60');
  res.status(status).json({ error: status >= 500 ? '服务器错误，请稍后再试' : (err.message || '请求失败') });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`Team Tracker 运行在 http://${HOST}:${server.address().port}`);
  console.log(`数据库: ${db.DB_PATH}`);
});

server.requestTimeout = 30000;
server.headersTimeout = 10000;
server.maxRequestsPerSocket = 100;

for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  server.close(() => { db.close(); process.exit(0); });
  server.closeIdleConnections();
  setTimeout(() => process.exit(1), 10000).unref();
});
