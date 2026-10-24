const net = require('node:net');
const { RateLimiter } = require('./rate-limit');

function configureNetwork(app) {
  const host = process.env.HOST || '127.0.0.1';
  if (process.env.TRUST_PROXY === '1') throw new Error('请用 TRUSTED_PROXIES 指定可信代理 IP/CIDR，禁止信任所有代理');
  const proxies = (process.env.TRUSTED_PROXIES || '').split(',').map(v => v.trim()).filter(Boolean);
  for (const proxy of proxies) {
    const [address, prefix] = proxy.split('/');
    const family = net.isIP(address);
    if (!family || proxy.split('/').length > 2 || (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) < 1 || Number(prefix) > (family === 4 ? 32 : 128)))) {
      throw new Error('TRUSTED_PROXIES 必须是明确的代理 IP/CIDR，不能使用全网网段');
    }
  }
  if (proxies.length) app.set('trust proxy', proxies);
  const insecure = process.env.COOKIE_SECURE === '0';
  if (insecure && !['127.0.0.1', '::1', 'localhost'].includes(host)) {
    throw new Error('HTTP 开发模式只能监听回环地址；公网部署请使用 HTTPS 反向代理');
  }
  const publicOrigin = process.env.PUBLIC_ORIGIN ? new URL(process.env.PUBLIC_ORIGIN).origin : null;
  if (publicOrigin && !insecure && !publicOrigin.startsWith('https://')) throw new Error('PUBLIC_ORIGIN 必须使用 HTTPS');
  app.disable('x-powered-by');
  const limiter = new RateLimiter();
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    if (req.path === '/api/health') return next();
    if (!insecure && !req.secure) return res.status(400).json({ error: '请通过 HTTPS 访问' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const expected = publicOrigin || `${req.protocol}://${req.get('host')}`;
      if (req.get('sec-fetch-site') === 'cross-site' || (req.get('origin') && req.get('origin') !== expected)) {
        return res.status(403).json({ error: '不允许跨站请求' });
      }
    }
    if (req.path.startsWith('/api/')) {
      try {
        limiter.consume('global', 1200, 60000);
        limiter.consume(`ip:${req.ip}`, 300, 60000);
      } catch (error) { return next(error); }
    }
    next();
  });
  return host;
}

module.exports = { configureNetwork };
