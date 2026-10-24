const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-benchmark-'));
process.env.INITIAL_ADMIN_PASSWORD = 'Benchmark-password-2026';
process.env.SEED_DEMO = '0';
const db = require('../src/db');
const { DatabaseSync } = require('node:sqlite');
const raw = new DatabaseSync(db.DB_PATH);
const member = db.createMember({ name: 'Benchmark' });
const count = Number(process.env.BENCH_ITEMS || 5000);
const today = db.todayStr();
const now = new Date().toISOString();
raw.exec('BEGIN');
const item = raw.prepare("INSERT INTO items(member_id,title,status,progress,start_date,created_at,updated_at) VALUES (?,?,'doing',50,?,?,?)");
const update = raw.prepare("INSERT INTO updates(item_id,member_id,update_date,status,progress,note,created_at,updated_at) VALUES (?, ?, ?, 'doing', 50, 'benchmark', ?, ?)");
for (let i = 0; i < count; i++) {
  const id = Number(item.run(member.id, `Task ${i}`, today, now, now).lastInsertRowid);
  update.run(id, member.id, today, now, now);
}
raw.exec('COMMIT'); raw.close();
const results = {};
function measure(name, fn) {
  const values = [];
  for (let i = 0; i < 10; i++) { const start = performance.now(); fn(); values.push(performance.now() - start); }
  values.sort((a, b) => a - b);
  results[name] = { p50_ms: +values[5].toFixed(2), p95_ms: +values[9].toFixed(2) };
}
(async () => {
  measure('items_page_50', () => db.listItems({ limit: 50, offset: 0 }));
  measure('daily_view', () => db.getDay(today, db.getUserByUsername('admin')));
  measure('summary', () => db.getSummary(today, today));
  const start = performance.now();
  const { workbook } = await require('../src/services/exports').buildWorkbook({ from: today, to: today });
  const buffer = await workbook.xlsx.writeBuffer();
  results.xlsx = { duration_ms: +(performance.now() - start).toFixed(2), bytes: buffer.length };
  console.log(JSON.stringify({ node: process.version, items: count, updates: count, results, rss_mb: +(process.memoryUsage().rss / 1048576).toFixed(1) }, null, 2));
  db.close();
})().catch(error => { console.error(error); process.exitCode = 1; });
