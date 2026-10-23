const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const SECRET_PATH = path.join(DATA_DIR, 'session.secret');

function loadSecret() {
  try {
    const existing = fs.readFileSync(SECRET_PATH, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // create below
  }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_PATH, `${secret}\n`, { mode: 0o600 });
  return secret;
}

const SECRET = loadSecret();

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [algo, salt, hash] = String(stored || '').split('$');
    if (algo !== 'scrypt' || !salt || !hash) return false;
    const expected = Buffer.from(hash, 'hex');
    const actual = crypto.scryptSync(String(password), salt, expected.length);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
    const error = new Error('密码需为 12–128 位');
    error.status = 400;
    throw error;
  }
}

let passwordJobs = 0;
async function derivePassword(password, salt) {
  if (passwordJobs >= 4) {
    const error = new Error('密码服务繁忙，请稍后再试');
    error.status = 429;
    throw error;
  }
  passwordJobs += 1;
  try {
    return await new Promise((resolve, reject) => {
      crypto.scrypt(password, salt, 64, (error, value) => error ? reject(error) : resolve(value));
    });
  } finally {
    passwordJobs -= 1;
  }
}

async function hashPasswordAsync(password) {
  validatePassword(password);
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${(await derivePassword(password, salt)).toString('hex')}`;
}

async function verifyPasswordAsync(password, stored) {
  if (typeof password !== 'string' || password.length > 128) return false;
  const [algo, salt, hash] = String(stored || '').split('$');
  if (algo !== 'scrypt' || !/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{128}$/.test(hash)) return false;
  const actual = await derivePassword(password, salt);
  return crypto.timingSafeEqual(actual, Buffer.from(hash, 'hex'));
}


function secretKey(context = 'default') {
  return crypto.createHash('sha256').update(`${SECRET}:${context}`).digest();
}

function encryptText(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secretKey('secret-box'), iv);
  const encrypted = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

function decryptText(payload) {
  try {
    const [version, ivPart, tagPart, dataPart] = String(payload || '').split('.');
    if (version !== 'v1' || !ivPart || !tagPart || !dataPart) return '';
    const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey('secret-box'), Buffer.from(ivPart, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(dataPart, 'base64url')), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    return '';
  }
}

function hashCode(code) {
  return crypto.createHmac('sha256', SECRET).update(String(code)).digest('hex');
}

function signSession(userId, days = 7, version = 0) {
  const payload = { uid: Number(userId), ver: version, exp: Date.now() + days * 86400000 };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const [body, signature] = token.split('.');
  if (!body || !signature) return null;
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.uid || !payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
}

module.exports = {
  hashPassword,
  verifyPassword,
  hashPasswordAsync,
  verifyPasswordAsync,
  validatePassword,
  encryptText,
  decryptText,
  hashCode,
  signSession,
  verifySession,
  parseCookies,
};
