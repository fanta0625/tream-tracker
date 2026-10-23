const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const ExcelJS = require('exceljs');
const db = require('./db');
const auth = require('./auth');
const mailer = require('./mailer');
const { verifyPassword, hashCode } = require('./security');

const app = express();
const PORT = Number(process.env.PORT || 3100);
const TZ = process.env.TZ || 'Asia/Shanghai';

if (process.env.TRUST_PROXY === '1') app.set('trust proxy', true);

app.use(express.json({ limit: '1mb' }));

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function formatDateCn(date) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: TZ,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  }).format(new Date(`${date}T12:00:00+08:00`)).replace(/(周[一二三四五六日])$/, ' $1');
}

function formatDateTime(iso) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

function statusLabel(status) {
  return db.STATUS_LABELS[status] || status;
}

function priorityLabel(priority) {
  return { high: '高', medium: '中', low: '低' }[priority] || priority;
}

function mdEscape(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/([*_])/g, '\\$1')
    .replace(/\n/g, '\n  ');
}

function statusSummary(counts) {
  const order = ['doing', 'paused', 'blocked', 'done', 'todo'];
  return order
    .filter((key) => counts[key])
    .map((key) => `${statusLabel(key)} ${counts[key]}`)
    .join(' · ');
}

function ensureBlank(lines) {
  if (lines.length && lines[lines.length - 1] !== '') lines.push('');
}

function resolveRange(query) {
  const today = db.todayStr();
  if (query.date) {
    if (!db.isDate(query.date)) throw new HttpError(400, '日期格式应为 YYYY-MM-DD');
    return { from: query.date, to: query.date, single: true };
  }

  let from = query.from || today;
  let to = query.to || from;
  if (!db.isDate(from) || !db.isDate(to)) throw new HttpError(400, '日期格式应为 YYYY-MM-DD');
  if (from > to) [from, to] = [to, from];
  if (Math.abs(db.diffDays(from, to)) > 366) throw new HttpError(400, '导出范围不能超过 366 天');
  return { from, to, single: false };
}

function actorNote(actor, owner) {
  return actor && owner && actor !== owner ? `（更新人：${mdEscape(actor)}）` : '';
}

function buildMarkdown({ from, to, single }, memberId) {
  const memberFilter = memberId ? db.listMembers().find((m) => Number(m.id) === Number(memberId)) : null;
  const lines = [];

  if (single) {
    const day = db.getDay(from);
    const summaryParts = [`${day.summary.membersUpdated} 人更新`, `${day.summary.updates} 条记录`];
    if (statusSummary(day.summary.statusCounts)) summaryParts.push(statusSummary(day.summary.statusCounts));

    lines.push(`# 团队工作日报 · ${formatDateCn(from)}`, '');
    lines.push(`> ${summaryParts.join(' · ')}`, '');

    for (const member of day.members) {
      if (!member.updates.length) continue;
      lines.push(`## ${member.name}${member.role ? ` · ${member.role}` : ''}`, '');
      for (const update of member.updates) {
        lines.push(
          `- **${mdEscape(update.title)}**${update.project ? `（${mdEscape(update.project)}）` : ''} — ${statusLabel(update.status)} ${update.progress}%${actorNote(update.actor_name, member.name)}`
        );
        if (update.note) lines.push(`  - ${mdEscape(update.note)}`);
      }
      lines.push('');
    }

    const silent = day.members.filter((m) => m.updates.length === 0);
    if (silent.length) {
      lines.push('## 今日无更新', '');
      for (const member of silent) {
        lines.push(`- ${member.name}${member.role ? `（${member.role}）` : ''}：进行中/搁置/阻塞事项 ${member.active_count} 项`);
      }
      lines.push('');
    }
    return `${lines.join('\n').trim()}\n\n---\n由 Team Tracker 生成 · ${formatDateTime(new Date().toISOString())}\n`;
  }

  const rows = db.getExportRows(from, to, memberId);
  lines.push(`# 团队工作汇总 · ${from} ~ ${to}`, '');
  lines.push(`> 共 ${rows.length} 条更新${memberFilter ? ` · 成员：${memberFilter.name}` : ''}`, '');

  if (!rows.length) {
    lines.push('该时间段内没有更新记录。', '');
    return `${lines.join('\n').trim()}\n`;
  }

  let currentDate = null;
  let currentMember = null;
  for (const row of rows) {
    if (row.date !== currentDate) {
      ensureBlank(lines);
      lines.push(`## ${formatDateCn(row.date)}`, '');
      currentDate = row.date;
      currentMember = null;
    }
    if (row.member !== currentMember) {
      ensureBlank(lines);
      lines.push(`### ${row.member}${row.role ? ` · ${row.role}` : ''}`, '');
      currentMember = row.member;
    }
    lines.push(
      `- **${mdEscape(row.title)}**${row.project ? `（${mdEscape(row.project)}）` : ''} — ${statusLabel(row.status)} ${row.progress}%${actorNote(row.actor, row.member)}`
    );
    if (row.note) lines.push(`  - ${mdEscape(row.note)}`);
  }

  return `${lines.join('\n').trim()}\n\n---\n由 Team Tracker 生成 · ${formatDateTime(new Date().toISOString())}\n`;
}

