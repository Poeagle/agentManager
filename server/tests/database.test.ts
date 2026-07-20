import { afterEach, describe, expect, it } from 'vitest';
import { getDb } from '../src/db/index.js';
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
    ]));

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    expect(tables.map((table) => table.name)).toContain('user_ui_state');
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
});
