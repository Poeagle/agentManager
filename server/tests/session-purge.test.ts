import { afterEach, describe, expect, it } from 'vitest';
import { getDb } from '../src/db/index.js';
import {
  markSessionCancelledIfProcessBearing,
  purgeSessionRecord,
} from '../src/services/session-manager.js';
import { createTestDatabase } from './helpers/database.js';

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

describe('session record purge safety', () => {
  it.each(['launching', 'released'])('refuses to purge a %s session that may still own a process', (status) => {
    ({ cleanup } = createTestDatabase());
    getDb().prepare(`
      INSERT INTO sessions (id, task, status, cli_type, mode)
      VALUES (?, 'Terminal', ?, 'claude', 'terminal')
    `).run(`session-${status}`, status);

    expect(purgeSessionRecord(`session-${status}`)).toEqual({
      ok: false,
      error: 'Stop the session before deleting it',
    });
    expect(getDb().prepare('SELECT status FROM sessions WHERE id = ?').get(`session-${status}`))
      .toEqual({ status });
  });

  it.each(['launching', 'released'])('force-cancels the %s state used by kill timeout recovery', (status) => {
    ({ cleanup } = createTestDatabase());
    getDb().prepare(`
      INSERT INTO sessions (id, task, status, cli_type, mode)
      VALUES (?, 'Terminal', ?, 'claude', 'terminal')
    `).run(`kill-${status}`, status);

    expect(markSessionCancelledIfProcessBearing(`kill-${status}`)).toBe(true);
    expect(getDb().prepare('SELECT status FROM sessions WHERE id = ?').get(`kill-${status}`))
      .toEqual({ status: 'cancelled' });
  });
});
