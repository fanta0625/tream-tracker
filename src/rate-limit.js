const crypto = require('node:crypto');

// Fixed-size keys, expiring entries and a hard cap prevent attacker-controlled
// identifiers from turning the limiter into an unbounded memory allocation.
class RateLimiter {
  constructor({ maxEntries = 10000, now = Date.now } = {}) {
    this.entries = new Map();
    this.maxEntries = maxEntries;
    this.now = now;
    this.lastSweep = 0;
  }

  consume(key, limit, windowMs) {
    const now = this.now();
    if (now - this.lastSweep >= 60000) {
      for (const [id, entry] of this.entries) {
        if (entry.expires <= now) this.entries.delete(id);
      }
      this.lastSweep = now;
    }
    const id = crypto.createHash('sha256').update(key).digest('hex');
    let entry = this.entries.get(id);
    if (entry && entry.expires <= now) {
      this.entries.delete(id);
      entry = null;
    }
    if ((!entry && this.entries.size >= this.maxEntries) || (entry && entry.count >= limit)) {
      const error = new Error('请求过于频繁，请稍后再试');
      error.status = 429;
      throw error;
    }
    if (!entry) {
      entry = { count: 0, expires: now + windowMs };
      this.entries.set(id, entry);
    }
    entry.count += 1;
  }

  refund(key) {
    const id = crypto.createHash('sha256').update(key).digest('hex');
    const entry = this.entries.get(id);
    if (entry && entry.expires > this.now()) entry.count = Math.max(0, entry.count - 1);
  }
}

module.exports = { RateLimiter };
