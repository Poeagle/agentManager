import { lstatSync, readdirSync, realpathSync, unlinkSync } from 'fs';
import { isAbsolute, join, relative, sep } from 'path';
import { getDb } from '../db/index.js';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FILES = 50;

/** Prune only uploaded files in a project's paste directory. */
export function prunePastesDir(dir: string): void {
  let names: string[];
  try { names = readdirSync(dir).filter(name => name.startsWith('paste-')); }
  catch { return; }

  const now = Date.now();
  const files: Array<{ path: string; mtime: number }> = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      const info = lstatSync(path);
      if (info.isFile()) files.push({ path, mtime: info.mtimeMs });
    } catch { /* removed concurrently */ }
  }

  const recent = files.filter(file => {
    if (now - file.mtime <= RETENTION_MS) return true;
    try { unlinkSync(file.path); } catch { /* removed concurrently */ }
    return false;
  });
  recent.sort((a, b) => b.mtime - a.mtime);
  for (const file of recent.slice(MAX_FILES)) {
    try { unlinkSync(file.path); } catch { /* removed concurrently */ }
  }
}

/** Sweep all project paste directories at startup and periodically. */
export function sweepAllPastes(): void {
  let projects: Array<{ path: string }>;
  try { projects = getDb().prepare('SELECT path FROM projects WHERE path IS NOT NULL').all() as Array<{ path: string }>; }
  catch { return; }
  for (const project of projects) {
    try {
      const root = realpathSync(project.path);
      const dir = realpathSync(join(root, '.agentmanager', 'pastes'));
      const child = relative(root, dir);
      if (child && !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`)) prunePastesDir(dir);
    } catch { /* project or paste directory is absent */ }
  }
}
