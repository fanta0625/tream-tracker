// Run in the foreground before redirecting server output. Never log the
// bootstrap password to the application's persistent log file.
process.env.INITIAL_ADMIN_PASSWORD = require('node:crypto').randomBytes(24).toString('base64url');
const db = require('../src/db');
if (db.createdInitialAdmin || db.rotatedDefaultAdmin) {
  process.stdout.write(`管理员账号：${db.createdInitialAdmin ? 'admin' : db.rotatedAdminUsernames.join('、')}\n`);
  process.stdout.write(`管理员临时密码：${process.env.INITIAL_ADMIN_PASSWORD}\n首次登录必须修改密码，请妥善保存。此密码不会再次显示。\n`);
}
delete process.env.INITIAL_ADMIN_PASSWORD;
