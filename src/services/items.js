module.exports = function createItemService({ all, get, run, tx, nowIso, isDate, todayStr, diffDays, listMembers, getProject, canViewProject, isGroupLeader, assertProjectWritable, clampProgress, validStatus, validPriority, STATUSES, problem, checkVersion, audit }) {
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
  if (filters.project_id) { where.push('i.project_id = ?'); params.push(Number(filters.project_id)); }
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
      i.updated_at DESC, i.id DESC
    ${filters.limit ? 'LIMIT ? OFFSET ?' : ''}
  `, filters.limit ? [...params, Number(filters.limit), Number(filters.offset || 0)] : params);

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


function canEditItem(user, item) {
  if (!user || !item || item.archived) return false;
  const project = item.project_id ? get('SELECT * FROM projects WHERE id = ?', [item.project_id]) : null;
  if (project && project.status !== 'active') return false;
  if (user.role === 'admin') return true;
  if (project && !canViewProject(user, project)) return false;
  return Number(item.member_id) === Number(user.member_id) || Boolean(project && isGroupLeader(user.id, project.group_id));
}

function canEditUpdate(user, update) {
  if (!user || !update) return false;
  if (update.item_archived !== undefined && user.role === 'admin') return !update.item_archived && update.item_project_status !== 'archived';
  const parent = get('SELECT i.archived, p.status FROM items i LEFT JOIN projects p ON p.id = i.project_id WHERE i.id = ?', [update.item_id]);
  if (parent?.archived || parent?.status === 'archived') return false;
  const item = get('SELECT * FROM items WHERE id = ?', [update.item_id]);
  if (canEditItem(user, item)) return true;
  if (item?.project_id && !canViewProject(user, get('SELECT * FROM projects WHERE id = ?', [item.project_id]))) return false;
  if (Number(update.actor_id) === Number(user.id)) return true;
  const owner = get('SELECT member_id FROM items WHERE id = ?', [update.item_id]);
  if (user.member_id && owner && Number(owner.member_id) === Number(user.member_id)) return true;
  return false;
}

function getWorkUpdate(id, user) {
  const update = get(`
    SELECT u.*, i.title AS item_title, i.member_id AS item_member_id,
      m.name AS member_name,
      COALESCE(au.display_name, m.name) AS actor_name,
      eu.display_name AS editor_name
    FROM updates u
    JOIN items i ON i.id = u.item_id
    JOIN members m ON m.id = u.member_id
    LEFT JOIN users au ON au.id = u.actor_id
    LEFT JOIN users eu ON eu.id = u.edited_by
    WHERE u.id = ?
  `, [Number(id)]);
  if (!update) {
    const err = new Error('更新记录不存在');
    err.status = 404;
    throw err;
  }
  const canEdit = canEditUpdate(user, update);
  return {
    update: { ...update, can_edit: canEdit },
    item: {
      id: update.item_id,
      title: update.item_title,
      member_id: update.item_member_id,
      member_name: update.member_name,
    },
    can_edit: canEdit,
  };
}

function recalcItemState(itemId) {
  const latest = get(
    'SELECT status, progress, actor_id, member_id FROM updates WHERE item_id = ? ORDER BY update_date DESC, id DESC LIMIT 1',
    [itemId]
  );
  if (latest) {
    run('UPDATE items SET status = ?, progress = ?, updated_at = ?, updated_by = ?, version = version + 1 WHERE id = ?', [
      latest.status,
      latest.progress,
      nowIso(),
      latest.actor_id || latest.member_id || null,
      itemId,
    ]);
  } else {
    run("UPDATE items SET status = 'todo', progress = 0, updated_at = ?, updated_by = NULL WHERE id = ?", [
      nowIso(),
      itemId,
    ]);
  }
}

function updateWorkUpdateImpl(id, body = {}, user) {
  const data = getWorkUpdate(id, user);
  if (!data.can_edit) {
    const err = new Error('你没有权限修改该更新记录');
    err.status = 403;
    throw err;
  }
  const update = data.update;
  checkVersion(update, body.version);
  const updateDate = body.update_date !== undefined ? String(body.update_date || '').trim() : update.update_date;
  if (!isDate(updateDate)) {
    const err = new Error('日期格式应为 YYYY-MM-DD');
    err.status = 400;
    throw err;
  }
  const status = body.status !== undefined ? validStatus(body.status, update.status) : update.status;
  const progress = status === 'done' ? 100 : (body.progress !== undefined ? clampProgress(body.progress, Number(update.progress)) : Number(update.progress));
  const note = body.note !== undefined ? String(body.note || '').trim() : update.note;
  run(`
    UPDATE updates SET update_date = ?, status = ?, progress = ?, note = ?,
      edited_by = ?, updated_at = ?, version = version + 1
    WHERE id = ?
  `, [updateDate, status, progress, note, user.id, nowIso(), update.id]);
  recalcItemState(update.item_id);
  return getWorkUpdate(update.id, user);
}

function deleteWorkUpdateImpl(id, user) {
  const data = getWorkUpdate(id, user);
  if (!data.can_edit) {
    const err = new Error('你没有权限删除该更新记录');
    err.status = 403;
    throw err;
  }
  const count = get('SELECT COUNT(*) AS c FROM updates WHERE item_id = ?', [data.update.item_id]);
  if (Number(count.c) <= 1) {
    const err = new Error('至少保留一条更新记录');
    err.status = 400;
    throw err;
  }
  run('DELETE FROM updates WHERE id = ?', [data.update.id]);
  recalcItemState(data.update.item_id);
  return { ok: true, item_id: data.update.item_id };
}

function getItemDetail(id, user = null) {
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
      COALESCE(au.display_name, m.name) AS actor_name,
      eu.display_name AS editor_name
    FROM updates u
    JOIN members m ON m.id = u.member_id
    LEFT JOIN users au ON au.id = u.actor_id
    LEFT JOIN users eu ON eu.id = u.edited_by
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
      can_edit: canEditUpdate(user, row),
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
    'INSERT INTO updates (item_id, member_id, update_date, status, progress, note, created_at, updated_at, actor_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [itemId, memberId, updateDate, status, progress, note, createdAt, createdAt, actorId]
  );
  const latest = get(
    'SELECT status, progress FROM updates WHERE item_id = ? ORDER BY update_date DESC, id DESC LIMIT 1',
    [itemId]
  );
  run('UPDATE items SET status = ?, progress = ?, updated_at = ?, updated_by = ?, version = version + 1 WHERE id = ?', [
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

  const linkedProject = body.project_id ? getProject(body.project_id, actor) : null;
  if (linkedProject) assertProjectWritable(linkedProject.id);
  const title = String(body.title || '').trim();
  if (!title) {
    const err = new Error('事项标题不能为空');
    err.status = 400;
    throw err;
  }

  const status = validStatus(body.status, 'todo');
  const progress = status === 'done' ? 100 : clampProgress(body.progress, 0);
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
    if (linkedProject) run('UPDATE items SET project_id = ? WHERE id = ?', [linkedProject.id, id]);
    addUpdateRow(id, memberId, updateDate, status, progress, note, createdAt, actor ? actor.id : null);
    return id;
  });

  return getItemDetail(itemId, actor);
}

function updateItemMetaImpl(id, body = {}, actor = null) {
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

  checkVersion(current, body.version);
  if (body.title !== undefined) {
    const title = String(body.title || '').trim();
    if (!title) {
      const err = new Error('事项标题不能为空');
      err.status = 400;
      throw err;
    }
    add('title', title);
  }
  if (body.project_id !== undefined) {
    const project = body.project_id ? getProject(body.project_id, actor) : null;
    if (project) assertProjectWritable(project.id);
    add('project_id', project ? project.id : null);
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

  if (!fields.length) return getItemDetail(itemId, actor);

  fields.push('version = version + 1');
  add('updated_by', actor ? actor.id : current.updated_by ?? null);
  add('updated_at', nowIso());
  params.push(itemId);
  run(`UPDATE items SET ${fields.join(', ')} WHERE id = ?`, params);
  return getItemDetail(itemId, actor);
}

function addUpdateImpl(itemId, body = {}, actor = null) {
  const linked = get('SELECT project_id FROM items WHERE id = ?', [Number(itemId)]);
  if (linked && linked.project_id) assertProjectWritable(linked.project_id);
  const id = Number(itemId);
  const item = get('SELECT * FROM items WHERE id = ? AND archived = 0', [id]);
  if (!item) {
    const err = new Error('事项不存在');
    err.status = 404;
    throw err;
  }

  const updateDate = isDate(body.update_date) ? body.update_date : todayStr();
  const status = validStatus(body.status, item.status);
  const progress = status === 'done' ? 100 : clampProgress(body.progress, Number(item.progress));
  const note = String(body.note || '').trim();
  const createdAt = nowIso();

  addUpdateRow(id, item.member_id, updateDate, status, progress, note, createdAt, actor ? actor.id : null);
  return getItemDetail(id, actor);
}

function archiveItemImpl(id, actor = null) {
  const itemId = Number(id);
  const item = get('SELECT * FROM items WHERE id = ? AND archived = 0', [itemId]);
  if (!item) {
    const err = new Error('事项不存在');
    err.status = 404;
    throw err;
  }
  run('UPDATE items SET archived = 1, archived_at = CURRENT_TIMESTAMP, updated_at = ?, updated_by = ?, version = version + 1 WHERE id = ?', [
    nowIso(),
    actor ? actor.id : null,
    itemId,
  ]);
  return { ok: true };
}

function getDay(date, user = null) {
  const day = isDate(date) ? date : todayStr();
  const members = listMembers();

  const rows = all(`
    SELECT u.id, u.item_id, u.update_date, u.status, u.progress, u.note, u.created_at,
      u.updated_at, u.actor_id, u.edited_by,
      COALESCE(au.display_name, m.name) AS actor_name,
      eu.display_name AS editor_name,
      i.title, i.project, i.priority, i.due_date, i.archived AS item_archived, p.status AS item_project_status,
      m.id AS member_id, m.name AS member_name, m.role AS member_role
    FROM updates u
    JOIN items i ON i.id = u.item_id
    LEFT JOIN projects p ON p.id = i.project_id
    JOIN members m ON m.id = u.member_id
    LEFT JOIN users au ON au.id = u.actor_id
    LEFT JOIN users eu ON eu.id = u.edited_by
    WHERE u.update_date = ?
    ORDER BY m.id, u.created_at, u.id
  `, [day]).map((row) => ({ ...row, can_edit: canEditUpdate(user, row) }));

  const byMember = new Map();
  for (const m of members) byMember.set(m.id, []);

  const latestByItem = new Map();
  for (const row of rows) {
    if (!byMember.has(row.member_id)) continue;
    byMember.get(row.member_id).push(row);
    latestByItem.set(row.item_id, row);
  }

  const activeItems = all(`
    SELECT i.id, u.member_id, i.title, u.status, u.progress, i.due_date
    FROM items i JOIN updates u ON u.id = (
      SELECT id FROM updates WHERE item_id = i.id AND update_date <= ? ORDER BY update_date DESC, id DESC LIMIT 1
    )
    WHERE u.status != 'done' AND (i.archived_at IS NULL OR substr(i.archived_at, 1, 10) > ?)
  `, [day, day]);
  const updatedIds = new Set(rows.map((r) => r.item_id));

  const memberCards = members.map((m) => {
    const updates = byMember.get(m.id) || [];
    const silentItems = activeItems
      .filter((i) => i.member_id === m.id && !updatedIds.has(i.id))
      .map((i) => ({ ...i }));
    return { ...m, active_count: activeItems.filter(i => i.member_id === m.id).length, updates, silentItems };
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
  const where = ['u.update_date BETWEEN ? AND ?'];
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



function updateWorkUpdate(...args) { return tx(() => { const before = get('SELECT * FROM updates WHERE id = ?', [Number(args[0])]); const result = updateWorkUpdateImpl(...args); audit(args[2], 'updateWorkUpdate', 'updates', Number(args[0]), before, get('SELECT * FROM updates WHERE id = ?', [Number(args[0])])); return result; }); }

function deleteWorkUpdate(...args) { return tx(() => { const before = get('SELECT * FROM updates WHERE id = ?', [Number(args[0])]); const result = deleteWorkUpdateImpl(...args); audit(args[1], 'deleteWorkUpdate', 'updates', Number(args[0]), before, get('SELECT * FROM updates WHERE id = ?', [Number(args[0])])); return result; }); }

function addUpdate(...args) { return tx(() => addUpdateImpl(...args)); }

function updateItemMeta(...args) { return tx(() => { const before = get('SELECT * FROM items WHERE id = ?', [Number(args[0])]); const result = updateItemMetaImpl(...args); audit(args[2], 'updateItemMeta', 'items', Number(args[0]), before, get('SELECT * FROM items WHERE id = ?', [Number(args[0])])); return result; }); }

function archiveItem(...args) { return tx(() => { const before = get('SELECT * FROM items WHERE id = ?', [Number(args[0])]); const result = archiveItemImpl(...args); audit(args[1], 'archiveItem', 'items', Number(args[0]), before, get('SELECT * FROM items WHERE id = ?', [Number(args[0])])); return result; }); }

return { listItems, canEditItem, canEditUpdate, getWorkUpdate, recalcItemState, getItemDetail, addUpdateRow, createItem, getDay, getSummary, getExportRows, updateWorkUpdate, deleteWorkUpdate, addUpdate, updateItemMeta, archiveItem };
};
