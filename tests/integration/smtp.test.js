const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('SMTP 协议联调仅连接本地接收器', async t => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-smtp-'));
  process.env.INITIAL_ADMIN_PASSWORD = 'SMTP-test-password';
  process.env.SEED_DEMO = '0';
  let received = '';
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.write('220 localhost test SMTP\r\n');
    let buffer = '', data = false;
    socket.on('data', chunk => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 2);
        if (data) {
          if (line === '.') { data = false; socket.write('250 queued\r\n'); }
          else received += line + '\n';
        } else if (/^EHLO/.test(line)) socket.write('250-localhost\r\n250 SIZE 1000000\r\n');
        else if (/^DATA/.test(line)) { data = true; socket.write('354 send data\r\n'); }
        else if (/^QUIT/.test(line)) socket.end('221 bye\r\n');
        else socket.write('250 OK\r\n');
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_PORT = String(server.address().port);
  process.env.SMTP_SECURE = 'none';
  process.env.SMTP_FROM = 'sender@example.invalid';
  delete process.env.SMTP_USER; delete process.env.SMTP_PASS;
  await require('../../src/mailer').sendVerificationCode('recipient@example.invalid', '654321');
  assert.match(received, /recipient@example.invalid/);
  assert(received.length > 100);
});
