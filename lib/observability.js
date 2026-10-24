const crypto = require('node:crypto');
const totals = { requests: 0, errors: 0, rate_limited: 0 };
function requests(req, res, next) {
  const start = performance.now();
  const id = crypto.randomUUID();
  res.setHeader('X-Request-ID', id);
  res.on('finish', () => {
    totals.requests++;
    if (res.statusCode >= 500) totals.errors++;
    if (res.statusCode === 429) totals.rate_limited++;
    if (process.env.REQUEST_LOG === '1') console.log(JSON.stringify({ request_id: id, method: req.method, path: req.path, status: res.statusCode, duration_ms: Math.round(performance.now() - start) }));
  });
  next();
}
module.exports = { requests, totals };