function styleHeader(ws) {
  const row = ws.getRow(1);
  row.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
  row.alignment = { vertical: 'middle' };
  row.height = 24;
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
}

async function buildWorkbook({ from, to }, memberId) {
  const rows = db.getExportRows(from, to, memberId);
  const members = db.listMembers();
  const items = db.listItems(memberId ? { member_id: memberId } : {});
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Team Tracker';
  workbook.created = new Date();

  const updates = workbook.addWorksheet('工作更新');
  updates.columns = [
    { header: '日期', key: 'date', width: 12 },
    { header: '成员', key: 'member', width: 10 },
    { header: '角色', key: 'role', width: 10 },
    { header: '更新人', key: 'actor', width: 10 },
    { header: '事项', key: 'title', width: 30 },
    { header: '项目', key: 'project', width: 16 },
    { header: '状态', key: 'status', width: 10 },
    { header: '进度', key: 'progress', width: 8 },
    { header: '更新内容', key: 'note', width: 48 },
    { header: '记录时间', key: 'created_at', width: 20 },
  ];
  for (const row of rows) {
    updates.addRow({
      date: row.date,
      member: row.member,
      role: row.role,
      actor: row.actor,
      title: row.title,
      project: row.project,
      status: statusLabel(row.status),
      progress: row.progress,
      note: row.note,
      created_at: formatDateTime(row.created_at),
    });
  }
  updates.getColumn('progress').numFmt = '0"%"';
  updates.getColumn('note').alignment = { wrapText: true, vertical: 'top' };
  updates.getColumn('title').alignment = { wrapText: true, vertical: 'top' };
  styleHeader(updates);

  const overview = workbook.addWorksheet('事项总览');
  overview.columns = [
    { header: '负责人', key: 'member', width: 10 },
    { header: '角色', key: 'role', width: 10 },
    { header: '事项', key: 'title', width: 30 },
    { header: '项目', key: 'project', width: 16 },
    { header: '状态', key: 'status', width: 10 },
    { header: '进度', key: 'progress', width: 8 },
    { header: '优先级', key: 'priority', width: 8 },
    { header: '最近更新', key: 'last_update', width: 12 },
    { header: '距今天数', key: 'days', width: 10 },
    { header: '计划完成', key: 'due', width: 12 },
    { header: '更新次数', key: 'count', width: 10 },
    { header: '描述', key: 'description', width: 45 },
  ];
  for (const item of items) {
    overview.addRow({
      member: item.member_name,
      role: item.member_role,
      title: item.title,
      project: item.project,
      status: statusLabel(item.status),
      progress: item.progress,
      priority: priorityLabel(item.priority),
      last_update: item.last_update_date || '',
      days: item.days_since_update ?? '',
      due: item.due_date || '',
      count: item.update_count,
      description: item.description,
    });
  }
  overview.getColumn('progress').numFmt = '0"%"';
  overview.getColumn('description').alignment = { wrapText: true, vertical: 'top' };
  styleHeader(overview);

  const memberSheet = workbook.addWorksheet('成员');
  memberSheet.columns = [
    { header: '成员', key: 'name', width: 12 },
    { header: '角色', key: 'role', width: 12 },
    { header: '全部事项', key: 'item_count', width: 10 },
    { header: '活跃事项', key: 'active_count', width: 10 },
    { header: '更新记录', key: 'update_count', width: 10 },
  ];
  for (const member of members) {
    memberSheet.addRow({
      name: member.name,
      role: member.role,
      item_count: member.item_count,
      active_count: member.active_count,
      update_count: member.update_count,
    });
  }
  styleHeader(memberSheet);

  return { workbook, rows };
}


function visibilityLabel(visibility) {
  return { private: '仅自己', group: '同组可见', public: '所有登录用户' }[visibility] || visibility;
}

function reportTypeLabel(type) {
  return type === 'weekly' ? '周报' : '日报';
}

