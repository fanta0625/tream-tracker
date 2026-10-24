function bad(message) { return Object.assign(new Error(message), { status: 400 }); }
function pagination(query) {
  const page = Number(query.page || 1), limit = Number(query.limit || 50);
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw bad('分页参数不合法');
  return { page, limit, offset: (page - 1) * limit };
}
function validateRequest(req, res, next) {
  try {
    const body = req.body || {};
    if (typeof body !== 'object' || Array.isArray(body)) throw bad('请求体必须为对象');
    for (const [key, value] of Object.entries({ ...req.query, ...body })) {
      if (['member_id', 'group_id', 'project_id', 'leader_user_id', 'version'].includes(key) && value !== null && value !== '') {
        if (!Number.isSafeInteger(Number(value)) || Number(value) < 1) throw bad(`${key} 必须为正整数`);
      }
      if (['date', 'from', 'to', 'update_date', 'report_date', 'start_date', 'due_date'].includes(key) && value) {
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !require('../db').isDate(value)) throw bad('日期格式或日期值不合法');
      }
      if (typeof value === 'string' && value.length > (['done', 'doing', 'blockers', 'next_plan', 'note', 'description'].includes(key) ? 20000 : 500)) throw bad(`${key} 内容过长`);
      if (['type', 'visibility', 'priority'].includes(key) && value && !({ type: ['daily', 'weekly'], visibility: ['private', 'group', 'public'], priority: ['high', 'medium', 'low'] }[key].includes(value))) throw bad(`${key} 不合法`);
    }
    if (req.method === 'PATCH' && /^\/(items|reports|projects|updates)\/\d+$/.test(req.path) && body.version === undefined) throw Object.assign(new Error('请提供当前版本号后再修改'), { status: 428 });
    if (req.query.status && (req.path === '/items' || req.path === '/projects')) {
      const statuses = req.path === '/items' ? ['todo', 'doing', 'paused', 'blocked', 'done'] : ['active', 'archived', 'all'];
      if (!statuses.includes(req.query.status)) throw bad('状态筛选不合法');
    }
    const segments = req.path.split('/');
    for (let i = 1; i < segments.length; i++) {
      if (['projects', 'reports', 'items', 'updates', 'users', 'groups', 'registrations'].includes(segments[i - 1]) && segments[i] && !['public', 'export'].includes(segments[i]) && (!/^[1-9]\d*$/.test(segments[i]) || !Number.isSafeInteger(Number(segments[i])))) throw bad('ID 不合法');
    }
    next();
  } catch (error) { next(error); }
}
module.exports = { pagination, validateRequest };
