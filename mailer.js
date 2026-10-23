const nodemailer = require('nodemailer');
const db = require('./db');
const { encryptText, decryptText } = require('./security');

const DEFAULTS = {
  port: 465,
  secure: 'ssl',
  fromName: 'Team Tracker',
};

function envConfig() {
  return {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || DEFAULTS.port),
    secure: process.env.SMTP_SECURE || (Number(process.env.SMTP_PORT) === 587 ? 'starttls' : DEFAULTS.secure),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    fromEmail: process.env.SMTP_FROM || process.env.SMTP_USER || '',
    fromName: process.env.SMTP_FROM_NAME || DEFAULTS.fromName,
    source: 'env',
  };
}

function getMailConfig() {
  const dbHost = db.getSetting('smtp_host', '');
  const useDb = Boolean(dbHost);
  if (!useDb) return envConfig();

  const storedPass = db.getSetting('smtp_pass_enc', '');
  return {
    host: dbHost,
    port: Number(db.getSetting('smtp_port', DEFAULTS.port)),
    secure: db.getSetting('smtp_secure', DEFAULTS.secure),
    user: db.getSetting('smtp_user', ''),
    pass: storedPass ? decryptText(storedPass) : '',
    fromEmail: db.getSetting('smtp_from_email', ''),
    fromName: db.getSetting('smtp_from_name', DEFAULTS.fromName),
    source: 'database',
  };
}

function isConfigured(config = getMailConfig()) {
  return Boolean(config.host && config.port && config.fromEmail);
}

function publicConfig() {
  const config = getMailConfig();
  return {
    host: config.host,
    port: config.port,
    secure: config.secure,
    user: config.user,
    fromEmail: config.fromEmail,
    fromName: config.fromName,
    hasPassword: Boolean(config.pass),
    source: config.source,
    configured: isConfigured(config),
  };
}

function saveMailConfig(body = {}) {
  const host = String(body.host || '').trim();
  const port = Number(body.port || DEFAULTS.port);
  const secure = ['ssl', 'starttls', 'none'].includes(body.secure) ? body.secure : DEFAULTS.secure;
  const user = String(body.user || '').trim();
  const fromEmail = String(body.from_email || '').trim();
  const fromName = String(body.from_name || '').trim() || DEFAULTS.fromName;

  if (!host) {
    const err = new Error('SMTP Host 不能为空');
    err.status = 400;
    throw err;
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    const err = new Error('SMTP 端口不正确');
    err.status = 400;
    throw err;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromEmail)) {
    const err = new Error('发件邮箱格式不正确');
    err.status = 400;
    throw err;
  }

  db.setSetting('smtp_host', host);
  db.setSetting('smtp_port', String(port));
  db.setSetting('smtp_secure', secure);
  db.setSetting('smtp_user', user);
  db.setSetting('smtp_from_email', fromEmail);
  db.setSetting('smtp_from_name', fromName);

  if (body.clear_password) {
    db.setSetting('smtp_pass_enc', '');
  } else if (body.password !== undefined && String(body.password).length > 0) {
    db.setSetting('smtp_pass_enc', encryptText(String(body.password)));
  } else if (!db.getSetting('smtp_pass_enc', '')) {
    const env = envConfig();
    if (env.pass) db.setSetting('smtp_pass_enc', encryptText(env.pass));
  }

  return publicConfig();
}

function createTransport(config = getMailConfig()) {
  if (!isConfigured(config)) {
    const err = new Error('管理员尚未配置邮件服务');
    err.status = 503;
    throw err;
  }
  const options = {
    host: config.host,
    port: config.port,
    secure: config.secure === 'ssl',
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  };
  if (config.secure === 'starttls') options.requireTLS = true;
  if (config.user || config.pass) {
    options.auth = { user: config.user, pass: config.pass };
  }
  return nodemailer.createTransport(options);
}

async function sendMail({ to, subject, text, html }) {
  const config = getMailConfig();
  const transporter = createTransport(config);
  try {
    return await transporter.sendMail({
      from: { name: config.fromName, address: config.fromEmail },
      to,
      subject,
      text,
      html,
    });
  } catch (err) {
    const error = new Error(`邮件发送失败：${err.message}`);
    error.status = 502;
    throw error;
  }
}

async function sendVerificationCode(email, code) {
  const subject = 'Team Tracker 注册验证码';
  const text = [
    '你正在注册 Team Tracker。',
    '',
    `验证码：${code}`,
    '',
    '验证码 10 分钟内有效。如果这不是你本人的操作，请忽略这封邮件。',
  ].join('\n');
  const html = `
    <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;line-height:1.6;color:#1f2330">
      <h2 style="margin:0 0 12px">Team Tracker 注册验证码</h2>
      <p>你正在注册 Team Tracker，验证码是：</p>
      <p style="font-size:30px;font-weight:800;letter-spacing:6px;color:#4f46e5;margin:16px 0">${code}</p>
      <p>验证码 10 分钟内有效。如果这不是你本人的操作，请忽略这封邮件。</p>
    </div>`;
  return sendMail({ to: email, subject, text, html });
}

async function sendApproved(email, name) {
  if (!email) return null;
  const subject = 'Team Tracker 账号审核通过';
  const text = [
    `${name || '你好'}，你的 Team Tracker 账号已通过管理员审核。`,
    '',
    '现在可以登录系统。登录后如果还没有分组，请联系管理员分配。',
  ].join('\n');
  const html = text
    .replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]))
    .replace(/\n/g, '<br>');
  return sendMail({ to: email, subject, text, html: `<p>${html}</p>` });
}

async function sendTest(to) {
  return sendMail({
    to,
    subject: 'Team Tracker 邮件配置测试',
    text: '这是一封测试邮件。收到它说明 SMTP 配置可用。',
    html: '<p>这是一封测试邮件。收到它说明 SMTP 配置可用。</p>',
  });
}

module.exports = {
  getMailConfig,
  publicConfig,
  saveMailConfig,
  isConfigured,
  sendMail,
  sendVerificationCode,
  sendApproved,
  sendTest,
};
