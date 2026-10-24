const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword, hashPasswordAsync, validatePassword, verifyPassword } = require('./security');
const crypto = require('node:crypto');

const { dataDir: DATA_DIR, timezone: TZ } = require('./config');
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'tracker.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');


const STATUSES = ['todo', 'doing', 'paused', 'blocked', 'done'];
const PRIORITIES = ['high', 'medium', 'low'];

const STATUS_LABELS = {
  todo: '待开始',
  doing: '进行中',
  paused: '已搁置',
  blocked: '被阻塞',
  done: '已完成',
};

function todayStr() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function isDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const [y, m, d] = String(value).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

function diffDays(from, to) {
  if (!from || !to) return null;
  const [y1, m1, d1] = from.split('-').map(Number);
  const [y2, m2, d2] = to.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

function nowIso() {
  return new Date().toISOString();
}

function atLocal(date, time) {
  return new Date(`${date}T${time}:00+08:00`).toISOString();
}

function all(sql, params = []) {
  return db.prepare(sql).all(...params);
}

function get(sql, params = []) {
  return db.prepare(sql).get(...params);
}

function run(sql, params = []) {
  return db.prepare(sql).run(...params);
}

function tx(fn) {
  const savepoint = `tx_${crypto.randomBytes(6).toString('hex')}`;
  db.exec(`SAVEPOINT ${savepoint}`);
  try {
    const result = fn();
    db.exec(`RELEASE ${savepoint}`);
    return result;
  } catch (err) {
    try { db.exec(`ROLLBACK TO ${savepoint}`); db.exec(`RELEASE ${savepoint}`); } catch { /* ignore */ }
    throw err;
  }
}

function clampProgress(value, fallback = 0) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 100) throw problem(400, '进度必须是 0–100 的整数');
  return n;
}

function validStatus(value, fallback = 'todo') {
  if (value === undefined || value === '') return fallback;
  if (!STATUSES.includes(value)) throw problem(400, '不合法的字段值');
  return value;
}

function validPriority(value, fallback = 'medium') {
  if (value === undefined || value === '') return fallback;
  if (!PRIORITIES.includes(value)) throw problem(400, '不合法的字段值');
  return value;
}

require('./lib/migrations')(db);
const { validReportType, validVisibility, normalizeWeekStart, canViewProject, canManageProject, canReportProject, projectAccess, projectSelectSql, listProjects, getProject, createProject, archiveProject, listReports, getReport, listPublicReports, updateProject, createReport, updateReport, deleteReport, REPORT_TYPES, VISIBILITIES } = require('./services/projects')({ all, get, run, tx, nowIso, isDate, addDays, getGroup, isGroupMember, isGroupLeader, problem, checkVersion, assertProjectWritable, audit });

const { listItems, canEditItem, canEditUpdate, getWorkUpdate, recalcItemState, getItemDetail, addUpdateRow, createItem, getDay, getSummary, getExportRows, updateWorkUpdate, deleteWorkUpdate, addUpdate, updateItemMeta, archiveItem } = require('./services/items')({ all, get, run, tx, nowIso, isDate, todayStr, diffDays, listMembers, getProject, canViewProject, isGroupLeader, assertProjectWritable, clampProgress, validStatus, validPriority, STATUSES, problem, checkVersion, audit });

function listMembers() {
  return all(`
    SELECT m.*,
      (SELECT COUNT(*) FROM items i WHERE i.member_id = m.id AND i.archived = 0) AS item_count,
      (SELECT COUNT(*) FROM items i WHERE i.member_id = m.id AND i.archived = 0
        AND i.status IN ('doing', 'paused', 'blocked')) AS active_count,
      (SELECT COUNT(*) FROM updates u WHERE u.member_id = m.id) AS update_count
    FROM members m
    ORDER BY m.id
  `).map((row) => ({ ...row, item_count: Number(row.item_count), active_count: Number(row.active_count), update_count: Number(row.update_count) }));
}

function createMember({ name, role }) {
  const cleanName = String(name || '').trim();
  if (!cleanName) {
    const err = new Error('成员姓名不能为空');
    err.status = 400;
    throw err;
  }
  try {
    const result = run(
      'INSERT INTO members (name, role, created_at) VALUES (?, ?, ?)',
      [cleanName, String(role || '').trim(), nowIso()]
    );
    return get('SELECT * FROM members WHERE id = ?', [Number(result.lastInsertRowid)]);
  } catch (err) {
    if (String(err.message || '').includes('UNIQUE')) {
      const conflict = new Error(`成员「${cleanName}」已存在`);
      conflict.status = 409;
      throw conflict;
    }
    throw err;
  }
}

