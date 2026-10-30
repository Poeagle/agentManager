import Database from 'better-sqlite3';
import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { closeDb, getDb, initDb } from '../src/db/index.js';
import { createSession, createUser, getSessionUser } from '../src/auth.js';
import { createTestDatabase } from './helpers/database.js';

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

describe('database schema and durable session identity', () => {
  it('adds separate attachment storage to v18 while keeping sessions and login valid',()=>{
    const fixture=createTestDatabase();cleanup=fixture.cleanup;
    const user=createUser({username:'attachment-owner',password:'password1'}),token=createSession(user.id);
    getDb().prepare("INSERT INTO projects(id,name,path) VALUES('p','Keep','/tmp/attachment-migration')").run();
    getDb().prepare("INSERT INTO sessions(id,project_id,task,status) VALUES('s','p','Keep task','running')").run();
    getDb().exec('DROP TABLE conversation_attachments');getDb().pragma('user_version = 18');closeDb();initDb();
    expect(getSessionUser(token)?.id).toBe(user.id);expect(getDb().prepare("SELECT task,status FROM sessions WHERE id='s'").get()).toEqual({task:'Keep task',status:'running'});
    expect(getDb().prepare('SELECT COUNT(*) n FROM conversation_attachments').get()).toEqual({n:0});
    expect(getDb().pragma('user_version',{simple:true})).toBe(19);expect(readdirSync(fixture.dir).some(file=>file.includes('.pre-v19-'))).toBe(true);
  });
  it('removes retired browser configuration from v11 without losing projects, sessions, login or other tab state', () => {
    const database = createTestDatabase();
    cleanup = database.cleanup;
    const user = createUser({ username: 'browser-owner', password: 'password1' });
    const token = createSession(user.id);
    const db = getDb();
    db.exec('ALTER TABLE projects ADD COLUMN default_web_url TEXT');
    db.prepare(`INSERT INTO projects (id,name,path,session_prompt,color,default_web_url) VALUES ('p','Project','/tmp/browser-project','keep prompt','#123456','https://example.com')`).run();
    db.prepare(`INSERT INTO sessions (id,project_id,task,status,mode,created_by_user_id) VALUES ('s','p','keep session','running','terminal',?)`).run(user.id);
    const tabs = {
      terminalInstances: [{ id: 's', label: 'Terminal 1', customLabel: 'Investigation' }], activeTerminalId: null,
      terminalLabels: { s: 'Investigation' }, hiddenSessionIds: ['hidden'], explorerInstances: [{ id: 'files', label: 'Files' }],
      webPageInstances: [{ id: 'web', label: 'Preview', url: 'https://example.com' }], activeWebPageId: 'web',
    };
    db.prepare(`INSERT INTO user_ui_state (user_id,key,value) VALUES (?,'project:p',?)`).run(user.id, JSON.stringify(tabs));
    db.prepare(`INSERT INTO user_ui_state (user_id,key,value) VALUES (?,'project:corrupt','not-json')`).run(user.id);
    db.pragma('user_version = 11');
    closeDb();
    initDb();
    expect(getSessionUser(token)?.id).toBe(user.id);
    expect(getDb().prepare('SELECT name,session_prompt,color FROM projects WHERE id = ?').get('p')).toEqual({ name: 'Project', session_prompt: 'keep prompt', color: '#123456' });
    expect(getDb().prepare('SELECT task,status FROM sessions WHERE id = ?').get('s')).toEqual({ task: 'keep session', status: 'running' });
    expect((getDb().prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>).map((item) => item.name)).not.toContain('default_web_url');
    const state = getDb().prepare(`SELECT value FROM user_ui_state WHERE user_id = ? AND key = 'project:p'`).get(user.id) as { value: string };
    const { webPageInstances: _web, activeWebPageId: _active, ...retained } = tabs;
    expect(JSON.parse(state.value)).toEqual(retained);
    expect(getDb().prepare(`SELECT value FROM user_ui_state WHERE key = 'project:corrupt'`).get()).toEqual({ value: 'not-json' });
    const backup = readdirSync(database.dir).find((file) => file.includes('.pre-v19-') && file.endsWith('.bak'));
    expect(backup).toBeDefined();
    const original = new Database(join(database.dir, backup!), { readonly: true });
    try { expect(original.prepare('SELECT default_web_url FROM projects WHERE id = ?').get('p')).toEqual({ default_web_url: 'https://example.com' }); }
    finally { original.close(); }
  });
  it('adds daily execution windows to v7 while preserving existing schedules and login sessions', () => {
    const database = createTestDatabase();
    cleanup = database.cleanup;
    const user = createUser({ username: 'schedule-owner', password: 'password1' });
    const token = createSession(user.id);
    getDb().prepare("INSERT INTO projects (id,name,path) VALUES ('p','Project','/tmp/migration-project')").run();
    getDb().prepare(`INSERT INTO scheduled_tasks (id,user_id,project_id,name,prompt,schedule_kind,schedule_value,next_run_at,target_type) VALUES ('legacy',?,'p','Existing','keep','interval','30','2099-01-01T09:00:00.000Z','new')`).run(user.id);
    getDb().exec('ALTER TABLE scheduled_tasks DROP COLUMN daily_start_time; ALTER TABLE scheduled_tasks DROP COLUMN daily_end_time;');
    getDb().pragma('user_version = 7');
    closeDb();
    initDb();
    expect(getSessionUser(token)?.id).toBe(user.id);
    expect(getDb().prepare('SELECT enabled,next_run_at,daily_start_time,daily_end_time FROM scheduled_tasks WHERE id = ?').get('legacy')).toEqual({
      enabled: 1, next_run_at: '2099-01-01T09:00:00.000Z', daily_start_time: null, daily_end_time: null,
    });
    expect(readdirSync(database.dir).filter((file) => file.endsWith('.bak'))).toHaveLength(1);
  });
  it('creates native identity and per-user UI state columns', () => {
    ({ cleanup } = createTestDatabase());
    const db = getDb();
    const sessionColumns = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    expect(sessionColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'claude_session_id',
      'codex_session_id',
      'cli_type',
      'terminal_cols',
      'terminal_rows',
    ]));

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    expect(tables.map((table) => table.name)).toContain('user_ui_state');
    expect(tables.map((table) => table.name)).toEqual(expect.arrayContaining([
      'scheduled_tasks',
      'scheduled_task_runs',
    ]));
    const scheduledTaskColumns = db.prepare('PRAGMA table_info(scheduled_tasks)').all() as Array<{ name: string }>;
    expect(scheduledTaskColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'stop_at',
      'daily_stop_time',
      'daily_stop_at',
      'daily_start_time',
      'daily_end_time',
      'start_conditions',
      'daily_stop_conditions',
      'condition_unmet_policy',
      'daily_paused_until',
      'waiting_reason',
      'max_successful_runs',
      'quota_remaining_below',
      'max_consecutive_failures',
      'stop_on_target_unavailable',
      'successful_runs',
      'consecutive_failures',
      'stopped_at',
      'stop_reason',
    ]));
    expect(db.pragma('user_version', { simple: true })).toBe(19);
  });

  it('adds project notifications to v17 without losing users, projects or login sessions', () => {
    const database = createTestDatabase(); cleanup = database.cleanup;
    const user = createUser({username:'notification-owner',password:'password1'});
    const token = createSession(user.id);
    getDb().prepare("INSERT INTO projects (id,name,path,owner_id) VALUES ('notify','Notify','/tmp/notify-migration',?)").run(user.id);
    getDb().exec(`DROP TABLE platform_ai_project_notification_receipts;
      DROP TABLE platform_ai_project_notification_watches; DROP TABLE platform_ai_project_notifications;`);
    getDb().pragma('user_version = 17'); closeDb(); initDb();
    expect(getSessionUser(token)?.id).toBe(user.id);
    expect(getDb().prepare("SELECT name,owner_id FROM projects WHERE id='notify'").get()).toEqual({name:'Notify',owner_id:user.id});
    expect(getDb().prepare('SELECT * FROM platform_ai_project_notifications').all()).toEqual([]);
    expect(getDb().pragma('foreign_key_check')).toEqual([]);
    expect(readdirSync(database.dir).some(file => file.includes('.pre-v19-'))).toBe(true);
  });

  it('preserves legacy project prompt data while migrating', () => {
    closeDb();
    const dir = mkdtempSync(join(tmpdir(), 'agentmanager-legacy-db-'));
    const path = join(dir, 'agentmanager.db');
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        description TEXT,
        claude_flow_prompt TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    legacy.prepare('INSERT INTO projects (id, name, path, claude_flow_prompt) VALUES (?, ?, ?, ?)')
      .run('legacy', 'Legacy', '/tmp/legacy', 'keep this prompt');
    legacy.close();

    config.dbPath = path;
    initDb();
    const migrated = getDb().prepare('SELECT session_prompt FROM projects WHERE id = ?').get('legacy') as { session_prompt: string };
    expect(migrated.session_prompt).toBe('keep this prompt');
    expect(getDb().pragma('user_version', { simple: true })).toBe(19);

    cleanup = () => {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    };
  });

  it('repairs a version 7 database missing project permissions and preserves login sessions', () => {
    const database = createTestDatabase();
    cleanup = database.cleanup;
    const user = createUser({ username: 'existing', password: 'password1' });
    const token = createSession(user.id);
    getDb().exec('ALTER TABLE users DROP COLUMN can_create_projects');
    getDb().pragma('user_version = 7');
    closeDb();

    initDb();
    expect(getSessionUser(token)).toMatchObject({ id: user.id, can_create_projects: 0 });
    const backups = readdirSync(database.dir).filter((file) => file.endsWith('.bak'));
    expect(backups).toHaveLength(1);
    const backup = new Database(join(database.dir, backups[0]), { readonly: true });
    try {
      const columns = backup.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).not.toContain('can_create_projects');
    } finally {
      backup.close();
    }

    getDb().prepare('UPDATE users SET can_create_projects = 1 WHERE id = ?').run(user.id);
    closeDb();
    initDb();
    expect(getSessionUser(token)).toMatchObject({ id: user.id, can_create_projects: 1 });
    expect(readdirSync(database.dir).filter((file) => file.endsWith('.bak'))).toEqual(backups);
  });

  it('persists a stable app session to Codex conversation mapping', () => {
    ({ cleanup } = createTestDatabase());
    const db = getDb();
    db.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)').run('project-1', 'Project', '/tmp/project');
    db.prepare(`
      INSERT INTO sessions (id, project_id, task, status, cli_type, codex_session_id)
      VALUES (?, ?, 'Terminal', 'running', 'codex', ?)
    `).run('app-session-1', 'project-1', '019f7f9d-6ad7-7110-8615-8410399fd932');

    const row = db.prepare('SELECT id, cli_type, codex_session_id FROM sessions WHERE id = ?')
      .get('app-session-1');
    expect(row).toEqual({
      id: 'app-session-1',
      cli_type: 'codex',
      codex_session_id: '019f7f9d-6ad7-7110-8615-8410399fd932',
    });
  });

  it('claims only legacy ownerless sessions belonging to an owned project', () => {
    const database = createTestDatabase();
    cleanup = database.cleanup;
    const db = getDb();
    db.prepare(`
      INSERT INTO users (id, username, password_hash, display_name, role)
      VALUES ('owner', 'owner', 'hash', 'Owner', 'admin'),
             ('creator', 'creator', 'hash', 'Creator', 'member')
    `).run();
    db.prepare("INSERT INTO projects (id, name, path, owner_id) VALUES ('owned', 'Owned', '/tmp/owned', 'owner')").run();
    db.prepare("INSERT INTO projects (id, name, path, owner_id) VALUES ('orphan', 'Orphan', '/tmp/orphan', NULL)").run();
    db.prepare(`
      INSERT INTO sessions (id, project_id, task, created_by_user_id)
      VALUES ('legacy-owned', 'owned', 'Terminal', NULL),
             ('explicit-creator', 'owned', 'Terminal', 'creator'),
             ('legacy-orphan-project', 'orphan', 'Terminal', NULL),
             ('legacy-no-project', NULL, 'Terminal', NULL)
    `).run();
    db.pragma('user_version = 2');
    closeDb();

    initDb();
    const owners = Object.fromEntries((getDb().prepare(`
      SELECT id, created_by_user_id FROM sessions ORDER BY id
    `).all() as Array<{ id: string; created_by_user_id: string | null }>).map((row) => [row.id, row.created_by_user_id]));
    expect(owners).toEqual({
      'explicit-creator': 'creator',
      'legacy-no-project': null,
      'legacy-orphan-project': null,
      'legacy-owned': 'owner',
    });
    expect(getDb().pragma('user_version', { simple: true })).toBe(19);
  });
});
