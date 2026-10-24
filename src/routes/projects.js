module.exports = (app, { db, auth, handle, HttpError, canEdit, itemWithAccess, resolveRange, buildMarkdown, buildWorkbook, buildReportsMarkdown, buildReportsWorkbook }) => {
const exportGuard = require('../lib/export-guard');
app.get('/api/projects', (req, res) => {
  res.json({ projects: db.listProjects(req.user, req.query) });
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

app.get('/api/projects/:id/reports/export', exportGuard, handle(async (req, res) => {
  const format = req.query.format === 'xlsx' ? 'xlsx' : 'markdown';
  const { project, reports } = db.listReports(req.params.id, req.user, {
    type: req.query.type,
    from: req.query.from,
    to: req.query.to,
    limit: 10001,
  });
  if (reports.length > 10000) throw new HttpError(413, '报告过多，请缩小导出日期范围');
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
  const page = require('../lib/validation').pagination(req.query);
  const data = db.listReports(req.params.id, req.user, { ...req.query, limit: page.limit + 1, offset: page.offset });
  res.json({ ...data, reports: data.reports.slice(0, page.limit), page: page.page, has_more: data.reports.length > page.limit });
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


};
