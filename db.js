const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('./security');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'tracker.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

const TZ = process.env.TZ || 'Asia/Shanghai';
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
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}

function clampProgress(value, fallback = 0) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(0, Math.min(100, n));
}

function validStatus(value, fallback = 'todo') {
  return STATUSES.includes(value) ? value : fallback;
}

function validPriority(value, fallback = 'medium') {
  return PRIORITIES.includes(value) ? value : fallback;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    member_id INTEGER REFERENCES members(id),
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    last_login_at TEXT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_member_unique
    ON users(member_id) WHERE member_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER NOT NULL REFERENCES members(id),
    title TEXT NOT NULL,
    project TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo',
    progress INTEGER NOT NULL DEFAULT 0,
    priority TEXT NOT NULL DEFAULT 'medium',
    start_date TEXT,
    due_date TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    member_id INTEGER NOT NULL REFERENCES members(id),
    update_date TEXT NOT NULL,
    status TEXT NOT NULL,
    progress INTEGER NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_updates_date ON updates(update_date);
  CREATE INDEX IF NOT EXISTS idx_updates_item ON updates(item_id, update_date, id);
  CREATE INDEX IF NOT EXISTS idx_items_member ON items(member_id);
`);

function addColumnIfMissing(table, column, definition) {
  const columns = all(`PRAGMA table_info(${table})`);
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

addColumnIfMissing('items', 'created_by', 'INTEGER');
addColumnIfMissing('items', 'updated_by', 'INTEGER');
addColumnIfMissing('updates', 'actor_id', 'INTEGER');

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

function getUserById(id) {
  return get(`
    SELECT u.*, m.name AS member_name
    FROM users u
    LEFT JOIN members m ON m.id = u.member_id
    WHERE u.id = ?
  `, [Number(id)]);
}

function getUserByUsername(username) {
  return get(`
    SELECT u.*, m.name AS member_name
    FROM users u
    LEFT JOIN members m ON m.id = u.member_id
    WHERE u.username = ?
  `, [String(username)]);
}

function listUsers() {
  return all(`
    SELECT u.*, m.name AS member_name
    FROM users u
    LEFT JOIN members m ON m.id = u.member_id
    ORDER BY u.id
  `).map(sanitizeUser);
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

function createUser(body = {}) {
  const username = String(body.username || '').trim();
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
    const err = new Error('用户名需为 3-32 位字母、数字、下划线、点或横线');
    err.status = 400;
    throw err;
  }
  const password = String(body.password || '');
  if (password.length < 6) {
    const err = new Error('密码至少 6 位');
    err.status = 400;
    throw err;
  }
  const role = ['admin', 'manager', 'member'].includes(body.role) ? body.role : 'member';
  const memberId = body.member_id ? Number(body.member_id) : null;
  if (role === 'member' && !memberId) {
    const err = new Error('成员账号必须关联一个成员');
    err.status = 400;
    throw err;
  }
  validateMemberLink(memberId);
  const displayName = String(body.display_name || '').trim() || username;
  try {
    const result = run(`
      INSERT INTO users (username, password_hash, display_name, role, member_id, active, created_at)
      VALUES (?, ?, ?, ?, ?, 1, ?)
    `, [username, hashPassword(password), displayName, role, memberId, nowIso()]);
    return sanitizeUser(getUserById(Number(result.lastInsertRowid)));
  } catch (err) {
    if (String(err.message || '').includes('UNIQUE')) {
      const conflict = new Error('用户名已存在');
      conflict.status = 409;
      throw conflict;
    }
    throw err;
  }
}

function updateUser(id, body = {}) {
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
  if (body.role !== undefined) {
    if (!['admin', 'manager', 'member'].includes(body.role)) {
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

  const effectiveRole = body.role !== undefined ? body.role : current.role;
  const effectiveMemberId = body.member_id !== undefined
    ? (body.member_id ? Number(body.member_id) : null)
    : current.member_id;
  if (effectiveRole === 'member' && !effectiveMemberId) {
    const err = new Error('成员账号必须关联一个成员');
    err.status = 400;
    throw err;
  }

  if (body.active !== undefined) add('active', body.active ? 1 : 0);
  if (body.password !== undefined) {
    const password = String(body.password || '');
    if (password.length < 6) {
      const err = new Error('密码至少 6 位');
      err.status = 400;
      throw err;
    }
    add('password_hash', hashPassword(password));
  }

  if (!fields.length) return sanitizeUser(current);
  run(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, [...params, userId]);
  return sanitizeUser(getUserById(userId));
}

function touchLogin(id) {
  run('UPDATE users SET last_login_at = ? WHERE id = ?', [nowIso(), Number(id)]);
}

function countActiveAdmins(excludeUserId = 0) {
  const row = get("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND active = 1 AND id != ?", [Number(excludeUserId)]);
  return Number(row.c);
}

function listItems(filters = {}) {
  const where = ['i.archived = 0'];
  const params = [];

  if (filters.member_id) {
    where.push('i.member_id = ?');
    params.push(Number(filters.member_id));
  }
  if (filters.status && STATUSES.includes(filters.status)) {
    where.push('i.status = ?');
    params.push(filters.status);
  }
  if (filters.q) {
    const like = `%${String(filters.q).trim()}%`;
    where.push('(i.title LIKE ? OR i.project LIKE ? OR i.description LIKE ? OR m.name LIKE ?)');
    params.push(like, like, like, like);
  }

  const rows = all(`
    SELECT i.*, m.name AS member_name, m.role AS member_role,
      cu.display_name AS created_by_name,
      uu.display_name AS updated_by_name,
      (SELECT MAX(u.update_date) FROM updates u WHERE u.item_id = i.id) AS last_update_date,
      (SELECT COUNT(*) FROM updates u WHERE u.item_id = i.id) AS update_count,
      (SELECT u.note FROM updates u WHERE u.item_id = i.id
        ORDER BY u.update_date DESC, u.id DESC LIMIT 1) AS last_note
    FROM items i
    JOIN members m ON m.id = i.member_id
    LEFT JOIN users cu ON cu.id = i.created_by
    LEFT JOIN users uu ON uu.id = i.updated_by
    WHERE ${where.join(' AND ')}
    ORDER BY
      CASE i.status
        WHEN 'blocked' THEN 0
        WHEN 'paused' THEN 1
        WHEN 'doing' THEN 2
        WHEN 'todo' THEN 3
        WHEN 'done' THEN 4
        ELSE 5
      END,
      i.updated_at DESC
  `, params);

  const today = todayStr();
  return rows.map((row) => {
    const days = row.last_update_date ? Math.max(0, diffDays(row.last_update_date, today)) : null;
    return {
      ...row,
      update_count: Number(row.update_count),
      days_since_update: days,
    };
  });
}

function getItemDetail(id) {
  const item = get(`
    SELECT i.*, m.name AS member_name, m.role AS member_role,
      cu.display_name AS created_by_name,
      uu.display_name AS updated_by_name,
      (SELECT MAX(u.update_date) FROM updates u WHERE u.item_id = i.id) AS last_update_date,
      (SELECT COUNT(*) FROM updates u WHERE u.item_id = i.id) AS update_count
    FROM items i
    JOIN members m ON m.id = i.member_id
    LEFT JOIN users cu ON cu.id = i.created_by
    LEFT JOIN users uu ON uu.id = i.updated_by
    WHERE i.id = ?
  `, [Number(id)]);

  if (!item) {
    const err = new Error('事项不存在');
    err.status = 404;
    throw err;
  }

  const rows = all(`
    SELECT u.*, m.name AS member_name,
      COALESCE(au.display_name, m.name) AS actor_name
    FROM updates u
    JOIN members m ON m.id = u.member_id
    LEFT JOIN users au ON au.id = u.actor_id
    WHERE u.item_id = ?
    ORDER BY u.update_date ASC, u.id ASC
  `, [Number(id)]);

  let prev = null;
  const timeline = rows.map((row) => {
    const out = {
      ...row,
      gap_days: prev ? diffDays(prev.update_date, row.update_date) : null,
      progress_delta: prev ? Number(row.progress) - Number(prev.progress) : null,
      prev_status: prev ? prev.status : null,
      status_changed: prev ? prev.status !== row.status : true,
    };
    prev = row;
    return out;
  });

  const today = todayStr();
  return {
    ...item,
    update_count: Number(item.update_count),
    days_since_update: item.last_update_date ? Math.max(0, diffDays(item.last_update_date, today)) : null,
    timeline,
  };
}

function addUpdateRow(itemId, memberId, updateDate, status, progress, note, createdAt, actorId = null) {
  run(
    'INSERT INTO updates (item_id, member_id, update_date, status, progress, note, created_at, actor_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [itemId, memberId, updateDate, status, progress, note, createdAt, actorId]
  );
  const latest = get(
    'SELECT status, progress FROM updates WHERE item_id = ? ORDER BY update_date DESC, id DESC LIMIT 1',
    [itemId]
  );
  run('UPDATE items SET status = ?, progress = ?, updated_at = ?, updated_by = ? WHERE id = ?', [
    latest.status,
    latest.progress,
    createdAt,
    actorId,
    itemId,
  ]);
}

function createItem(body = {}, actor = null) {
  const actorMemberId = actor && actor.role === 'member' ? Number(actor.member_id) : null;
  if (actor && actor.role === 'member' && !actorMemberId) {
    const err = new Error('当前账号未关联成员，无法创建事项');
    err.status = 400;
    throw err;
  }
  const memberId = actorMemberId || Number(body.member_id);
  const member = get('SELECT * FROM members WHERE id = ?', [memberId]);
  if (!member) {
    const err = new Error('请选择有效的负责人');
    err.status = 400;
    throw err;
  }

  const title = String(body.title || '').trim();
  if (!title) {
    const err = new Error('事项标题不能为空');
    err.status = 400;
    throw err;
  }

  const status = validStatus(body.status, 'todo');
  const progress = clampProgress(body.progress, 0);
  const priority = validPriority(body.priority, 'medium');
  const startDate = isDate(body.start_date) ? body.start_date : todayStr();
  const dueDate = isDate(body.due_date) ? body.due_date : null;
  const updateDate = isDate(body.update_date) ? body.update_date : startDate;
  const note = String(body.note || '').trim() || '创建事项';
  const createdAt = nowIso();

  const itemId = tx(() => {
    const result = run(`
      INSERT INTO items
        (member_id, title, project, description, status, progress, priority, start_date, due_date, archived, created_at, updated_at, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
    `, [
      memberId,
      title,
      String(body.project || '').trim(),
      String(body.description || '').trim(),
      status,
      progress,
      priority,
      startDate,
      dueDate,
      createdAt,
      createdAt,
      actor ? actor.id : null,
      actor ? actor.id : null,
    ]);
    const id = Number(result.lastInsertRowid);
    addUpdateRow(id, memberId, updateDate, status, progress, note, createdAt, actor ? actor.id : null);
    return id;
  });

  return getItemDetail(itemId);
}

function updateItemMeta(id, body = {}, actor = null) {
  const itemId = Number(id);
  const current = get('SELECT * FROM items WHERE id = ? AND archived = 0', [itemId]);
  if (!current) {
    const err = new Error('事项不存在');
    err.status = 404;
    throw err;
  }

  const fields = [];
  const params = [];
  const add = (column, value) => {
    fields.push(`${column} = ?`);
    params.push(value);
  };

  if (body.title !== undefined) {
    const title = String(body.title || '').trim();
    if (!title) {
      const err = new Error('事项标题不能为空');
      err.status = 400;
      throw err;
    }
    add('title', title);
  }
  if (body.project !== undefined) add('project', String(body.project || '').trim());
  if (body.description !== undefined) add('description', String(body.description || '').trim());
  if (body.priority !== undefined) add('priority', validPriority(body.priority, current.priority));
  if (body.due_date !== undefined) add('due_date', isDate(body.due_date) ? body.due_date : null);
  if (body.start_date !== undefined) add('start_date', isDate(body.start_date) ? body.start_date : null);
  if (body.member_id !== undefined) {
    const memberId = Number(body.member_id);
    const member = get('SELECT id FROM members WHERE id = ?', [memberId]);
    if (!member) {
      const err = new Error('负责人不存在');
      err.status = 400;
      throw err;
    }
    add('member_id', memberId);
  }

  if (!fields.length) return getItemDetail(itemId);

  add('updated_by', actor ? actor.id : current.updated_by ?? null);
  add('updated_at', nowIso());
  params.push(itemId);
  run(`UPDATE items SET ${fields.join(', ')} WHERE id = ?`, params);
  return getItemDetail(itemId);
}

function addUpdate(itemId, body = {}, actor = null) {
  const id = Number(itemId);
  const item = get('SELECT * FROM items WHERE id = ? AND archived = 0', [id]);
  if (!item) {
    const err = new Error('事项不存在');
    err.status = 404;
    throw err;
  }

  const updateDate = isDate(body.update_date) ? body.update_date : todayStr();
  const status = validStatus(body.status, item.status);
  const progress = clampProgress(body.progress, Number(item.progress));
  const note = String(body.note || '').trim();
  const createdAt = nowIso();

  addUpdateRow(id, item.member_id, updateDate, status, progress, note, createdAt, actor ? actor.id : null);
  return getItemDetail(id);
}

function archiveItem(id, actor = null) {
  const itemId = Number(id);
  const item = get('SELECT * FROM items WHERE id = ? AND archived = 0', [itemId]);
  if (!item) {
    const err = new Error('事项不存在');
    err.status = 404;
    throw err;
  }
  run('UPDATE items SET archived = 1, updated_at = ?, updated_by = ? WHERE id = ?', [
    nowIso(),
    actor ? actor.id : null,
    itemId,
  ]);
  return { ok: true };
}

function getDay(date) {
  const day = isDate(date) ? date : todayStr();
  const members = listMembers();

  const rows = all(`
    SELECT u.id, u.item_id, u.update_date, u.status, u.progress, u.note, u.created_at,
      u.actor_id, COALESCE(au.display_name, m.name) AS actor_name,
      i.title, i.project, i.priority, i.due_date,
      m.id AS member_id, m.name AS member_name, m.role AS member_role
    FROM updates u
    JOIN items i ON i.id = u.item_id
    JOIN members m ON m.id = u.member_id
    LEFT JOIN users au ON au.id = u.actor_id
    WHERE u.update_date = ? AND i.archived = 0
    ORDER BY m.id, u.created_at, u.id
  `, [day]);

  const byMember = new Map();
  for (const m of members) byMember.set(m.id, []);

  const latestByItem = new Map();
  for (const row of rows) {
    if (!byMember.has(row.member_id)) continue;
    byMember.get(row.member_id).push(row);
    latestByItem.set(row.item_id, row);
  }

  const activeItems = all(`
    SELECT i.id, i.member_id, i.title, i.status, i.progress, i.due_date
    FROM items i
    WHERE i.archived = 0 AND i.status != 'done'
  `);
  const updatedIds = new Set(rows.map((r) => r.item_id));

  const memberCards = members.map((m) => {
    const updates = byMember.get(m.id) || [];
    const silentItems = activeItems
      .filter((i) => i.member_id === m.id && !updatedIds.has(i.id))
      .map((i) => ({ ...i }));
    return { ...m, updates, silentItems };
  });

  const statusCounts = {};
  for (const row of latestByItem.values()) {
    statusCounts[row.status] = (statusCounts[row.status] || 0) + 1;
  }

  const membersUpdated = memberCards.filter((m) => m.updates.length > 0).length;
  const silentMembers = memberCards
    .filter((m) => m.updates.length === 0)
    .map((m) => ({ id: m.id, name: m.name, role: m.role, active_count: m.active_count }));

  return {
    date: day,
    summary: {
      members: members.length,
      membersUpdated,
      updates: rows.length,
      itemsTouched: latestByItem.size,
      statusCounts,
    },
    members: memberCards,
    silentMembers,
  };
}


function getSummary(from, to, memberId) {
  const rows = getExportRows(from, to, memberId);
  const members = listMembers()
    .filter((member) => !memberId || Number(member.id) === Number(memberId))
    .map((member) => ({
      id: member.id,
      name: member.name,
      role: member.role,
      updates: 0,
      lastDate: null,
      itemMap: new Map(),
    }));
  const memberMap = new Map(members.map((member) => [member.id, member]));
  const dayMap = new Map();
  const allItems = new Map();

  for (const row of rows) {
    dayMap.set(row.date, (dayMap.get(row.date) || 0) + 1);
    const member = memberMap.get(row.member_id);
    if (!member) continue;
    member.updates += 1;
    if (!member.lastDate || row.date > member.lastDate) member.lastDate = row.date;

    let item = member.itemMap.get(row.item_id);
    if (!item) {
      item = {
        id: row.item_id,
        title: row.title,
        project: row.project,
        status: row.status,
        progress: row.progress,
        note: '',
        date: row.date,
        count: 0,
      };
      member.itemMap.set(row.item_id, item);
    }
    item.count += 1;
    if (row.date >= item.date) {
      item.date = row.date;
      item.title = row.title;
      item.project = row.project;
      item.status = row.status;
      item.progress = row.progress;
      item.note = row.note;
    }
    allItems.set(row.item_id, item);
  }

  for (const member of members) {
    member.items = [...member.itemMap.values()]
      .sort((a, b) => b.date.localeCompare(a.date) || b.count - a.count);
    delete member.itemMap;
    member.statusCounts = {};
    for (const item of member.items) {
      member.statusCounts[item.status] = (member.statusCounts[item.status] || 0) + 1;
    }
  }

  const statusCounts = {};
  for (const item of allItems.values()) {
    statusCounts[item.status] = (statusCounts[item.status] || 0) + 1;
  }

  return {
    from,
    to,
    totals: {
      updates: rows.length,
      members: members.length,
      membersUpdated: members.filter((member) => member.updates > 0).length,
      itemsTouched: allItems.size,
      statusCounts,
    },
    members: members.sort((a, b) => b.updates - a.updates || a.name.localeCompare(b.name, 'zh')),
    days: [...dayMap.entries()]
      .map(([date, updates]) => ({ date, updates }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
}

function getExportRows(from, to, memberId) {
  const where = ['u.update_date BETWEEN ? AND ?', 'i.archived = 0'];
  const params = [from, to];
  if (memberId) {
    where.push('u.member_id = ?');
    params.push(Number(memberId));
  }

  return all(`
    SELECT u.update_date AS date, u.status, u.progress, u.note, u.created_at,
      u.actor_id, COALESCE(au.display_name, m.name) AS actor,
      i.id AS item_id, i.title, i.project, i.priority, i.due_date,
      m.id AS member_id, m.name AS member, m.role
    FROM updates u
    JOIN items i ON i.id = u.item_id
    JOIN members m ON m.id = u.member_id
    LEFT JOIN users au ON au.id = u.actor_id
    WHERE ${where.join(' AND ')}
    ORDER BY u.update_date, m.id, u.created_at, u.id
  `, params).map((row) => ({ ...row, progress: Number(row.progress) }));
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
      'INSERT INTO updates (item_id, member_id, update_date, status, progress, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [itemId, memberId, date, status, progress, note, ts]
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
    const now = nowIso();
    run(`
      INSERT INTO users (username, password_hash, display_name, role, member_id, active, created_at)
      VALUES (?, ?, ?, 'admin', NULL, 1, ?)
    `, ['admin', hashPassword(process.env.INITIAL_ADMIN_PASSWORD || 'admin123'), '管理员', now]);

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
      `, [username, hashPassword('123456'), member.name, member.id, now]);
    }
  }
  backfillActors();
}

if (process.env.SEED_DEMO !== '0') seedIfEmpty();
seedUsersIfEmpty();

module.exports = {
  DB_PATH,
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
  getUserByUsername,
  listUsers,
  createUser,
  updateUser,
  touchLogin,
  countActiveAdmins,
  listItems,
  getItemDetail,
  createItem,
  updateItemMeta,
  addUpdate,
  archiveItem,
  getDay,
  getSummary,
  getExportRows,
};
