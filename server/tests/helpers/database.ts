import { mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { config } from '../../src/config.js';
import { closeDb, initDb } from '../../src/db/index.js';

export function createTestDatabase(): { dir: string; path: string; cleanup: () => void } {
  closeDb();
  // Keep test sockets below the macOS Unix-domain limit. Platform TMPDIR is
  // often deeply nested, while /tmp is the canonical short temporary root.
  const root = process.platform === 'darwin' ? '/tmp' : tmpdir();
  const dir = realpathSync(mkdtempSync(join(root, 'agentmanager-test-')));
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