function sanitizeUser(row) {
  if (!row) return null;
  const { password_hash, ...rest } = row;
  return rest;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function attachUserGroups(user) {
  if (!user) return null;
  user.group_ids = all('SELECT group_id FROM user_groups WHERE user_id = ? ORDER BY group_id', [user.id]).map((row) => row.group_id);
  user.groups = all(`
    SELECT g.id, g.name
    FROM groups g
    JOIN user_groups ug ON ug.group_id = g.id
    WHERE ug.user_id = ?
    ORDER BY g.name
  `, [user.id]);
  user.led_group_ids = all('SELECT id FROM groups WHERE leader_user_id = ? ORDER BY id', [user.id]).map((row) => row.id);
  user.led_groups = all('SELECT id, name FROM groups WHERE leader_user_id = ? ORDER BY name', [user.id]);
  return user;
}

function getUserById(id) {
  return attachUserGroups(get(`
    SELECT u.*, m.name AS member_name
    FROM users u
    LEFT JOIN members m ON m.id = u.member_id
    WHERE u.id = ?
  `, [Number(id)]));
}

function getUserByLogin(login) {
  return attachUserGroups(get(`
    SELECT u.*, m.name AS member_name
    FROM users u
    LEFT JOIN members m ON m.id = u.member_id
    WHERE u.username = ? OR u.email = ?
    LIMIT 1
  `, [String(login || '').trim(), normalizeEmail(login)]));
}

function getUserByUsername(username) {
  return getUserByLogin(username);
}

function getUserByEmail(email) {
  return attachUserGroups(get(`
    SELECT u.*, m.name AS member_name
    FROM users u
    LEFT JOIN members m ON m.id = u.member_id
    WHERE u.email = ?
    LIMIT 1
  `, [normalizeEmail(email)]));
}

function listUsers() {
  return all(`
    SELECT u.*, m.name AS member_name
    FROM users u
    LEFT JOIN members m ON m.id = u.member_id
    ORDER BY u.id
  `).map((row) => sanitizeUser(attachUserGroups(row)));
}

function listPendingUsers() {
  return all(`
    SELECT u.*, m.name AS member_name
    FROM users u
    LEFT JOIN members m ON m.id = u.member_id
    WHERE u.status = 'pending'
    ORDER BY u.created_at
  `).map((row) => sanitizeUser(attachUserGroups(row)));
}

function validateMemberLink(memberId, excludeUserId = 0) {
  if (!memberId) return null;
  const member = get('SELECT id FROM members WHERE id = ?', [memberId]);
  if (!member) {
    const err = new Error('关联成员不存在');
    err.status = 400;
    throw err;
  }
  const existing = get('SELECT id FROM users WHERE member_id = ? AND id != ?', [memberId, excludeUserId]);
  if (existing) {
    const err = new Error('该成员已经绑定其他账号');
    err.status = 409;
    throw err;
  }
  return memberId;
}

function assertAdminActor(actor) {
  if (!actor) return;
  const current = getUserById(actor.id);
  if (!current || current.status !== 'active' || current.role !== 'admin'
      || current.must_change_password || current.session_version !== actor.session_version) {
    const err = new Error('管理员会话已失效，请重新登录');
    err.status = 401;
    throw err;
  }
}

async function createUser(body = {}, options = {}) {
  const username = String(body.username || '').trim();
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
    const err = new Error('用户名需为 3-32 位字母、数字、下划线、点或横线');
    err.status = 400;
    throw err;
  }
  const password = String(body.password || '');
  validatePassword(password);
  const role = ['admin', 'leader', 'member'].includes(body.role) ? body.role : 'member';
  const status = ['pending', 'active', 'disabled', 'rejected'].includes(body.status) ? body.status : 'active';
  const memberId = body.member_id ? Number(body.member_id) : null;
  if (role === 'member' && status === 'active' && !memberId) {
    const err = new Error('启用的成员账号必须关联一个成员');
    err.status = 400;
    throw err;
  }
  validateMemberLink(memberId);

  const email = normalizeEmail(body.email);
  if (email && !isValidEmail(email)) {
    const err = new Error('邮箱格式不正确');
    err.status = 400;
    throw err;
  }
  if (email && get('SELECT id FROM users WHERE email = ?', [email])) {
    const err = new Error('邮箱已被注册');
    err.status = 409;
    throw err;
  }

  const displayName = String(body.display_name || '').trim() || username;
  const passwordHash = await hashPasswordAsync(password);
  assertAdminActor(options.actor);
  try {
    const result = run(`
      INSERT INTO users (username, email, password_hash, display_name, role, member_id, active, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      username,
      email || null,
      passwordHash,
      displayName,
      role,
      memberId,
      status === 'active' ? 1 : 0,
      status,
      nowIso(),
    ]);
    return sanitizeUser(getUserById(Number(result.lastInsertRowid)));
  } catch (err) {
    if (String(err.message || '').includes('UNIQUE')) {
      const conflict = new Error('用户名或邮箱已存在');
      conflict.status = 409;
      throw conflict;
    }
    throw err;
  }
}

async function updateUser(id, body = {}, options = {}) {
  const passwordHash = body.password !== undefined ? await hashPasswordAsync(body.password) : null;
  assertAdminActor(options.actor);
  const userId = Number(id);
  const current = getUserById(userId);
  if (!current) {
    const err = new Error('用户不存在');
    err.status = 404;
    throw err;
  }

  const fields = [];
  const params = [];
  const add = (column, value) => {
    fields.push(`${column} = ?`);
    params.push(value);
  };

  if (body.display_name !== undefined) add('display_name', String(body.display_name || '').trim() || current.username);

  if (body.email !== undefined) {
    const email = normalizeEmail(body.email);
    if (email && !isValidEmail(email)) {
      const err = new Error('邮箱格式不正确');
      err.status = 400;
      throw err;
    }
    if (email && get('SELECT id FROM users WHERE email = ? AND id != ?', [email, userId])) {
      const err = new Error('邮箱已被其他账号使用');
      err.status = 409;
      throw err;
    }
    add('email', email || null);
  }

  if (body.role !== undefined) {
    if (!['admin', 'leader', 'member'].includes(body.role)) {
      const err = new Error('角色不合法');
      err.status = 400;
      throw err;
    }
    add('role', body.role);
  }
  if (body.member_id !== undefined) {
    const memberId = body.member_id ? Number(body.member_id) : null;
    validateMemberLink(memberId, userId);
    add('member_id', memberId);
  }

  let nextStatus = body.status;
  if (nextStatus === undefined && body.active !== undefined) nextStatus = body.active ? 'active' : 'disabled';
  if (nextStatus !== undefined) {
    if (!['pending', 'active', 'disabled', 'rejected'].includes(nextStatus)) {
      const err = new Error('账号状态不合法');
      err.status = 400;
      throw err;
    }
    add('status', nextStatus);
    add('active', nextStatus === 'active' ? 1 : 0);
  }

  const effectiveRole = body.role !== undefined ? body.role : current.role;
  const effectiveStatus = nextStatus !== undefined ? nextStatus : current.status;
  const effectiveMemberId = body.member_id !== undefined
    ? (body.member_id ? Number(body.member_id) : null)
    : current.member_id;
  if (current.role === 'admin' && current.status === 'active'
      && (effectiveRole !== 'admin' || effectiveStatus !== 'active') && countActiveAdmins(userId) === 0) {
    const err = new Error('至少需要保留一个启用的管理员');
    err.status = 400;
    throw err;
  }
  if (effectiveStatus === 'active' && effectiveRole === 'member' && !effectiveMemberId) {
    const err = new Error('启用的成员账号必须关联一个成员，请使用审核通过或先关联成员');
    err.status = 400;
    throw err;
  }

  if (options.expectedVersion !== undefined && current.session_version !== options.expectedVersion) {
    const err = new Error('会话已失效，请重新登录');
    err.status = 401;
    throw err;
  }
  if (passwordHash) {
    add('password_hash', passwordHash);
    add('must_change_password', options.passwordVerified ? 0 : 1);
  }
  if (passwordHash || nextStatus !== undefined || body.role !== undefined || body.email !== undefined) {
    add('session_version', current.session_version + 1);
  }
  if (!fields.length) return sanitizeUser(current);
  tx(() => {
    if (body.role !== undefined && body.role !== 'leader' && body.role !== 'admin') {
      run('UPDATE groups SET leader_user_id = NULL WHERE leader_user_id = ?', [userId]);
    }

    run(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, [...params, userId]);
    audit(options.actor || { id: userId }, 'updateUser', 'users', userId, current, getUserById(userId));
  });
  return sanitizeUser(getUserById(userId));
}

function ensureMemberForUser(user) {
  if (user.member_id) return Number(user.member_id);
  const base = String(user.display_name || user.username || '成员').trim() || '成员';
  let name = base;
  let suffix = 2;
  while (get('SELECT id FROM members WHERE name = ?', [name])) {
    name = `${base} ${suffix}`;
    suffix += 1;
  }
  const result = run('INSERT INTO members (name, role, created_at) VALUES (?, ?, ?)', [name, '', nowIso()]);
  const memberId = Number(result.lastInsertRowid);
  run('UPDATE users SET member_id = ? WHERE id = ?', [memberId, user.id]);
  return memberId;
}

function approveUser(id, groupIds = []) {
  const userId = Number(id);
  const user = getUserById(userId);
  if (!user) {
    const err = new Error('用户不存在');
    err.status = 404;
    throw err;
  }
  if (user.status !== 'pending') {
    const err = new Error('该账号不在待审核状态');
    err.status = 400;
    throw err;
  }

  tx(() => {
    ensureMemberForUser(user);
    run("UPDATE users SET status = 'active', active = 1 WHERE id = ?", [userId]);
    if (Array.isArray(groupIds) && groupIds.length) {
      setUserGroups(userId, groupIds);
    }
  });

  return sanitizeUser(getUserById(userId));
}

function rejectUser(id) {
  const userId = Number(id);
  const user = getUserById(userId);
  if (!user) {
    const err = new Error('用户不存在');
    err.status = 404;
    throw err;
  }
  run("UPDATE users SET status = 'rejected', active = 0 WHERE id = ?", [userId]);
  return sanitizeUser(getUserById(userId));
}

function groupMembers(groupId) {
  return all(`
    SELECT u.id, u.username, u.email, u.display_name, u.role, u.status, u.member_id
    FROM users u
    JOIN user_groups ug ON ug.user_id = u.id
    WHERE ug.group_id = ?
    ORDER BY u.display_name, u.id
  `, [Number(groupId)]);
}

function getGroup(id) {
  const group = get(`
    SELECT g.*, u.display_name AS leader_name,
      (SELECT COUNT(*) FROM user_groups ug WHERE ug.group_id = g.id) AS member_count,
      (SELECT COUNT(*) FROM projects p WHERE p.group_id = g.id AND p.status = 'active') AS project_count
    FROM groups g
    LEFT JOIN users u ON u.id = g.leader_user_id
    WHERE g.id = ?
  `, [Number(id)]);
  if (!group) return null;
  group.member_count = Number(group.member_count);
  group.project_count = Number(group.project_count);
  group.members = groupMembers(group.id);
  return group;
}

function listGroups(user = null) {
  let sql = `
    SELECT g.*, u.display_name AS leader_name,
      (SELECT COUNT(*) FROM user_groups ug WHERE ug.group_id = g.id) AS member_count,
      (SELECT COUNT(*) FROM projects p WHERE p.group_id = g.id AND p.status = 'active') AS project_count
    FROM groups g
    LEFT JOIN users u ON u.id = g.leader_user_id
  `;
  const params = [];
  if (user && user.role !== 'admin') {
    sql += `
      WHERE g.leader_user_id = ?
         OR EXISTS (SELECT 1 FROM user_groups ug WHERE ug.group_id = g.id AND ug.user_id = ?)
    `;
    params.push(user.id, user.id);
  }
  sql += ' ORDER BY g.id';
  return all(sql, params).map((group) => ({
    ...group,
    member_count: Number(group.member_count),
    project_count: Number(group.project_count),
    members: groupMembers(group.id),
  }));
}

function createGroupImpl(body = {}) {
  const name = String(body.name || '').trim();
  if (!name) {
    const err = new Error('组名不能为空');
    err.status = 400;
    throw err;
  }
  const leaderId = body.leader_user_id ? Number(body.leader_user_id) : null;
  if (leaderId) {
    const leader = getUserById(leaderId);
    if (!leader || leader.status !== 'active') {
      const err = new Error('组长必须是启用状态的用户');
      err.status = 400;
      throw err;
    }
  }
  try {
    const result = run('INSERT INTO groups (name, leader_user_id, created_at) VALUES (?, ?, ?)', [name, leaderId, nowIso()]);
    const groupId = Number(result.lastInsertRowid);
    if (leaderId) {
      run('INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)', [leaderId, groupId]);
      run("UPDATE users SET role = 'leader' WHERE id = ? AND role != 'admin'", [leaderId]);
    }
    return getGroup(groupId);
  } catch (err) {
    if (String(err.message || '').includes('UNIQUE')) {
      const conflict = new Error('组名已存在');
      conflict.status = 409;
      throw conflict;
    }
    throw err;
  }
}

function revokeFormerLeader(userId) {
  if (!userId || get('SELECT id FROM groups WHERE leader_user_id = ?', [userId])) return;
  const user = getUserById(userId);
  if (user && user.role === 'leader') {
    ensureMemberForUser(user);
    run("UPDATE users SET role = 'member', session_version = session_version + 1 WHERE id = ?", [userId]);
  }
}

function updateGroupImpl(id, body = {}) {
  const groupId = Number(id);
  const group = getGroup(groupId);
  if (!group) {
    const err = new Error('组不存在');
    err.status = 404;
    throw err;
  }
  const fields = [];
  const params = [];
  if (body.name !== undefined) {
    const name = String(body.name || '').trim();
    if (!name) {
      const err = new Error('组名不能为空');
      err.status = 400;
      throw err;
    }
    fields.push('name = ?');
    params.push(name);
  }
  if (body.leader_user_id !== undefined) {
    const leaderId = body.leader_user_id ? Number(body.leader_user_id) : null;
    if (leaderId) {
      const leader = getUserById(leaderId);
      if (!leader || leader.status !== 'active') {
        const err = new Error('组长必须是启用状态的用户');
        err.status = 400;
        throw err;
      }
    }
    fields.push('leader_user_id = ?');
    params.push(leaderId);
  }
  if (!fields.length) return group;
  params.push(groupId);
  try {
    run(`UPDATE groups SET ${fields.join(', ')} WHERE id = ?`, params);
  } catch (err) {
    if (String(err.message || '').includes('UNIQUE')) {
      const conflict = new Error('组名已存在');
      conflict.status = 409;
      throw conflict;
    }
    throw err;
  }
  if (body.leader_user_id) {
    run('INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)', [Number(body.leader_user_id), groupId]);
    run("UPDATE users SET role = 'leader' WHERE id = ? AND role != 'admin'", [Number(body.leader_user_id)]);
  }
  if (body.leader_user_id !== undefined) revokeFormerLeader(group.leader_user_id);
  return getGroup(groupId);
}

function addGroupMembersImpl(id, userIds = []) {
  const groupId = Number(id);
  if (!getGroup(groupId)) {
    const err = new Error('组不存在');
    err.status = 404;
    throw err;
  }
  for (const raw of userIds) {
    const userId = Number(raw);
    const user = getUserById(userId);
    if (!user) throw problem(400, '用户不存在');
    if (user.status !== 'active') {
      const err = new Error(`用户「${user.display_name || user.username}」不是启用状态`);
      err.status = 400;
      throw err;
    }
    run('INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)', [userId, groupId]);
  }
  return getGroup(groupId);
}

function removeGroupMemberImpl(id, userId) {
  const groupId = Number(id);
  const targetUserId = Number(userId);
  const group = getGroup(groupId);
  if (!group) {
    const err = new Error('组不存在');
    err.status = 404;
    throw err;
  }
  run('DELETE FROM user_groups WHERE group_id = ? AND user_id = ?', [groupId, targetUserId]);
  if (Number(group.leader_user_id) === targetUserId) {
    run('UPDATE groups SET leader_user_id = NULL WHERE id = ?', [groupId]);
    revokeFormerLeader(targetUserId);
  }
  return getGroup(groupId);
}

function setUserGroupsImpl(userId, groupIds = []) {
  const id = Number(userId);
  const user = getUserById(id);
  if (!user) {
    const err = new Error('用户不存在');
    err.status = 404;
    throw err;
  }
  const unique = [...new Set((groupIds || []).map(Number).filter(Boolean))];
  for (const groupId of unique) {
    if (!getGroup(groupId)) {
      const err = new Error('组不存在');
      err.status = 400;
      throw err;
    }
  }
  for (const group of all('SELECT id FROM groups WHERE leader_user_id = ?', [id])) {
    if (!unique.includes(group.id)) run('UPDATE groups SET leader_user_id = NULL WHERE id = ?', [group.id]);
  }
  revokeFormerLeader(id);
  run('DELETE FROM user_groups WHERE user_id = ?', [id]);
  for (const groupId of unique) {
    run('INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)', [id, groupId]);
  }
  return sanitizeUser(getUserById(id));
}

function isGroupMember(userId, groupId) {
  return !!get('SELECT 1 AS ok FROM user_groups WHERE user_id = ? AND group_id = ?', [Number(userId), Number(groupId)]);
}

function isGroupLeader(userId, groupId) {
  return !!get('SELECT 1 AS ok FROM groups WHERE id = ? AND leader_user_id = ?', [Number(groupId), Number(userId)]);
}

function groupIdsForUser(userId) {
  return all('SELECT group_id FROM user_groups WHERE user_id = ?', [Number(userId)]).map((row) => row.group_id);
}

function revokeSessions(id) {
  run('UPDATE users SET session_version = session_version + 1 WHERE id = ?', [Number(id)]);
}

function touchLogin(id) {
  run('UPDATE users SET last_login_at = ? WHERE id = ?', [nowIso(), Number(id)]);
}

function countActiveAdmins(excludeUserId = 0) {
  const row = get("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND status = 'active' AND id != ?", [Number(excludeUserId)]);
  return Number(row.c);
}


function getSetting(key, fallback = '') {
  const row = get('SELECT value FROM settings WHERE key = ?', [String(key)]);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  run(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `, [String(key), String(value ?? ''), nowIso()]);
}

function getSettingsByPrefix(prefix) {
  return all('SELECT key, value FROM settings WHERE key LIKE ?', [`${String(prefix)}%`]);
}

function createEmailCode(email, purpose, codeHash, expiresAt) {
  run('DELETE FROM email_codes WHERE expires_at < ? OR used_at IS NOT NULL', [Date.now()]);
  const normalized = normalizeEmail(email);
  run('DELETE FROM email_codes WHERE email = ? AND purpose = ? AND used_at IS NULL', [normalized, String(purpose)]);
  run(`
    INSERT INTO email_codes (email, code_hash, purpose, expires_at, attempts, created_at)
    VALUES (?, ?, ?, ?, 0, ?)
  `, [normalized, String(codeHash), String(purpose), Number(expiresAt), nowIso()]);
}

function getLatestEmailCode(email, purpose) {
  return get(`
    SELECT * FROM email_codes
    WHERE email = ? AND purpose = ? AND used_at IS NULL
    ORDER BY id DESC LIMIT 1
  `, [normalizeEmail(email), String(purpose)]);
}

function incrementEmailCodeAttempts(id) {
  run('UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?', [Number(id)]);
}

function markEmailCodeUsed(id) {
  run('UPDATE email_codes SET used_at = ? WHERE id = ?', [nowIso(), Number(id)]);
}

function seedIfEmpty() {
  const count = Number(get('SELECT COUNT(*) AS c FROM members').c);
  if (count > 0) return;

  const today = todayStr();
  const d = (n) => addDays(today, n);
  const created = atLocal(d(-30), '09:00');

  const memberDefs = [
    ['张三', '后端'],
    ['李四', '前端'],
    ['王五', '测试'],
    ['赵六', '产品'],
  ];
  const memberIds = memberDefs.map(([name, role]) =>
    Number(run('INSERT INTO members (name, role, created_at) VALUES (?, ?, ?)', [name, role, created]).lastInsertRowid)
  );

  function makeItem(memberId, title, project, description, priority, startDate, dueDate) {
    const result = run(`
      INSERT INTO items
        (member_id, title, project, description, status, progress, priority, start_date, due_date, archived, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'todo', 0, ?, ?, ?, 0, ?, ?)
    `, [memberId, title, project, description, priority, startDate, dueDate, atLocal(startDate, '09:00'), atLocal(startDate, '09:00')]);
    return Number(result.lastInsertRowid);
  }

  function upd(itemId, memberId, date, status, progress, note, time) {
    const ts = atLocal(date, time);
    run(
      'INSERT INTO updates (item_id, member_id, update_date, status, progress, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [itemId, memberId, date, status, progress, note, ts, ts]
    );
    run('UPDATE items SET status = ?, progress = ?, updated_at = ? WHERE id = ?', [status, progress, ts, itemId]);
  }

  const item1 = makeItem(memberIds[0], '支付回调重试', '支付平台', '为支付回调增加失败重试、幂等校验和告警。', 'high', d(-14), d(3));
  upd(item1, memberIds[0], d(-14), 'todo', 20, '梳理回调失败场景，列出重试策略', '09:30');
  upd(item1, memberIds[0], d(-13), 'doing', 35, '完成重试队列选型，开始写核心逻辑', '10:10');
  upd(item1, memberIds[0], d(-12), 'doing', 50, '重试和幂等框架完成一半，等风控接口', '18:20');
  upd(item1, memberIds[0], d(-11), 'paused', 50, '风控接口未就绪，先搁置，等对方排期', '17:40');
  upd(item1, memberIds[0], d(-4), 'doing', 60, '风控接口联调通过，恢复开发', '10:05');
  upd(item1, memberIds[0], d(-1), 'doing', 70, '重试队列接入完成，补幂等测试', '18:30');
  upd(item1, memberIds[0], d(0), 'doing', 75, '补充重试队列和幂等校验，明天压测', '11:20');

  const item2 = makeItem(memberIds[0], '数据导出性能优化', '数据平台', '解决百万行导出超时，验证分页流式导出方案。', 'medium', d(-9), d(10));
  upd(item2, memberIds[0], d(-9), 'todo', 10, '确认导出慢的根因，定位到一次性加载', '09:50');
  upd(item2, memberIds[0], d(-8), 'doing', 20, '分页方案验证中，准备压测数据', '16:20');
  upd(item2, memberIds[0], d(0), 'paused', 20, '先让位于支付回调，本周搁置', '15:10');

  const item3 = makeItem(memberIds[1], '订单列表性能优化', '交易前台', '首屏加载从 2.8s 降到 1s 以内。', 'high', d(-8), d(5));
  upd(item3, memberIds[1], d(-8), 'todo', 10, '拆解性能瓶颈，确认虚拟列表方案', '10:00');
  upd(item3, memberIds[1], d(-7), 'doing', 25, '完成列表虚拟化 PoC', '18:10');
  upd(item3, memberIds[1], d(-3), 'doing', 45, '筛选联动改造中，处理滚动定位问题', '17:30');
  upd(item3, memberIds[1], d(0), 'doing', 60, '虚拟列表完成 60%，剩余筛选联动', '14:30');

  const item4 = makeItem(memberIds[1], '登录页改版', '用户中心', '新版登录页视觉与交互上线，补齐转化埋点。', 'medium', d(-12), d(-2));
  upd(item4, memberIds[1], d(-12), 'doing', 30, '完成页面结构和新视觉稿还原', '11:00');
  upd(item4, memberIds[1], d(-10), 'doing', 60, '联调登录接口，补充异常提示', '16:40');
  upd(item4, memberIds[1], d(-6), 'doing', 90, '提测通过，准备灰度', '15:20');
  upd(item4, memberIds[1], d(-2), 'done', 100, '灰度完成，全量发布', '19:00');
  upd(item4, memberIds[1], d(0), 'done', 100, '补充转化埋点，观察首日数据', '16:00');

  const item5 = makeItem(memberIds[2], '回归测试用例', '质量保障', '支付链路回归用例补充与执行。', 'high', d(-10), d(2));
  upd(item5, memberIds[2], d(-10), 'todo', 10, '盘点支付链路用例缺口', '09:40');
  upd(item5, memberIds[2], d(-9), 'doing', 20, '补充 18 条异常场景用例', '18:00');
  upd(item5, memberIds[2], d(-5), 'blocked', 30, '等待提测包，先挂起', '16:10');
  upd(item5, memberIds[2], d(0), 'blocked', 30, '提测包仍未到，已同步项目经理', '10:40');

  const item6 = makeItem(memberIds[2], '支付回调测试', '支付平台', '覆盖重试、幂等、超时和签名异常场景。', 'high', d(-4), d(4));
  upd(item6, memberIds[2], d(-4), 'todo', 0, '梳理测试范围和用例结构', '14:00');
  upd(item6, memberIds[2], d(-1), 'doing', 20, '完成正常链路和超时场景', '17:50');
  upd(item6, memberIds[2], d(0), 'doing', 25, '补充异常场景用例', '15:50');

  const item7 = makeItem(memberIds[3], 'Q4 需求评审', '产品规划', '组织 Q4 需求评审并输出会议纪要和优先级。', 'medium', d(-6), d(-1));
  upd(item7, memberIds[3], d(-6), 'doing', 30, '整理需求清单和评审材料', '10:30');
  upd(item7, memberIds[3], d(-4), 'doing', 70, '完成预评审，收集研发意见', '17:00');
  upd(item7, memberIds[3], d(-1), 'done', 100, '评审通过，输出会议纪要', '18:30');

  const item8 = makeItem(memberIds[3], '新报表需求', '数据平台', '面向运营的周度经营报表，确认指标口径和原型。', 'medium', d(-3), d(14));
  upd(item8, memberIds[3], d(-3), 'todo', 10, '收集运营侧报表诉求', '11:10');
  upd(item8, memberIds[3], d(0), 'doing', 40, '确认字段口径，输出 PRD 初稿', '17:10');
}

function backfillActors() {
  run(`
    UPDATE updates
    SET actor_id = (SELECT u.id FROM users u WHERE u.member_id = updates.member_id LIMIT 1)
    WHERE actor_id IS NULL
  `);
  run(`
    UPDATE items
    SET created_by = (SELECT u.id FROM users u WHERE u.member_id = items.member_id LIMIT 1)
    WHERE created_by IS NULL
  `);
  run(`
    UPDATE items
    SET updated_by = (SELECT u.id FROM users u WHERE u.member_id = items.member_id LIMIT 1)
    WHERE updated_by IS NULL
  `);
}

function seedUsersIfEmpty() {
  const count = Number(get('SELECT COUNT(*) AS c FROM users').c);
  if (count === 0) {
    validatePassword(process.env.INITIAL_ADMIN_PASSWORD);
    const now = nowIso();
    run(`
      INSERT INTO users (username, password_hash, display_name, role, member_id, active, created_at)
      VALUES (?, ?, ?, 'admin', NULL, 1, ?)
    `, ['admin', hashPassword(process.env.INITIAL_ADMIN_PASSWORD), '管理员', now]);

    run('UPDATE users SET must_change_password = 1 WHERE username = ?', ['admin']);
    createdInitialAdmin = true;
    const demoAccounts = {
      '张三': 'zhangsan',
      '李四': 'lisi',
      '王五': 'wangwu',
      '赵六': 'zhaoliu',
    };
    for (const member of all('SELECT id, name FROM members')) {
      const username = demoAccounts[member.name];
      if (!username) continue;
      run(`
        INSERT INTO users (username, password_hash, display_name, role, member_id, active, created_at)
        VALUES (?, ?, ?, 'member', ?, 1, ?)
      `, [username, hashPassword(crypto.randomBytes(24).toString('base64url')), member.name, member.id, now]);
      run("UPDATE users SET status = 'disabled', active = 0, must_change_password = 1 WHERE username = ?", [username]);
    }
  }
  backfillActors();
}

let createdInitialAdmin = false;
let rotatedDefaultAdmin = false;
const rotatedAdminUsernames = [];
if (!getSetting('initialized', '')) {
  tx(() => {
    const empty = !get('SELECT id FROM users LIMIT 1') && !get('SELECT id FROM members LIMIT 1');
    if (empty && process.env.SEED_DEMO === '1') seedIfEmpty();
    seedUsersIfEmpty();
    setSetting('initialized', '1');
  });
}
// One-time upgrade: repair inconsistent legacy disabled accounts and retire
// published demo credentials. Initializer prints any replacement only to its terminal.
if (!getSetting('security_hardening_v1', '')) {
  tx(() => {
    run("UPDATE users SET status = 'disabled' WHERE active = 0 AND status = 'active'");
    for (const user of all('SELECT * FROM users')) {
      if (user.role === 'admin' && verifyPassword('admin123', user.password_hash)) {
        validatePassword(process.env.INITIAL_ADMIN_PASSWORD);
        run('UPDATE users SET password_hash = ?, must_change_password = 1, session_version = session_version + 1 WHERE id = ?',
          [hashPassword(process.env.INITIAL_ADMIN_PASSWORD), user.id]);
        rotatedDefaultAdmin = true;
        rotatedAdminUsernames.push(user.username);
      } else if (['zhangsan', 'lisi', 'wangwu', 'zhaoliu'].includes(user.username) && verifyPassword('123456', user.password_hash)) {
        run("UPDATE users SET status = 'disabled', active = 0, session_version = session_version + 1 WHERE id = ?", [user.id]);
      }
    }
    setSetting('security_hardening_v1', '1');
  });
}


function problem(status, message) { return Object.assign(new Error(message), { status }); }
function checkVersion(row, version) {
  if (version !== undefined && Number(version) !== Number(row.version)) throw problem(409, '内容已被其他人修改，请重新加载后再保存');
}
function assertProjectWritable(id) {
  if (get('SELECT status FROM projects WHERE id = ?', [id])?.status !== 'active') throw problem(409, '项目已归档，请先恢复项目');
}
function audit(actor, action, entity, id, before, after) {
  const clean = value => {
    if (!value) return null;
    const copy = { ...value };
    for (const key of Object.keys(copy)) if (/password|secret|code_hash|smtp_pass|session_version/i.test(key)) delete copy[key];
    return JSON.stringify(copy);
  };
  run('INSERT INTO audit_log (actor_id, action, entity, entity_id, before_json, after_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [actor?.id || null, action, entity, id, clean(before), clean(after), nowIso()]);
}
function listAudit(query = {}) {
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 50));
  return all('SELECT * FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT ?', [Number(query.before) || Number.MAX_SAFE_INTEGER, limit]);
}
function saveDraft(user, key, content) {
  if (key.length > 100 || JSON.stringify(content).length > 50000) throw problem(400, '草稿过长');
  run('DELETE FROM report_drafts WHERE updated_at < ?', [new Date(Date.now() - 30 * 86400000).toISOString()]);
  if (!getDraft(user, key) && get('SELECT COUNT(*) AS count FROM report_drafts WHERE user_id = ?', [user.id]).count >= 100) throw problem(409, '草稿已达 100 份，请提交或删除旧草稿');
  run('INSERT INTO report_drafts VALUES (?, ?, ?, ?) ON CONFLICT(user_id, draft_key) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at', [user.id, key, JSON.stringify(content), nowIso()]);
}
function getDraft(user, key) { const row = get('SELECT content FROM report_drafts WHERE user_id = ? AND draft_key = ? AND updated_at >= ?', [user.id, key, new Date(Date.now() - 30 * 86400000).toISOString()]); return row ? JSON.parse(row.content) : null; }
function deleteDraft(user, key) { run('DELETE FROM report_drafts WHERE user_id = ? AND draft_key = ?', [user.id, key]); }
function health() { return get('SELECT 1 AS ok').ok === 1; }
function close() { db.close(); }

