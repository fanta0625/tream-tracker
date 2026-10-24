const db = require('./db');
const { signSession, verifySession, parseCookies, verifyPasswordAsync } = require('./security');

const COOKIE_NAME = 'tt_session';
const SESSION_DAYS = 7;
const { RateLimiter } = require('./rate-limit');
const loginAttempts = new RateLimiter();

function publicUser(user) {
  if (!user) return null;
  const { password_hash, session_version, ...rest } = user;
  return rest;
}

function getUserFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  const payload = verifySession(cookies[COOKIE_NAME]);
  if (!payload) return null;
  const user = db.getUserById(payload.uid);
  if (!user || user.status !== 'active' || payload.ver !== user.session_version) return null;
  return user;
}

function cookieOptions() {
  return `Path=/; HttpOnly; SameSite=Lax${process.env.COOKIE_SECURE !== '0' ? '; Secure' : ''}`;
}

function setSessionCookie(res, userId) {
  const user = db.getUserById(userId);
  const token = signSession(userId, SESSION_DAYS, user.session_version);
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(token)}; ${cookieOptions()}; Max-Age=${SESSION_DAYS * 86400}`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; ${cookieOptions()}; Max-Age=0`);
}

async function login(username, password, ip) {
  if (typeof username !== 'string' || username.length > 254 || typeof password !== 'string' || !password || password.length > 128) {
    const err = new Error('用户名或密码格式不正确');
    err.status = 400;
    throw err;
  }
  const cleanUsername = username.trim();
  loginAttempts.consume('global', 300, 60000);
  loginAttempts.consume(`ip:${ip}`, 30, 600000);
  const user = db.getUserByLogin(cleanUsername);
  // Username and email aliases share the same account budget.
  loginAttempts.consume(`account:${user ? user.id : cleanUsername.toLowerCase()}`, 10, 600000);
  const valid = user && user.status === 'active' && await verifyPasswordAsync(password, user.password_hash);
  const current = user && db.getUserById(user.id);
  if (!valid || !current || current.status !== 'active' || current.session_version !== user.session_version) {
    const err = new Error('用户名或密码错误，或账号尚未启用');
    err.status = 401;
    throw err;
  }
  db.touchLogin(user.id);
  loginAttempts.refund(`account:${user.id}`);
  loginAttempts.refund(`ip:${ip}`);
  return current;
}

function requireAuth(req, res, next) {
  const user = getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: '请先登录' });
  req.user = user;
  if (user.must_change_password && req.path !== '/auth/password') {
    return res.status(403).json({ error: '请先修改初始密码', code: 'PASSWORD_CHANGE_REQUIRED' });
  }
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
