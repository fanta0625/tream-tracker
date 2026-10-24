module.exports = (app, { db, auth }) => {
  app.get('/api/admin/audit', auth.requireAdmin, (req, res) => res.json({ entries: db.listAudit(req.query) }));
  app.get('/api/admin/metrics', auth.requireAdmin, (req, res) => res.json({ ...require('../lib/observability').totals, uptime_seconds: Math.floor(process.uptime()), memory: process.memoryUsage() }));
  app.get('/api/drafts/:key', (req, res) => res.json({ draft: db.getDraft(req.user, req.params.key) }));
  app.put('/api/drafts/:key', (req, res) => { db.saveDraft(req.user, req.params.key, req.body); res.json({ ok: true }); });
  app.delete('/api/drafts/:key', (req, res) => { db.deleteDraft(req.user, req.params.key); res.json({ ok: true }); });
};