function reportDateLabel(report) {
  if (report.type !== 'weekly') return report.report_date;
  const start = db.normalizeWeekStart(report.report_date);
  return `${start} ~ ${db.addDays(start, 6)}`;
}

function buildReportsMarkdown(project, reports) {
  const lines = [`# ${mdEscape(project.name)} · 项目报告`, ''];
  lines.push(`> 组：${mdEscape(project.group_name)} · 共 ${reports.length} 份报告`, '');
  if (!reports.length) {
    lines.push('该时间范围内暂无报告。', '');
    return `${lines.join('\n').trim()}\n`;
  }
  for (const report of reports) {
    lines.push(`## ${reportDateLabel(report)} · ${reportTypeLabel(report.type)}`, '');
    lines.push(`### ${mdEscape(report.author_name)} · ${visibilityLabel(report.visibility)}`, '');
    const sections = [
      [report.type === 'weekly' ? '本周完成' : '今日完成', report.done],
      ['进行中', report.doing],
      ['问题 / 风险', report.blockers],
      [report.type === 'weekly' ? '下周计划' : '明日计划', report.next_plan],
    ];
    for (const [label, value] of sections) {
      if (!value) continue;
      lines.push(`**${label}**`, '', mdEscape(value), '');
    }
  }
  lines.push('---', `由 Team Tracker 生成 · ${formatDateTime(new Date().toISOString())}`, '');
  return `${lines.join('\n').trim()}\n`;
}

async function buildReportsWorkbook(project, reports) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Team Tracker';
  workbook.created = new Date();
  const sheet = workbook.addWorksheet('项目报告');
  sheet.columns = [
    { header: '日期 / 周期', key: 'date', width: 22 },
    { header: '类型', key: 'type', width: 8 },
    { header: '作者', key: 'author', width: 12 },
    { header: '可见性', key: 'visibility', width: 12 },
    { header: '完成内容', key: 'done', width: 36 },
    { header: '进行中', key: 'doing', width: 26 },
    { header: '问题 / 风险', key: 'blockers', width: 26 },
    { header: '下一步计划', key: 'next_plan', width: 30 },
    { header: '更新时间', key: 'updated_at', width: 20 },
  ];
  for (const report of reports) {
    sheet.addRow({
      date: reportDateLabel(report),
      type: reportTypeLabel(report.type),
      author: report.author_name,
      visibility: visibilityLabel(report.visibility),
      done: report.done,
      doing: report.doing,
      blockers: report.blockers,
      next_plan: report.next_plan,
      updated_at: formatDateTime(report.updated_at),
    });
  }
  for (const key of ['done', 'doing', 'blockers', 'next_plan']) {
    sheet.getColumn(key).alignment = { wrapText: true, vertical: 'top' };
  }
  styleHeader(sheet);

  const info = workbook.addWorksheet('项目信息');
  info.columns = [
    { header: '项目', key: 'name', width: 28 },
    { header: '组', key: 'group', width: 18 },
    { header: '描述', key: 'description', width: 50 },
    { header: '报告数', key: 'count', width: 10 },
  ];
  info.addRow({
    name: project.name,
    group: project.group_name,
    description: project.description,
    count: reports.length,
  });
  info.getColumn('description').alignment = { wrapText: true, vertical: 'top' };
  styleHeader(info);
  return workbook;
}

function canEdit(user, item) {
  return user.role === 'admin' || user.role === 'leader' || Number(item.member_id) === Number(user.member_id);
}

function itemWithAccess(id, user) {
  const item = db.getItemDetail(id);
  item.can_edit = canEdit(user, item);
  return item;
}

// ---------- public auth ----------

app.get('/api/health', (req, res) => {
  res.json({ status: 'UP', database: 'UP', time: new Date().toISOString() });
});

app.post('/api/auth/login', (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    const user = auth.login(username, password, req.ip);
    auth.setSessionCookie(res, user.id);
    res.json({ user: auth.publicUser(user) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/auth/logout', (req, res) => {
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const user = auth.getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: '请先登录' });
  res.json({ user: auth.publicUser(user) });
});


const codeRequestLog = new Map();

