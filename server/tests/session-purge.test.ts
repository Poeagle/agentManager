import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '../src/db/index.js';
import {
  markSessionCancelledIfProcessBearing,
  purgeSessionRecord,
} from '../src/services/session-manager.js';
import { createTestDatabase } from './helpers/database.js';
import { codexAdapter } from '../src/services/agents/codex/adapter.js';

let cleanup: (() => void) | undefined;
afterEach(() => { vi.restoreAllMocks(); cleanup?.(); });

describe('session record purge safety', () => {
  it.each(['launching', 'released'])('refuses to purge a %s session that may still own a process', async (status) => {
    ({ cleanup } = createTestDatabase());
    getDb().prepare(`
      INSERT INTO sessions (id, task, status, cli_type, mode)
      VALUES (?, 'Terminal', ?, 'claude', 'terminal')
    `).run(`session-${status}`, status);

    expect(await purgeSessionRecord(`session-${status}`)).toEqual({
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

  it('keeps the platform history row when deleting the Codex source rollout fails', async () => {
    ({ cleanup } = createTestDatabase());
    getDb().prepare(`
      INSERT INTO sessions (id, task, status, cli_type, mode, codex_session_id, agent_environment_id)
      VALUES ('codex-history', 'Codex history', 'cancelled', 'codex', 'runtime', '019ff001-9999-7999-8999-999999999999', 'provider:xindu')
    `).run();
    vi.spyOn(codexAdapter.identity, 'purgeHistory').mockRejectedValue(new Error('source unavailable'));

    await expect(purgeSessionRecord('codex-history')).resolves.toEqual({
      ok: false,
      error: '删除会话原始历史失败：source unavailable',
    });
    expect(getDb().prepare('SELECT id FROM sessions WHERE id=?').get('codex-history')).toEqual({ id: 'codex-history' });
  });

  it('purges the Codex rollout before removing the platform history row', async () => {
    ({ cleanup } = createTestDatabase());
    getDb().prepare(`
      INSERT INTO sessions (id, task, status, cli_type, mode, codex_session_id, agent_environment_id)
      VALUES ('codex-history', 'Codex history', 'cancelled', 'codex', 'runtime', '019ff001-9999-7999-8999-999999999999', 'provider:xindu')
    `).run();
    const purge = vi.spyOn(codexAdapter.identity, 'purgeHistory').mockResolvedValue();

    await expect(purgeSessionRecord('codex-history')).resolves.toEqual({ ok: true });
    expect(purge).toHaveBeenCalledOnce();
    expect(getDb().prepare('SELECT id FROM sessions WHERE id=?').get('codex-history')).toBeUndefined();
  });
});
