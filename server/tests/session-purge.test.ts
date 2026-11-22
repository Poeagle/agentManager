import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '../src/db/index.js';
import {
  markSessionCancelledIfProcessBearing,
  purgeSessionRecord,
} from '../src/services/session-manager.js';
import { createTestDatabase } from './helpers/database.js';
import { codexAdapter } from '../src/services/agents/codex/adapter.js';
import { purgeCodexHistory } from '../src/services/agents/codex/identity.js';
import * as stream from '../src/services/agents/codex/stream.js';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let cleanup: (() => void) | undefined;
afterEach(() => { vi.restoreAllMocks(); cleanup?.(); });

describe('session record purge safety', () => {
  it('deletes the native thread before removing an ended Codex record', async () => {
    ({ cleanup } = createTestDatabase());
    const home=join(tmpdir(),'codex-purge-'+Math.random().toString(36).slice(2));
    mkdirSync(join(home,'sessions'),{recursive:true});
    const file=join(home,'sessions','rollout-019ff001-9999-7999-8999-999999999999.jsonl');
    writeFileSync(file,'{}\n');
    vi.stubEnv('CODEX_HOME',home);
    const request=vi.fn().mockResolvedValue({});
    const connection=vi.spyOn(stream,'withCodexConnection').mockImplementation(async action=>action(request as never,{userAgent:null}));
    try {
      await purgeCodexHistory({session:{agent_environment_id:'native'},nativeId:'019ff001-9999-7999-8999-999999999999'});
      expect(request).toHaveBeenCalledWith('thread/delete',{threadId:'019ff001-9999-7999-8999-999999999999'});
      expect(connection).toHaveBeenCalledOnce();
      expect(()=>readFileSync(file)).toThrow();
    } finally {
      vi.unstubAllEnvs();
      rmSync(home,{recursive:true,force:true});
    }
  });
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
    vi.spyOn(codexAdapter.history.file!, 'locate').mockResolvedValue(null);
    vi.spyOn(codexAdapter.statistics.facts!, 'preserveAccountUsage').mockResolvedValue();

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
    vi.spyOn(codexAdapter.history.file!, 'locate').mockResolvedValue(null);
    const preserve=vi.spyOn(codexAdapter.statistics.facts!, 'preserveAccountUsage').mockImplementation(async()=>{
      expect(purge).not.toHaveBeenCalled();
    });

    await expect(purgeSessionRecord('codex-history')).resolves.toEqual({ ok: true });
    expect(purge).toHaveBeenCalledOnce();
    expect(preserve).toHaveBeenCalledOnce();
    expect(getDb().prepare('SELECT id FROM sessions WHERE id=?').get('codex-history')).toBeUndefined();
  });
});
