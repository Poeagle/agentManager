import { createHash } from 'crypto';
import { lstatSync, mkdirSync, realpathSync } from 'fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { config } from '../config.js';
import { getDb } from '../db/index.js';

function canonical(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return join(canonical(parent), absolute.slice(parent.length + (parent === sep ? 0 : 1)));
  }
}

function within(path: string, root: string): boolean {
  const child = relative(root, path);
  return !isAbsolute(child) && child !== '..' && !child.startsWith('..' + sep);
}

/** Resolve without creating anything: a misplaced data directory must never
 * cause an upload (or its cleanup) to modify a project or Git working tree. */
function assertOutsideProjects(root: string): void {
  for (let current = root; ; current = dirname(current)) {
    const marker = join(current, '.git');
    try {
      if (lstatSync(marker).isDirectory()) lstatSync(join(marker, 'HEAD'));
      throw new Error('附件存储目录不能位于 Git 仓库内，请将 AGENTMANAGER_ATTACHMENTS_DIR 配置到仓库之外');
    } catch (error) { if (!['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) throw error; }
    if (dirname(current) === current) break;
  }
  const projects = getDb().prepare('SELECT path FROM projects WHERE path IS NOT NULL').all() as Array<{path: string}>;
  for (const project of projects) {
    if (within(root, canonical(project.path))) throw new Error('附件存储目录不能位于项目内，请将 AGENTMANAGER_ATTACHMENTS_DIR 配置到项目之外');
  }
}

export function attachmentStorageRoot(): string {
  const root = canonical(process.env.AGENTMANAGER_ATTACHMENTS_DIR || join(dirname(config.dbPath), 'attachments'));
  assertOutsideProjects(root);
  return root;
}

export function projectAttachmentDirectory(projectPath: string, create = false): string {
  return projectStorageDirectory(projectPath, 'pastes', create);
}

function projectStorageDirectory(projectPath: string, kind: 'pastes' | 'uploads', create: boolean): string {
  const root = attachmentStorageRoot();
  const key = createHash('sha256').update(realpathSync(projectPath)).digest('hex');
  const directory = join(root, key, kind);
  assertOutsideProjects(canonical(directory));
  // Do not follow project-specific symlinks into another project's storage.
  for (const path of [join(root, key), directory]) {
    try { if (lstatSync(path).isSymbolicLink()) throw new Error('附件存储目录不能使用符号链接'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (create) mkdirSync(directory, {recursive: true, mode: 0o711});
  return directory;
}

export function projectUploadDirectory(projectPath: string, create = false): string {
  return projectStorageDirectory(projectPath, 'uploads', create);
}

export function isProjectUploadPath(path: string, projectPath: string): boolean {
  if (path.length > 4096 || path.includes('\0')) return false;
  try {
    const root = projectUploadDirectory(projectPath);
    const target = canonical(path);
    assertOutsideProjects(target);
    return within(resolve(path), root) && within(target, root);
  } catch { return false; }
}

/** Old project-local files remain readable, but are never created or swept. */
export function isProjectAttachment(path: string, projectPath: string, legacy = false): boolean {
  try {
    const file = realpathSync(path);
    if (!lstatSync(file).isFile()) return false;
    try { if (dirname(file) === projectAttachmentDirectory(projectPath)) return true; } catch { /* Legacy reads do not depend on the new storage configuration. */ }
    if (legacy) {
      const root = realpathSync(projectPath);
      const old = realpathSync(join(root, '.agentmanager', 'pastes'));
      return within(old, root) && dirname(file) === old;
    }
  } catch { /* Missing or unsafe files cannot be submitted or previewed. */ }
  return false;
}
