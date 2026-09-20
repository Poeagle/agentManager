import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('child_process', async (original) => {
  const actual = await original<typeof import('child_process')>();
  return { ...actual, fork: vi.fn(() => { throw new Error('startup must not fork a CLI'); }),
    execFileSync: vi.fn((file: string, args: string[]) => {
      if (file === 'tmux' && args.includes('list-sessions')) return 'of-alive\n';
      return '';
    }),
  };
});
import { fork } from 'child_process';
import { config } from '../src/config.js';
import { getDb } from '../src/db/index.js';
import { cleanupStaleRunningSessions, recoverSessionOnAttach } from '../src/services/session-manager.js';
import { createTestDatabase } from './helpers/database.js';
let database: ReturnType<typeof createTestDatabase>;
const saved = { useTmux: config.useTmux, useDtach: config.useDtach };
const nativeId = '019f7f9d-6ad7-7110-8615-8410399fd932';
beforeEach(() => {
  vi.clearAllMocks(); database = createTestDatabase(); config.useTmux = false; config.useDtach = false;
  getDb().prepare('INSERT INTO projects (id,name,path) VALUES (?,?,?)').run('project', 'Project', database.dir);
});
afterEach(() => { Object.assign(config, saved); database.cleanup(); });
function session(id: string, status = 'running') {
  getDb().prepare(`INSERT INTO sessions (id,project_id,task,status,cli_type,codex_session_id) VALUES (?,'project','old task',?,'codex',?)`).run(id, status, nativeId);
}
describe('manual-only recovery', () => {
  it('preserves history and native IDs without launching any of 19 stale direct sessions', async () => {
    for (let i = 0; i < 19; i++) session(`stale-${i}`, i ? 'running' : 'pending');
    await cleanupStaleRunningSessions();
    expect(fork).not.toHaveBeenCalled();
    expect(getDb().prepare("SELECT count(*) AS n FROM sessions WHERE status='failed' AND codex_session_id=?").get(nativeId)).toEqual({ n: 19 });
    expect(getDb().prepare('SELECT count(*) AS n FROM projects').get()).toEqual({ n: 1 });
  });
  it('marks surviving tmux sessions for reconnect while leaving vanished ones ended', async () => {
    config.useTmux = true; session('alive'); session('vanished');
    await cleanupStaleRunningSessions();
    expect(fork).not.toHaveBeenCalled();
    expect(getDb().prepare('SELECT id,status FROM sessions ORDER BY id').all()).toEqual([
      { id: 'alive', status: 'detached' }, { id: 'vanished', status: 'failed' },
    ]);
  });
  it('does not start an ended conversation when its browser tab reconnects', async () => {
    session('ended', 'failed');
    expect(await recoverSessionOnAttach('ended')).toBe(false);
    expect(fork).not.toHaveBeenCalled();
    expect(getDb().prepare("SELECT status FROM sessions WHERE id='ended'").get()).toEqual({ status: 'failed' });
  });
});
