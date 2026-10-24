module.exports = (app, { db, auth, handle, HttpError, canEdit, itemWithAccess, resolveRange, buildMarkdown, buildWorkbook, buildReportsMarkdown, buildReportsWorkbook }) => {
const exportGuard = require('../lib/export-guard');
app.get('/api/items', (req, res) => {
  const page = require('../lib/validation').pagination(req.query);
  const items = db.listItems({ ...req.query, limit: page.limit + 1, offset: page.offset }).map((item) => ({ ...item, can_edit: canEdit(req.user, item) }));
  res.json({ items: items.slice(0, page.limit), page: page.page, has_more: items.length > page.limit });
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
  const existing = db.getItemDetail(req.params.id, req.user);
  if (!canEdit(req.user, existing)) return res.status(403).json({ error: '你没有权限修改该事项' });
  if (req.body && req.body.member_id !== undefined && !auth.isLeader(req.user)) {
    return res.status(403).json({ error: '只有组长或管理员可以转移负责人' });
  }
  const item = db.updateItemMeta(req.params.id, req.body || {}, req.user);
  item.can_edit = true;
  res.json({ item });
});

app.post('/api/items/:id/updates', (req, res) => {
  const existing = db.getItemDetail(req.params.id, req.user);
  if (!canEdit(req.user, existing)) return res.status(403).json({ error: '你没有权限更新该事项' });
  const item = db.addUpdate(req.params.id, req.body || {}, req.user);
  item.can_edit = true;
  res.status(201).json({ item });
});

app.delete('/api/items/:id', (req, res) => {
  const existing = db.getItemDetail(req.params.id, req.user);
  if (!canEdit(req.user, existing)) return res.status(403).json({ error: '你没有权限归档该事项' });
  res.json(db.archiveItem(req.params.id, req.user));
});


app.get('/api/updates/:id', (req, res) => {
  res.json(db.getWorkUpdate(req.params.id, req.user));
});

app.patch('/api/updates/:id', (req, res) => {
  res.json(db.updateWorkUpdate(req.params.id, req.body || {}, req.user));
});

app.delete('/api/updates/:id', (req, res) => {
  res.json(db.deleteWorkUpdate(req.params.id, req.user));
});

app.get('/api/day', (req, res) => {
  const date = req.query.date || db.todayStr();
  if (!db.isDate(date)) throw new HttpError(400, '日期格式应为 YYYY-MM-DD');
  res.json(db.getDay(date, req.user));
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

app.get('/api/export/markdown', exportGuard, handle(async (req, res) => {
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

app.get('/api/export/xlsx', exportGuard, handle(async (req, res) => {
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


};
