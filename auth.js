const db = require('./db');
const { signSession, verifySession, parseCookies, verifyPassword } = require('./security');

const COOKIE_NAME = 'tt_session';
const SESSION_DAYS = 7;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;

const loginAttempts = new Map();

function publicUser(user) {
  if (!user) return null;
  const { password_hash, ...rest } = user;
  return rest;
}

function getUserFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  const payload = verifySession(cookies[COOKIE_NAME]);
  if (!payload) return null;
  const user = db.getUserById(payload.uid);
  if (!user || user.status !== 'active') return null;
  return user;
}

function cookieOptions() {
  return `Path=/; HttpOnly; SameSite=Lax${process.env.COOKIE_SECURE === '1' ? '; Secure' : ''}`;
}

function setSessionCookie(res, userId) {
  const token = signSession(userId, SESSION_DAYS);
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(token)}; ${cookieOptions()}; Max-Age=${SESSION_DAYS * 86400}`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; ${cookieOptions()}; Max-Age=0`);
}

function login(username, password, ip) {
  const cleanUsername = String(username || '').trim();
  if (!cleanUsername || !password) {
    const err = new Error('请输入用户名和密码');
    err.status = 400;
    throw err;
  }

  const key = `${ip || 'unknown'}|${cleanUsername.toLowerCase()}`;
  const now = Date.now();
  const record = loginAttempts.get(key);
  if (record && record.reset > now && record.count >= LOGIN_MAX_ATTEMPTS) {
    const err = new Error('尝试次数过多，请 10 分钟后再试');
    err.status = 429;
    throw err;
  }

  const user = db.getUserByLogin(cleanUsername);
  if (user && user.status === 'pending') {
    const err = new Error('账号等待管理员审核');
    err.status = 403;
    throw err;
  }
  if (user && user.status === 'rejected') {
    const err = new Error('注册申请未通过审核');
    err.status = 403;
    throw err;
  }
  if (user && user.status === 'disabled') {
    const err = new Error('账号已停用');
    err.status = 403;
    throw err;
  }
  const valid = user && user.status === 'active' && verifyPassword(password, user.password_hash);
  if (!valid) {
    const next = record && record.reset > now ? record : { count: 0, reset: now + LOGIN_WINDOW_MS };
    next.count += 1;
    loginAttempts.set(key, next);
    const err = new Error('用户名或密码错误');
    err.status = 401;
    throw err;
  }

  loginAttempts.delete(key);
  db.touchLogin(user.id);
  return user;
}

function requireAuth(req, res, next) {
  const user = getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: '请先登录' });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: '需要管理员权限' });
  }
  next();
}

function isAdmin(user) {
  return user && user.role === 'admin';
}

function isLeader(user) {
  return user && (user.role === 'admin' || user.role === 'leader');
}

module.exports = {
  COOKIE_NAME,
  publicUser,
  getUserFromRequest,
  setSessionCookie,
  clearSessionCookie,
  login,
  requireAuth,
  requireAdmin,
  isAdmin,
  isLeader,
  isManager: isLeader,
};