function checkCodeRateLimit(key) {
  const now = Date.now();
  const record = codeRequestLog.get(key) || { last: 0, windowStart: now, count: 0 };
  if (now - record.last < 60_000) {
    const err = new Error('请 60 秒后再获取验证码');
    err.status = 429;
    throw err;
  }
  if (now - record.windowStart > 3600_000) {
    record.windowStart = now;
    record.count = 0;
  }
  if (record.count >= 5) {
    const err = new Error('验证码请求过于频繁，请稍后再试');
    err.status = 429;
    throw err;
  }
  record.last = now;
  record.count += 1;
  codeRequestLog.set(key, record);
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

  checkCodeRateLimit(`${req.ip}|${email}`);
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
  if (password.length < 6) throw new HttpError(400, '密码至少 6 位');
  if (db.getUserByEmail(email)) throw new HttpError(409, '该邮箱已注册或正在审核');

  consumeEmailCode(email, 'register', code);

  const username = usernameFromEmail(email);
  const user = db.createUser({
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
  const user = db.getUserByEmail(email);
  if (!user) throw new HttpError(404, '该邮箱未注册');
  if (user.status !== 'active') throw new HttpError(403, '账号当前不可用，请联系管理员');

  checkCodeRateLimit(`${req.ip}|${email}|reset`);
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
  if (password.length < 6) throw new HttpError(400, '密码至少 6 位');

  const user = db.getUserByEmail(email);
  if (!user) throw new HttpError(404, '该邮箱未注册');
  if (user.status !== 'active') throw new HttpError(403, '账号当前不可用，请联系管理员');

  consumeEmailCode(email, 'reset_password', code);
  db.updateUser(user.id, { password });
  res.json({ ok: true, message: '密码已重置，请使用新密码登录' });
}));

// ---------- authenticated APIs ----------

app.use('/api', auth.requireAuth);


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
  res.status(201).json({ group: db.createGroup(req.body || {}) });
});

app.patch('/api/groups/:id', auth.requireAdmin, (req, res) => {
  res.json({ group: db.updateGroup(req.params.id, req.body || {}) });
});

app.post('/api/groups/:id/members', auth.requireAdmin, (req, res) => {
  const userIds = Array.isArray(req.body && req.body.user_ids) ? req.body.user_ids : [];
  res.json({ group: db.addGroupMembers(req.params.id, userIds) });
});

app.delete('/api/groups/:id/members/:userId', auth.requireAdmin, (req, res) => {
  res.json({ group: db.removeGroupMember(req.params.id, req.params.userId) });
});


app.get('/api/projects', (req, res) => {
  res.json({ projects: db.listProjects(req.user) });
});

app.post('/api/projects', (req, res) => {
  res.status(201).json({ project: db.createProject(req.body || {}, req.user) });
});

app.get('/api/projects/:id', (req, res) => {
  res.json({ project: db.getProject(req.params.id, req.user) });
});

app.patch('/api/projects/:id', (req, res) => {
  res.json({ project: db.updateProject(req.params.id, req.body || {}, req.user) });
});

app.delete('/api/projects/:id', (req, res) => {
  res.json(db.archiveProject(req.params.id, req.user));
});

