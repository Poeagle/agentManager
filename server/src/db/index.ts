import Database from 'better-sqlite3';
import { dirname, join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { config } from '../config.js';

let db: Database.Database;
const SCHEMA_VERSION = 2;

function tableColumns(table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function addColumn(table: string, column: string, definition: string): void {
  if (tableColumns(table).has(column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function createCurrentSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'member',
      disabled INTEGER NOT NULL DEFAULT 0,
      max_tabs INTEGER NOT NULL DEFAULT 10,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      description TEXT,
      session_prompt TEXT,
      openclaw_prompt TEXT,
      default_web_url TEXT,
      color TEXT DEFAULT '',
      owner_id TEXT REFERENCES users(id),
      skip_permissions INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id),
      task TEXT NOT NULL,
      created_by_user_id TEXT REFERENCES users(id),
      mode TEXT NOT NULL DEFAULT 'session',
      agent_type TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      pid INTEGER,
      started_at TEXT,
      completed_at TEXT,
      exit_code INTEGER,
      claude_session_id TEXT,
      codex_session_id TEXT,
      cli_type TEXT DEFAULT 'claude',
      terminal_cols INTEGER DEFAULT 120,
      terminal_rows INTEGER DEFAULT 40,
      external_socket TEXT,
      pre_popout_cols INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT REFERENCES sessions(id),
      project_id TEXT REFERENCES projects(id),
      type TEXT NOT NULL,
      tool_name TEXT,
      data TEXT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id),
      title TEXT NOT NULL,
      description TEXT,
      priority INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'queued',
      session_id TEXT REFERENCES sessions(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS pty_output (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS session_snapshots (
      session_id TEXT PRIMARY KEY,
      cols INTEGER NOT NULL DEFAULT 120,
      rows INTEGER NOT NULL DEFAULT 40,
      rendered TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_ui_state (
      user_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, key)
    );

    CREATE TABLE IF NOT EXISTS project_user_access (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      can_session INTEGER NOT NULL DEFAULT 1,
      can_agent INTEGER NOT NULL DEFAULT 1,
      can_terminal INTEGER NOT NULL DEFAULT 1,
      can_claude INTEGER NOT NULL DEFAULT 1,
      can_codex INTEGER NOT NULL DEFAULT 1,
      granted_by TEXT REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (project_id, user_id)
    );

  `);
}

function createCurrentIndexes(): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id);
    CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id);
    CREATE INDEX IF NOT EXISTS idx_project_user_access_user ON project_user_access(user_id);
    CREATE INDEX IF NOT EXISTS idx_project_user_access_project ON project_user_access(project_id);
    CREATE INDEX IF NOT EXISTS idx_pty_output_session_seq ON pty_output(session_id, seq);
  `);
}

function migrateLegacySchema(): void {
  addColumn('sessions', 'claude_session_id', 'TEXT');
  addColumn('sessions', 'terminal_cols', 'INTEGER DEFAULT 120');
  addColumn('sessions', 'external_socket', 'TEXT');
  addColumn('sessions', 'pre_popout_cols', 'INTEGER');
  addColumn('sessions', 'cli_type', "TEXT DEFAULT 'claude'");
  addColumn('sessions', 'codex_session_id', 'TEXT');
  addColumn('sessions', 'created_by_user_id', 'TEXT REFERENCES users(id)');
  addColumn('sessions', 'mode', "TEXT DEFAULT 'session'");
  addColumn('sessions', 'agent_type', 'TEXT');
  addColumn('users', 'max_tabs', 'INTEGER NOT NULL DEFAULT 10');

  const projectColumns = tableColumns('projects');
  addColumn('projects', 'session_prompt', 'TEXT');
  addColumn('projects', 'openclaw_prompt', 'TEXT');
  addColumn('projects', 'default_web_url', 'TEXT');
  addColumn('projects', 'color', "TEXT DEFAULT ''");
  addColumn('projects', 'owner_id', 'TEXT REFERENCES users(id)');
  addColumn('projects', 'skip_permissions', 'INTEGER DEFAULT 0');
  addColumn('events', 'project_id', 'TEXT REFERENCES projects(id)');

  // Copy legacy prompt values instead of renaming columns in an order that can
  // silently strand data when more than one historical column exists.
  if (projectColumns.has('ruflo_prompt')) {
    db.exec(`UPDATE projects SET session_prompt = ruflo_prompt
      WHERE (session_prompt IS NULL OR session_prompt = '') AND ruflo_prompt IS NOT NULL`);
  }
  if (projectColumns.has('claude_flow_prompt')) {
    db.exec(`UPDATE projects SET session_prompt = claude_flow_prompt
      WHERE (session_prompt IS NULL OR session_prompt = '') AND claude_flow_prompt IS NOT NULL`);
  }

  db.exec("UPDATE sessions SET mode = 'session' WHERE mode IS NULL OR mode = ''");

  const ownerRows = db.prepare('SELECT id, owner_id FROM projects WHERE owner_id IS NOT NULL').all() as Array<{ id: string; owner_id: string }>;
  const grant = db.prepare(`
    INSERT OR IGNORE INTO project_user_access
      (project_id, user_id, can_session, can_agent, can_terminal, can_claude, can_codex)
    VALUES (?, ?, 1, 1, 1, 1, 1)
  `);
  for (const row of ownerRows) grant.run(row.id, row.owner_id);
}

function migrateTerminalDimensionsAndOutputKeys(): void {
  addColumn('sessions', 'terminal_rows', 'INTEGER DEFAULT 40');
  db.exec('UPDATE sessions SET terminal_rows = 40 WHERE terminal_rows IS NULL OR terminal_rows < 1');

  // Older reconnect races could write the same sequence more than once. Keep the
  // newest row before enforcing the invariant used by replay.
  db.exec(`
    DELETE FROM pty_output
    WHERE id NOT IN (
      SELECT MAX(id) FROM pty_output GROUP BY session_id, seq
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pty_output_session_seq_unique
      ON pty_output(session_id, seq);
  `);
}

function runMigrations(): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current > SCHEMA_VERSION) {
    throw new Error(`Database schema version ${current} is newer than supported version ${SCHEMA_VERSION}`);
  }

  const migrate = db.transaction(() => {
    createCurrentSchema();
    if (current < 1) migrateLegacySchema();
    if (current < 2) migrateTerminalDimensionsAndOutputKeys();
    createCurrentIndexes();
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  });
  migrate();
}

function backupBeforeMigration(): string {
  const suffix = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${config.dbPath}.pre-v${SCHEMA_VERSION}-${suffix}.bak`;
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.prepare('VACUUM INTO ?').run(backupPath);
  return backupPath;
}

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

/** Close the current connection. Primarily used by isolated tests and graceful tooling. */
export function closeDb(): void {
  if (!db) return;
  db.close();
  db = undefined as unknown as Database.Database;
}

export function initDb(): void {
  mkdirSync(dirname(config.dbPath), { recursive: true, mode: 0o700 });
  const databaseExisted = existsSync(config.dbPath);
  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');

  try {
    const currentVersion = db.pragma('user_version', { simple: true }) as number;
    if (databaseExisted && currentVersion < SCHEMA_VERSION) {
      const backupPath = backupBeforeMigration();
      console.log(`📦 Database backup created before migration: ${backupPath}`);
    }
    runMigrations();
  } catch (error) {
    db.close();
    db = undefined as unknown as Database.Database;
    throw new Error('Database migration failed; no partial migration was committed', { cause: error });
  }

  // Note: orphaned process cleanup is handled by cleanupStaleRunningSessions()
  // which is called after initDb() in index.ts — it kills processes AND marks DB records.

  // Migrate projects from dev-swarm.db if agentmanager.db is empty (one-time
  // migration from an old development setup)
  migrateProjectsFromDevSwarm();

  console.log('📦 Database initialized');
}

function migrateProjectsFromDevSwarm(): void {
  const count = (db.prepare('SELECT COUNT(*) as n FROM projects').get() as { n: number }).n;
  if (count > 0) return; // already has projects, nothing to migrate

  const devSwarmPath = join(dirname(config.dbPath), 'dev-swarm.db');
  if (!existsSync(devSwarmPath)) return;

  try {
    const src = new Database(devSwarmPath, { readonly: true });

    // Source DB may have ruflo_prompt or session_prompt depending on version
    let projects: Array<Record<string, unknown>>;
    try {
      projects = src.prepare(
        'SELECT id, name, path, description, created_at, updated_at, session_prompt, openclaw_prompt, default_web_url FROM projects'
      ).all() as Array<Record<string, unknown>>;
    } catch {
      // Fallback: old schema with ruflo_prompt
      projects = src.prepare(
        'SELECT id, name, path, description, created_at, updated_at, ruflo_prompt AS session_prompt, openclaw_prompt, default_web_url FROM projects'
      ).all() as Array<Record<string, unknown>>;
    }

    // Only migrate sessions whose project_id exists in the projects we're bringing over
    const projectIds = projects.map((p) => p.id as string);
    const sessions = projectIds.length > 0
      ? src.prepare(
          `SELECT id, project_id, task, status, pid, started_at, completed_at, exit_code,
                  created_at, updated_at, claude_session_id, terminal_cols, external_socket,
                  pre_popout_cols, cli_type
           FROM sessions WHERE project_id IN (${projectIds.map(() => '?').join(',')})`
        ).all(...projectIds) as Array<Record<string, unknown>>
      : [];

    src.close();

    if (projects.length === 0) return;

    const insertProject = db.prepare(
      `INSERT OR IGNORE INTO projects (id, name, path, description, created_at, updated_at, session_prompt, openclaw_prompt, default_web_url)
       VALUES (@id, @name, @path, @description, @created_at, @updated_at, @session_prompt, @openclaw_prompt, @default_web_url)`
    );
    const insertSession = db.prepare(
      `INSERT OR IGNORE INTO sessions (id, project_id, task, status, pid, started_at, completed_at, exit_code,
                                       created_at, updated_at, claude_session_id, terminal_cols, external_socket,
                                       pre_popout_cols, cli_type)
       VALUES (@id, @project_id, @task, @status, @pid, @started_at, @completed_at, @exit_code,
               @created_at, @updated_at, @claude_session_id, @terminal_cols, @external_socket,
               @pre_popout_cols, @cli_type)`
    );

    const tx = db.transaction(() => {
      for (const row of projects) insertProject.run(row);
      for (const row of sessions) insertSession.run(row);
    });
    tx();

    console.log(`📦 Migrated ${projects.length} project(s) and ${sessions.length} session(s) from dev-swarm.db`);
  } catch (err) {
    console.warn('⚠️  Failed to migrate projects from dev-swarm.db:', err);
  }
}
