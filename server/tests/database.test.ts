import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { closeDb, getDb, initDb } from '../src/db/index.js';
import { createTestDatabase } from './helpers/database.js';

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

describe('database schema and durable session identity', () => {
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
      'max_successful_runs',
      'quota_remaining_below',
      'max_consecutive_failures',
      'stop_on_target_unavailable',
      'successful_runs',
      'consecutive_failures',
      'stopped_at',
      'stop_reason',
    ]));
    expect(db.pragma('user_version', { simple: true })).toBe(5);
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
    expect(getDb().pragma('user_version', { simple: true })).toBe(5);

    cleanup = () => {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    };
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
    expect(getDb().pragma('user_version', { simple: true })).toBe(5);
  });
});
