import { join } from 'path';
import { afterEach, expect, it, vi } from 'vitest';
import { createTestDatabase } from './helpers/database.js';
import { nativeCodexEngineSocket } from '../src/services/agents/codex/native-engine.js';

/**
 * Regression: the Engine socket path was taken from a startup snapshot of the
 * production database path. A test run (isolated temp database) therefore
 * spawned a detached real Engine that the developer instance later adopted,
 * serving fixture credentials and an empty CODEX_HOME.
 */
let database: { dir: string; cleanup: () => void } | null = null;

afterEach(() => {
  database?.cleanup();
  database = null;
  vi.unstubAllEnvs();
});

it('resolves the Engine socket inside the current database directory', () => {
  vi.stubEnv('AGENTMANAGER_CODEX_STREAM_SOCKET', '');
  database = createTestDatabase();
  expect(nativeCodexEngineSocket()).toBe(join(database.dir, 'codex-engine', 'codex.sock'));
});

it('still honors an explicit runtime socket override', () => {
  vi.stubEnv('AGENTMANAGER_CODEX_STREAM_SOCKET', '/tmp/explicit-codex.sock');
  expect(nativeCodexEngineSocket()).toBe('/tmp/explicit-codex.sock');
});