module.exports = {
  listAudit, saveDraft, getDraft, deleteDraft, health, close, canEditItem,
  DB_PATH,
  createdInitialAdmin,
  rotatedDefaultAdmin,
  rotatedAdminUsernames,
  revokeSessions,
  STATUSES,
  PRIORITIES,
  STATUS_LABELS,
  todayStr,
  isDate,
  addDays,
  diffDays,
  listMembers,
  createMember,
  getUserById,
  getUserByLogin,
  getUserByUsername,
  getUserByEmail,
  listUsers,
  listPendingUsers,
  createUser,
  updateUser,
  approveUser,
  rejectUser,
  touchLogin,
  countActiveAdmins,
  normalizeEmail,
  isValidEmail,
  listGroups,
  getGroup,
  createGroup,
  updateGroup,
  addGroupMembers,
  removeGroupMember,
  setUserGroups,
  isGroupMember,
  isGroupLeader,
  groupIdsForUser,
  REPORT_TYPES,
  VISIBILITIES,
  normalizeWeekStart,
  listProjects,
  getProject,
  createProject,
  updateProject,
  archiveProject,
  listReports,
  getReport,
  createReport,
  updateReport,
  deleteReport,
  listPublicReports,
  getSetting,
  setSetting,
  getSettingsByPrefix,
  createEmailCode,
  getLatestEmailCode,
  incrementEmailCodeAttempts,
  markEmailCodeUsed,
  listItems,
  getItemDetail,
  createItem,
  updateItemMeta,
  addUpdate,
  getWorkUpdate,
  updateWorkUpdate,
  deleteWorkUpdate,
  archiveItem,
  getDay,
  getSummary,
  getExportRows,
};

function createGroup(...args) { return tx(() => { const result = createGroupImpl(...args); audit(args.at(-1)?.role ? args.at(-1) : null, 'createGroup', 'groups', result.id, null, result); return result; }); }

function updateGroup(...args) { return tx(() => { const before = getGroup(args[0]); const result = updateGroupImpl(...args); audit(args.at(-1)?.role ? args.at(-1) : null, 'updateGroup', 'groups', result.id, before, result); return result; }); }

function addGroupMembers(...args) { return tx(() => { const before = getGroup(args[0]); const result = addGroupMembersImpl(...args); audit(args.at(-1)?.role ? args.at(-1) : null, 'addGroupMembers', 'groups', result.id, before, result); return result; }); }

function removeGroupMember(...args) { return tx(() => { const before = getGroup(args[0]); const result = removeGroupMemberImpl(...args); audit(args.at(-1)?.role ? args.at(-1) : null, 'removeGroupMember', 'groups', result.id, before, result); return result; }); }

function setUserGroups(...args) { return tx(() => { const result = setUserGroupsImpl(...args); audit(args.at(-1)?.role ? args.at(-1) : null, 'setUserGroups', 'groups', result.id, null, result); return result; }); }
