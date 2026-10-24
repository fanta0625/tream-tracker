const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { dataDir } = require('../src/config');
const file = path.join(dataDir, 'tracker.db');
if (!fs.existsSync(file) || process.argv.length !== 3) { console.error('用法：停止服务后 node scripts/recover-admin.js <管理员用户名>'); process.exit(1); }
const db = new DatabaseSync(file);
try {
  const user = db.prepare("SELECT id FROM users WHERE username = ? AND role = 'admin'").get(process.argv[2]);
  if (!user) throw new Error('管理员不存在');
  const password = crypto.randomBytes(24).toString('base64url');
  const hash = require('../src/security').hashPassword(password);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("UPDATE users SET password_hash = ?, status = 'active', active = 1, must_change_password = 1, session_version = session_version + 1 WHERE id = ?").run(hash, user.id);
    db.prepare("INSERT INTO audit_log(action, entity, entity_id, created_at) VALUES ('localAdminRecovery', 'users', ?, ?)").run(user.id, new Date().toISOString());
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  console.log(`管理员临时密码：${password}\n首次登录必须改密。`);
} finally { db.close(); }
