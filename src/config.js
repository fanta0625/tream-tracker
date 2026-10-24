const path = require('node:path');
const root = path.resolve(__dirname, '..');
module.exports = Object.freeze({
  root,
  publicDir: path.join(root, 'public'),
  dataDir: path.resolve(process.env.DATA_DIR || path.join(root, 'data')),
  backupDir: path.resolve(process.env.BACKUP_DIR || path.join(root, 'backups')),
  port: Number(process.env.PORT || 3100),
  timezone: process.env.TZ || 'Asia/Shanghai',
});
