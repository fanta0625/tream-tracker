let active = 0;
module.exports = (req, res, next) => {
  if (active >= 2) return res.status(429).set('Retry-After', '10').json({ error: '导出繁忙，请稍后再试' });
  active++;
  let released = false;
  const release = () => { if (!released) { released = true; active--; } };
  res.once('finish', release);
  res.once('close', release);
  next();
};