app.get('/api/projects/:id/reports/export', handle(async (req, res) => {
  const format = req.query.format === 'xlsx' ? 'xlsx' : 'markdown';
  const { project, reports } = db.listReports(req.params.id, req.user, {
    type: req.query.type,
    from: req.query.from,
    to: req.query.to,
  });
  const suffix = `${req.query.from || 'all'}_${req.query.to || 'all'}`;
  if (format === 'xlsx') {
    const workbook = await buildReportsWorkbook(project, reports);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="project-${project.id}-reports-${suffix}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
    return;
  }
  const markdown = buildReportsMarkdown(project, reports);
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="project-${project.id}-reports-${suffix}.md"`);
  res.send(markdown);
}));

app.get('/api/projects/:id/reports', (req, res) => {
  res.json(db.listReports(req.params.id, req.user, {
    type: req.query.type,
    from: req.query.from,
    to: req.query.to,
  }));
});

app.post('/api/projects/:id/reports', (req, res) => {
  res.status(201).json({ report: db.createReport(req.params.id, req.body || {}, req.user) });
});

app.get('/api/reports/public', (req, res) => {
  res.json({
    reports: db.listPublicReports(req.user, {
      type: req.query.type,
      from: req.query.from,
      to: req.query.to,
    }),
  });
});

app.get('/api/reports/:id', (req, res) => {
  res.json({ report: db.getReport(req.params.id, req.user) });
});

app.patch('/api/reports/:id', (req, res) => {
  res.json({ report: db.updateReport(req.params.id, req.body || {}, req.user) });
});

app.delete('/api/reports/:id', (req, res) => {
  res.json(db.deleteReport(req.params.id, req.user));
});

app.post('/api/auth/password', (req, res) => {
  const { old_password, new_password } = req.body || {};
  if (!verifyPassword(old_password, req.user.password_hash)) {
    return res.status(400).json({ error: '原密码不正确' });
  }
  if (String(new_password || '').length < 6) {
    return res.status(400).json({ error: '新密码至少 6 位' });
  }
  db.updateUser(req.user.id, { password: new_password });
  res.json({ ok: true });
});

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

app.post('/api/users', auth.requireAdmin, (req, res) => {
  const user = db.createUser(req.body || {});
  res.status(201).json({ user });
});

app.patch('/api/users/:id', auth.requireAdmin, (req, res) => {
  const targetId = Number(req.params.id);
  const body = req.body || {};
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
    && ((body.role && body.role !== 'admin') || body.status === 'disabled' || body.status === 'pending' || body.active === 0);
  if (removingAdmin && db.countActiveAdmins(targetId) === 0) {
    return res.status(400).json({ error: '至少需要保留一个启用的管理员' });
  }

  const user = db.updateUser(targetId, body);
  res.json({ user });
});

app.get('/api/items', (req, res) => {
  const items = db.listItems(req.query || {}).map((item) => ({ ...item, can_edit: canEdit(req.user, item) }));
  res.json({ items });
});

app.get('/api/items/:id', (req, res) => {
  res.json({ item: itemWithAccess(req.params.id, req.user) });
});

app.post('/api/items', (req, res) => {
  const item = db.createItem(req.body || {}, req.user);
  item.can_edit = true;
  res.status(201).json({ item });
});

app.patch('/api/items/:id', (req, res) => {
  const existing = db.getItemDetail(req.params.id);
  if (!canEdit(req.user, existing)) return res.status(403).json({ error: '你没有权限修改该事项' });
  if (req.body && req.body.member_id !== undefined && !auth.isLeader(req.user)) {
    return res.status(403).json({ error: '只有组长或管理员可以转移负责人' });
  }
  const item = db.updateItemMeta(req.params.id, req.body || {}, req.user);
  item.can_edit = true;
  res.json({ item });
});

app.post('/api/items/:id/updates', (req, res) => {
  const existing = db.getItemDetail(req.params.id);
  if (!canEdit(req.user, existing)) return res.status(403).json({ error: '你没有权限更新该事项' });
  const item = db.addUpdate(req.params.id, req.body || {}, req.user);
  item.can_edit = true;
  res.status(201).json({ item });
});

app.delete('/api/items/:id', (req, res) => {
  const existing = db.getItemDetail(req.params.id);
  if (!canEdit(req.user, existing)) return res.status(403).json({ error: '你没有权限归档该事项' });
  res.json(db.archiveItem(req.params.id, req.user));
});

app.get('/api/day', (req, res) => {
  const date = req.query.date || db.todayStr();
  if (!db.isDate(date)) throw new HttpError(400, '日期格式应为 YYYY-MM-DD');
  res.json(db.getDay(date));
});


app.get('/api/summary', (req, res) => {
  const today = db.todayStr();
  let from = req.query.from || db.addDays(today, -6);
  let to = req.query.to || today;
  if (!db.isDate(from) || !db.isDate(to)) throw new HttpError(400, '日期格式应为 YYYY-MM-DD');
  if (from > to) [from, to] = [to, from];
  if (Math.abs(db.diffDays(from, to)) > 366) throw new HttpError(400, '汇总范围不能超过 366 天');
  const memberId = req.query.member_id ? Number(req.query.member_id) : null;
  res.json(db.getSummary(from, to, memberId));
});

app.get('/api/export/markdown', handle(async (req, res) => {
  const range = resolveRange(req.query);
  const memberId = req.query.member_id ? Number(req.query.member_id) : null;
  const markdown = buildMarkdown(range, memberId);
  const filename = range.single
    ? `team-daily-${range.from}.md`
    : `team-report-${range.from}_${range.to}.md`;
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(markdown);
}));

app.get('/api/export/xlsx', handle(async (req, res) => {
  const range = resolveRange(req.query);
  const memberId = req.query.member_id ? Number(req.query.member_id) : null;
  const { workbook } = await buildWorkbook(range, memberId);
  const filename = range.single
    ? `team-daily-${range.from}.xlsx`
    : `team-report-${range.from}_${range.to}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await workbook.xlsx.write(res);
  res.end();
}));

app.use('/api', (req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

// ---------- pages ----------

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
  if (req.path === '/' && !auth.getUserFromRequest(req)) return res.redirect('/login');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  if (!auth.getUserFromRequest(req)) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || '服务器错误' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Team Tracker 运行在 http://0.0.0.0:${PORT}`);
  console.log(`数据库: ${db.DB_PATH}`);
});
