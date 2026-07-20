import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { config } from '../../src/config.js';
import { closeDb, initDb } from '../../src/db/index.js';

export function createTestDatabase(): { dir: string; path: string; cleanup: () => void } {
  closeDb();
  const dir = mkdtempSync(join(tmpdir(), 'agentmanager-test-'));
  const path = join(dir, 'agentmanager.db');
  config.dbPath = path;
  initDb();
  return {
    dir,
    path,
    cleanup: () => {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
