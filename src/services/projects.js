module.exports = function createProjectService({ all, get, run, tx, nowIso, isDate, addDays, getGroup, isGroupMember, isGroupLeader, problem, checkVersion, assertProjectWritable, audit }) {
const REPORT_TYPES = ['daily', 'weekly'];
const VISIBILITIES = ['private', 'group', 'public'];

function validReportType(value, fallback = 'daily') {
  if (value === undefined || value === '') return fallback;
  if (!REPORT_TYPES.includes(value)) throw problem(400, '不合法的字段值');
  return value;
}

function validVisibility(value, fallback = 'group') {
  if (value === undefined || value === '') return fallback;
  if (!VISIBILITIES.includes(value)) throw problem(400, '不合法的字段值');
  return value;
}

function normalizeWeekStart(date) {
  const [y, m, d] = String(date).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = dt.getUTCDay();
  const diff = (day + 6) % 7;
  return addDays(date, -diff);
}

function canViewProject(user, project) {
  if (!user || !project) return false;
  if (user.role === 'admin') return true;
  return isGroupMember(user.id, project.group_id) || isGroupLeader(user.id, project.group_id);
}

function canManageProject(user, project) {
  if (!user || !project) return false;
  if (user.role === 'admin') return true;
  return isGroupLeader(user.id, project.group_id);
}

function canReportProject(user, project) {
  if (!user || !project) return false;
  if (user.role === 'admin') return true;
  return isGroupMember(user.id, project.group_id) || isGroupLeader(user.id, project.group_id);
}

function projectAccess(project, user) {
  return {
    ...project,
    report_count: Number(project.report_count || 0),
    can_manage: canManageProject(user, project),
    can_report: project.status === 'active' && canReportProject(user, project),
  };
}

function projectSelectSql(user) {
  const visible = user && user.role !== 'admin' ? ` AND (r.visibility != 'private' OR r.user_id = ${Number(user.id)})` : '';
  return `
    SELECT p.*, g.name AS group_name, u.display_name AS creator_name,
      (SELECT COUNT(*) FROM reports r WHERE r.project_id = p.id${visible}) AS report_count,
      (SELECT MAX(r.report_date) FROM reports r WHERE r.project_id = p.id${visible}) AS last_report_date
    FROM projects p
    JOIN groups g ON g.id = p.group_id
    LEFT JOIN users u ON u.id = p.created_by
  `;
}

function listProjects(user, filters = {}) {
  const where = [filters.status === 'archived' ? "p.status = 'archived'" : filters.status === 'all' ? '1=1' : "p.status = 'active'"];
  const params = [];
  if (user.role !== 'admin') {
    where.push(`(
      p.group_id IN (SELECT group_id FROM user_groups WHERE user_id = ?)
      OR p.group_id IN (SELECT id FROM groups WHERE leader_user_id = ?)
    )`);
    params.push(user.id, user.id);
  }
  const rows = all(`${projectSelectSql(user)} WHERE ${where.join(' AND ')} ORDER BY g.name, p.name`, params);
  return rows.map((row) => projectAccess(row, user));
}

function getProject(id, user) {
  const project = get(`${projectSelectSql(user)} WHERE p.id = ?`, [Number(id)]);
  if (!project) {
    const err = new Error('项目不存在');
    err.status = 404;
    throw err;
  }
  if (!canViewProject(user, project)) {
    const err = new Error('你没有权限查看该项目');
    err.status = 403;
    throw err;
  }
  return projectAccess(project, user);
}

function createProject(body = {}, user) {
  const groupId = Number(body.group_id);
  const group = getGroup(groupId);
  if (!group) {
    const err = new Error('请选择有效的组');
    err.status = 400;
    throw err;
  }
  if (user.role !== 'admin' && !isGroupLeader(user.id, groupId)) {
    const err = new Error('只有组长或管理员可以创建项目');
    err.status = 403;
    throw err;
  }
  const name = String(body.name || '').trim();
  if (!name) {
    const err = new Error('项目名称不能为空');
    err.status = 400;
    throw err;
  }
  try {
    const result = run(`
      INSERT INTO projects (group_id, name, description, status, created_by, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?, ?)
    `, [groupId, name, String(body.description || '').trim(), user.id, nowIso(), nowIso()]);
    return getProject(Number(result.lastInsertRowid), user);
  } catch (err) {
    if (String(err.message || '').includes('UNIQUE')) {
      const conflict = new Error('该组下已有同名项目');
      conflict.status = 409;
      throw conflict;
    }
    throw err;
  }
}

function updateProjectImpl(id, body = {}, user) {
  const project = getProject(id, user);
  checkVersion(project, body.version);
  if (project.status === 'archived' && body.status !== 'active') throw problem(409, '项目已归档，请先恢复项目');
  if (!project.can_manage) {
    const err = new Error('只有组长或管理员可以修改项目');
    err.status = 403;
    throw err;
  }
  const fields = [];
  const params = [];
  if (body.name !== undefined) {
    const name = String(body.name || '').trim();
    if (!name) {
      const err = new Error('项目名称不能为空');
      err.status = 400;
      throw err;
    }
    fields.push('name = ?');
    params.push(name);
  }
  if (body.description !== undefined) {
    fields.push('description = ?');
    params.push(String(body.description || '').trim());
  }
  if (body.status !== undefined) {
    if (!['active', 'archived'].includes(body.status)) {
      const err = new Error('项目状态不合法');
      err.status = 400;
      throw err;
    }
    fields.push('status = ?');
    params.push(body.status);
  }
  if (!fields.length) return project;
  fields.push('updated_at = ?', 'version = version + 1');
  params.push(nowIso(), Number(id));
  try {
    run(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`, params);
  } catch (err) {
    if (String(err.message || '').includes('UNIQUE')) {
      const conflict = new Error('该组下已有同名项目');
      conflict.status = 409;
      throw conflict;
    }
    throw err;
  }
  return getProject(id, user);
}

function archiveProject(id, user) {
  return updateProject(id, { status: 'archived' }, user);
}

function listReports(projectId, user, filters = {}) {
  const project = getProject(projectId, user);
  const where = ['r.project_id = ?'];
  const params = [project.id];

  if (filters.type && REPORT_TYPES.includes(filters.type)) {
    where.push('r.type = ?');
    params.push(filters.type);
  }
  if (filters.from && isDate(filters.from)) {
    where.push('r.report_date >= ?');
    params.push(filters.from);
  }
  if (filters.to && isDate(filters.to)) {
    where.push('r.report_date <= ?');
    params.push(filters.to);
  }

  const groupMember = isGroupMember(user.id, project.group_id) || isGroupLeader(user.id, project.group_id);
  if (user.role !== 'admin') {
    if (groupMember) {
      where.push("(r.user_id = ? OR r.visibility IN ('group', 'public'))");
    } else {
      where.push("(r.user_id = ? OR r.visibility = 'public')");
    }
    params.push(user.id);
  }

  const reports = all(`
    SELECT r.*, u.display_name AS author_name, u.username AS author_username
    FROM reports r
    JOIN users u ON u.id = r.user_id
    WHERE ${where.join(' AND ')}
    ORDER BY r.report_date DESC, r.created_at DESC, r.id DESC
    ${filters.limit ? 'LIMIT ? OFFSET ?' : ''}
  `, filters.limit ? [...params, Number(filters.limit), Number(filters.offset || 0)] : params).map((report) => ({
    ...report,
    can_edit: project.status === 'active' && (user.role === 'admin' || Number(report.user_id) === Number(user.id)),
  }));

  return { project, reports };
}

function getReport(id, user) {
  const report = get(`
    SELECT r.*, u.display_name AS author_name, u.username AS author_username,
      p.name AS project_name, p.group_id, p.status AS project_status
    FROM reports r
    JOIN users u ON u.id = r.user_id
    JOIN projects p ON p.id = r.project_id
    WHERE r.id = ?
  `, [Number(id)]);
  if (!report) {
    const err = new Error('报告不存在');
    err.status = 404;
    throw err;
  }
  const canView = canViewProject(user, report);
  const isAuthor = Number(report.user_id) === Number(user.id);
  if (!canView && !isAuthor && report.visibility !== 'public') {
    const err = new Error('你没有权限查看该报告');
    err.status = 403;
    throw err;
  }
  const project = canView ? getProject(report.project_id, user) : { id: report.project_id, name: report.project_name };
  if (report.visibility === 'private' && user.role !== 'admin' && Number(report.user_id) !== Number(user.id)) {
    const err = new Error('你没有权限查看该报告');
    err.status = 403;
    throw err;
  }
  return {
    ...report,
    project,
    can_edit: report.project_status === 'active' && canView && (user.role === 'admin' || Number(report.user_id) === Number(user.id)),
  };
}

function createReportImpl(projectId, body = {}, user) {
  const project = getProject(projectId, user);
  assertProjectWritable(project.id);
  if (!project.can_report) {
    const err = new Error('你不是该组组员，不能在此项目下写报告');
    err.status = 403;
    throw err;
  }

  const type = validReportType(body.type, 'daily');
  let reportDate = String(body.report_date || '').trim();
  if (!isDate(reportDate)) {
    const err = new Error('报告日期格式应为 YYYY-MM-DD');
    err.status = 400;
    throw err;
  }
  if (type === 'weekly') reportDate = normalizeWeekStart(reportDate);
  const visibility = validVisibility(body.visibility, 'group');

  const existing = get(
    'SELECT id FROM reports WHERE project_id = ? AND user_id = ? AND type = ? AND report_date = ?',
    [project.id, user.id, type, reportDate]
  );
  if (existing) {
    const err = new Error('该日期已有报告，请直接编辑');
    err.status = 409;
    throw err;
  }

  const now = nowIso();
  const result = run(`
    INSERT INTO reports
      (project_id, user_id, type, report_date, done, doing, blockers, next_plan, visibility, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    project.id,
    user.id,
    type,
    reportDate,
    String(body.done || '').trim(),
    String(body.doing || '').trim(),
    String(body.blockers || '').trim(),
    String(body.next_plan || '').trim(),
    visibility,
    now,
    now,
  ]);
  return getReport(Number(result.lastInsertRowid), user);
}

function updateReportImpl(id, body = {}, user) {
  const report = getReport(id, user);
  checkVersion(report, body.version);
  assertProjectWritable(report.project_id);
  if (!canViewProject(user, report)) throw problem(403, '离组后报告只读');
  if (!report.can_edit) {
    const err = new Error('只有作者或管理员可以修改报告');
    err.status = 403;
    throw err;
  }

  const type = body.type !== undefined ? validReportType(body.type, report.type) : report.type;
  let reportDate = body.report_date !== undefined ? String(body.report_date || '').trim() : report.report_date;
  if (!isDate(reportDate)) {
    const err = new Error('报告日期格式应为 YYYY-MM-DD');
    err.status = 400;
    throw err;
  }
  if (type === 'weekly') reportDate = normalizeWeekStart(reportDate);
  const visibility = body.visibility !== undefined ? validVisibility(body.visibility, report.visibility) : report.visibility;

  const duplicate = get(`
    SELECT id FROM reports
    WHERE project_id = ? AND user_id = ? AND type = ? AND report_date = ? AND id != ?
  `, [report.project_id, report.user_id, type, reportDate, report.id]);
  if (duplicate) {
    const err = new Error('该日期已有报告');
    err.status = 409;
    throw err;
  }

  run(`
    UPDATE reports SET type = ?, report_date = ?, done = ?, doing = ?, blockers = ?, next_plan = ?,
      visibility = ?, updated_at = ?, version = version + 1
    WHERE id = ?
  `, [
    type,
    reportDate,
    body.done !== undefined ? String(body.done || '').trim() : report.done,
    body.doing !== undefined ? String(body.doing || '').trim() : report.doing,
    body.blockers !== undefined ? String(body.blockers || '').trim() : report.blockers,
    body.next_plan !== undefined ? String(body.next_plan || '').trim() : report.next_plan,
    visibility,
    nowIso(),
    report.id,
  ]);
  return getReport(report.id, user);
}

function deleteReportImpl(id, user) {
  const report = getReport(id, user);
  assertProjectWritable(report.project_id);
  if (!canViewProject(user, report)) throw problem(403, '离组后报告只读');
  if (!report.can_edit) {
    const err = new Error('只有作者或管理员可以删除报告');
    err.status = 403;
    throw err;
  }
  run('DELETE FROM reports WHERE id = ?', [report.id]);
  return { ok: true };
}


function listPublicReports(user, filters = {}) {
  const where = ["r.visibility = 'public'", "p.status = 'active'"];
  const params = [];
  if (filters.type && REPORT_TYPES.includes(filters.type)) {
    where.push('r.type = ?');
    params.push(filters.type);
  }
  if (filters.from && isDate(filters.from)) {
    where.push('r.report_date >= ?');
    params.push(filters.from);
  }
  if (filters.to && isDate(filters.to)) {
    where.push('r.report_date <= ?');
    params.push(filters.to);
  }
  return all(`
    SELECT r.*, u.display_name AS author_name, u.username AS author_username,
      p.name AS project_name, p.group_id, g.name AS group_name
    FROM reports r
    JOIN users u ON u.id = r.user_id
    JOIN projects p ON p.id = r.project_id
    JOIN groups g ON g.id = p.group_id
    WHERE ${where.join(' AND ')}
    ORDER BY r.report_date DESC, r.created_at DESC, r.id DESC
    LIMIT 200
  `, params).map((report) => ({
    ...report,
    can_edit: user.role === 'admin' || Number(report.user_id) === Number(user.id),
  }));
}



function updateProject(...args) { return tx(() => { const before = get('SELECT * FROM projects WHERE id = ?', [Number(args[0])]); const result = updateProjectImpl(...args); audit(args[2], 'updateProject', 'projects', Number(args[0]), before, get('SELECT * FROM projects WHERE id = ?', [Number(args[0])])); return result; }); }

function createReport(...args) { return tx(() => createReportImpl(...args)); }

function updateReport(...args) { return tx(() => { const before = get('SELECT * FROM reports WHERE id = ?', [Number(args[0])]); const result = updateReportImpl(...args); audit(args[2], 'updateReport', 'reports', Number(args[0]), before, get('SELECT * FROM reports WHERE id = ?', [Number(args[0])])); return result; }); }

function deleteReport(...args) { return tx(() => { const before = get('SELECT * FROM reports WHERE id = ?', [Number(args[0])]); const result = deleteReportImpl(...args); audit(args[1], 'deleteReport', 'reports', Number(args[0]), before, get('SELECT * FROM reports WHERE id = ?', [Number(args[0])])); return result; }); }

return { validReportType, validVisibility, normalizeWeekStart, canViewProject, canManageProject, canReportProject, projectAccess, projectSelectSql, listProjects, getProject, createProject, archiveProject, listReports, getReport, listPublicReports, updateProject, createReport, updateReport, deleteReport, REPORT_TYPES, VISIBILITIES };
};
