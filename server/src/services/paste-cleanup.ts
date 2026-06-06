import { readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { getDb } from '../db/index.js';

/**
 * Retention policy for terminal-pasted images (saved under
 * <project>/.agentmanager/pastes/). Keeps the directory from growing unbounded:
 *   - delete anything older than RETENTION_MS
 *   - then cap to the MAX_FILES most-recent files per project
 * Tunable here; could be surfaced as settings later.
 */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_FILES = 50;                          // per project

/** Prune one project's pastes directory (no-op if it doesn't exist). */
export function prunePastesDir(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.startsWith('paste-'));
  } catch {
    return; // directory doesn't exist yet
  }

  const now = Date.now();
  const files: { full: string; mtime: number }[] = [];
  for (const name of names) {
    const full = join(dir, name);
    try {
      files.push({ full, mtime: statSync(full).mtimeMs });
    } catch { /* vanished — ignore */ }
  }

  // Age-based deletion.
  const survivors: { full: string; mtime: number }[] = [];
  for (const f of files) {
    if (now - f.mtime > RETENTION_MS) {
      try { unlinkSync(f.full); } catch { /* ignore */ }
    } else {
      survivors.push(f);
    }
  }

  // Count cap — keep the newest MAX_FILES, delete the rest.
  if (survivors.length > MAX_FILES) {
    survivors.sort((a, b) => b.mtime - a.mtime);
    for (const f of survivors.slice(MAX_FILES)) {
      try { unlinkSync(f.full); } catch { /* ignore */ }
    }
  }
}

/** Sweep every project's pastes directory (startup + periodic background run). */
export function sweepAllPastes(): void {
  let rows: { path: string }[];
  try {
    rows = getDb().prepare('SELECT path FROM projects WHERE path IS NOT NULL').all() as { path: string }[];
  } catch {
    return;
  }
  for (const r of rows) {
    if (r.path) prunePastesDir(join(r.path, '.agentmanager', 'pastes'));
  }
}
