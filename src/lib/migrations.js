module.exports = function migrate(db) {
const all = (sql) => db.prepare(sql).all();
const run = (sql) => db.prepare(sql).run();
db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
function migration(version, apply) {
 if (db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(version)) return;
 db.exec("BEGIN IMMEDIATE");
 try { apply(); db.prepare("INSERT INTO schema_migrations VALUES (?, ?)").run(version, new Date().toISOString()); db.exec("COMMIT"); }
 catch (error) { db.exec("ROLLBACK"); throw error; }
}
migration(1, () => {
db.exec(`
  CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    member_id INTEGER REFERENCES members(id),
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    last_login_at TEXT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_member_unique
    ON users(member_id) WHERE member_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    leader_user_id INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_groups (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, group_id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS email_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    purpose TEXT NOT NULL DEFAULT 'register',
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    used_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_email_codes_email ON email_codes(email, purpose);

  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL REFERENCES groups(id),
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_group_name ON projects(group_id, name);

  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    type TEXT NOT NULL DEFAULT 'daily',
    report_date TEXT NOT NULL,
    done TEXT NOT NULL DEFAULT '',
    doing TEXT NOT NULL DEFAULT '',
    blockers TEXT NOT NULL DEFAULT '',
    next_plan TEXT NOT NULL DEFAULT '',
    visibility TEXT NOT NULL DEFAULT 'group',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_unique
    ON reports(project_id, user_id, type, report_date);
  CREATE INDEX IF NOT EXISTS idx_reports_project_date ON reports(project_id, report_date);

  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER NOT NULL REFERENCES members(id),
    title TEXT NOT NULL,
    project TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo',
    progress INTEGER NOT NULL DEFAULT 0,
    priority TEXT NOT NULL DEFAULT 'medium',
    start_date TEXT,
    due_date TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    member_id INTEGER NOT NULL REFERENCES members(id),
    update_date TEXT NOT NULL,
    status TEXT NOT NULL,
    progress INTEGER NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_updates_date ON updates(update_date);
  CREATE INDEX IF NOT EXISTS idx_updates_item ON updates(item_id, update_date, id);
  CREATE INDEX IF NOT EXISTS idx_items_member ON items(member_id);
`);

function addColumnIfMissing(table, column, definition) {
  const columns = all(`PRAGMA table_info(${table})`);
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

addColumnIfMissing('items', 'created_by', 'INTEGER');
addColumnIfMissing('items', 'updated_by', 'INTEGER');
addColumnIfMissing('updates', 'actor_id', 'INTEGER');
addColumnIfMissing('updates', 'updated_at', 'TEXT');
addColumnIfMissing('updates', 'edited_by', 'INTEGER');
run('UPDATE updates SET updated_at = created_at WHERE updated_at IS NULL');
addColumnIfMissing('users', 'email', 'TEXT');
const hadUserStatus = all('PRAGMA table_info(users)').some(column => column.name === 'status');
addColumnIfMissing('users', 'status', "TEXT NOT NULL DEFAULT 'active'");
if (!hadUserStatus) run("UPDATE users SET status = CASE WHEN active = 1 THEN 'active' ELSE 'disabled' END");
addColumnIfMissing('users', 'session_version', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0');

db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users(email) WHERE email IS NOT NULL");
run("UPDATE users SET role = 'leader' WHERE role = 'manager'");
run("UPDATE users SET status = CASE WHEN active = 1 THEN 'active' ELSE 'disabled' END WHERE status IS NULL OR status = ''");
run("UPDATE users SET role = 'leader' WHERE role = 'member' AND id IN (SELECT leader_user_id FROM groups WHERE leader_user_id IS NOT NULL)");

});
migration(2, () => {

for (const table of ['items', 'reports', 'projects', 'updates']) db.exec(`ALTER TABLE ${table} ADD COLUMN version INTEGER NOT NULL DEFAULT 1`);
db.exec('ALTER TABLE items ADD COLUMN project_id INTEGER REFERENCES projects(id)');
db.exec('ALTER TABLE items ADD COLUMN archived_at TEXT');
db.exec("UPDATE items SET archived_at = updated_at WHERE archived = 1");
db.exec(`CREATE TABLE audit_log (
 id INTEGER PRIMARY KEY, actor_id INTEGER, action TEXT NOT NULL, entity TEXT NOT NULL,
 entity_id INTEGER, before_json TEXT, after_json TEXT, created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_created ON audit_log(created_at, id);
CREATE INDEX idx_items_project ON items(project_id);
CREATE INDEX idx_user_groups_group ON user_groups(group_id, user_id);
CREATE INDEX idx_reports_public ON reports(visibility, report_date, id);
CREATE TABLE report_drafts (
 user_id INTEGER NOT NULL REFERENCES users(id), draft_key TEXT NOT NULL,
 content TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(user_id, draft_key)
);`);
// Preserve original project text. Only unambiguous exact names can be linked.
db.exec(`UPDATE items SET project_id = (SELECT MIN(id) FROM projects WHERE name = items.project)
 WHERE project != '' AND (SELECT COUNT(*) FROM projects WHERE name = items.project) = 1`);

});
};
