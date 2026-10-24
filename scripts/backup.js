const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const config = require('../src/config');

function digest(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function backup() {
  const source = path.join(config.dataDir, 'tracker.db');
  const secret = path.join(config.dataDir, 'session.secret');
  if (!fs.existsSync(source) || !fs.existsSync(secret)) throw new Error('数据库和密钥必须同时存在');
  const target = path.join(config.backupDir, `snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(source, { readOnly: true });
  try { db.prepare('VACUUM INTO ?').run(path.join(target, 'tracker.db')); } finally { db.close(); }
  fs.copyFileSync(secret, path.join(target, 'session.secret'));
  const manifest = { created_at: new Date().toISOString(), files: {} };
  for (const file of ['tracker.db', 'session.secret']) {
    fs.chmodSync(path.join(target, file), 0o600);
    manifest.files[file] = digest(path.join(target, file));
  }
  fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  if (process.env.BACKUP_MIRROR_DIR) fs.cpSync(target, path.join(path.resolve(process.env.BACKUP_MIRROR_DIR), path.basename(target)), { recursive: true, errorOnExist: true, force: false });
  const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS || 14);
  if (!Number.isInteger(retentionDays) || retentionDays < 1) throw new Error('BACKUP_RETENTION_DAYS 必须为正整数');
  for (const entry of fs.readdirSync(config.backupDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^snapshot-\d{4}-/.test(entry.name)) continue;
    const candidate = path.join(config.backupDir, entry.name);
    if (candidate === target || !fs.existsSync(path.join(candidate, 'manifest.json'))) continue;
    const old = JSON.parse(fs.readFileSync(path.join(candidate, 'manifest.json'), 'utf8'));
    if (Date.parse(old.created_at) < Date.now() - retentionDays * 86400000) fs.rmSync(candidate, { recursive: true });
  }
  return target;
}
function verify(source) {
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'));
  for (const file of ['tracker.db', 'session.secret']) if (digest(path.join(source, file)) !== manifest.files[file]) throw new Error(`备份校验失败：${file}`);
  const db = new DatabaseSync(path.join(source, 'tracker.db'), { readOnly: true });
  try {
    if (Object.values(db.prepare('PRAGMA integrity_check').get())[0] !== 'ok') throw new Error('数据库完整性检查失败');
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('数据库外键检查失败');
  } finally { db.close(); }
}
function restore(source, target) {
  source = path.resolve(source); target = path.resolve(target);
  verify(source);
  if (fs.existsSync(target) && fs.readdirSync(target).length) throw new Error('恢复目标必须为不存在或空目录，禁止覆盖运行中的数据');
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const file of ['tracker.db', 'session.secret']) { fs.copyFileSync(path.join(source, file), path.join(target, file)); fs.chmodSync(path.join(target, file), 0o600); }
}
if (require.main === module) {
  try {
    if (process.argv[2] === 'restore') {
      if (!process.argv[3] || !process.argv[4]) throw new Error('用法：node scripts/backup.js restore <备份目录> <空恢复目录>');
      restore(process.argv[3], process.argv[4]); console.log('恢复完成，请使用新目录验证后再切换服务');
    } else if (process.argv[2] === 'verify') { verify(process.argv[3]); console.log('备份校验通过'); }
    else console.log(backup());
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { backup, restore, verify };
