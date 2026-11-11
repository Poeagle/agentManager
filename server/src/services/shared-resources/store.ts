import { createHash, randomUUID } from 'crypto';
import { accessSync, constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import {userOwnsProject} from '../../auth.js';

export const sharedResourcesSchema = z.object({
  directory: z.string().min(1).max(4096),
  scope_path: z.string().min(1).max(4096).optional(),
  env_file: z.string().min(1).max(4096).optional(),
  instructions: z.string().max(32000),
  enabled: z.boolean(),
  revision: z.number().int().nonnegative(),
}).strict();
export type SharedResourcesInput = z.infer<typeof sharedResourcesSchema>;
interface ResourceRow extends Omit<Required<SharedResourcesInput>, 'enabled'> { user_id: string; enabled: number; updated_at: string }
export class SharedResourceError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
export function withinDirectory(root: string, path: string): boolean {
  const child = relative(root, path);
  return !isAbsolute(child) && child !== '..' && !child.startsWith('..' + sep);
}
export function canonicalDirectory(path: string): string {
  if (!isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw new SharedResourceError('请填写有效的绝对目录路径');
  try {
    const canonical = realpathSync(path);
    if (!lstatSync(canonical).isDirectory() || canonical === '/') throw Error();
    accessSync(canonical,constants.R_OK|constants.X_OK);
    return canonical;
  } catch { throw new SharedResourceError('目录不存在或无法访问'); }
}
export function canonicalEnvFile(path: string, directory: string): string {
  if (!isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw new SharedResourceError('请填写凭据文件的绝对路径');
  let file: string;
  try {
    const absolute = resolve(path);
    const parent = realpathSync(dirname(absolute));
    if (lstatSync(absolute, { throwIfNoEntry: false })?.isSymbolicLink()) throw Error();
    file = join(parent, basename(absolute));
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (stat && !stat.isFile()) throw Error();
  } catch { throw new SharedResourceError('凭据文件须是普通文件，且父目录必须存在'); }
  if (!withinDirectory(directory, file) || file === directory) throw new SharedResourceError('凭据文件必须位于共享工作目录内');
  return file;
}
function getRow(userId: string): ResourceRow | undefined {
  return getDb().prepare('SELECT * FROM user_shared_resources WHERE user_id = ?').get(userId) as ResourceRow | undefined;
}
function requireRow(userId: string): ResourceRow {
  const row = getRow(userId);
  if (!row?.env_file) throw new SharedResourceError('请先保存共享目录、凭据文件路径和使用提示词');
  return row;
}
export function getSharedResources(userId: string) {
  const row = getRow(userId);
  if (!row) return { directory: '', scope_path: '', env_file: '', instructions: '', enabled: false, revision: 0, env_exists: false };
  // Metadata never reads or returns the contents of the credential file.
  let exists = false;
  try { exists = !!row.env_file && lstatSync(row.env_file).isFile(); } catch { /* editor can create a missing file */ }
  return { directory: row.directory, scope_path: row.scope_path, env_file: row.env_file, instructions: row.instructions, enabled: !!row.enabled, revision: row.revision, env_exists: exists };
}
export function saveSharedResources(userId: string, input: SharedResourcesInput) {
  const parsed = sharedResourcesSchema.safeParse(input);
  if (!parsed.success) throw new SharedResourceError('共享资源格式无效，请检查目录、文件和提示词');
  input = parsed.data;
  const directory = canonicalDirectory(input.directory);
  const scope = canonicalDirectory(input.scope_path || directory);
  const file = canonicalEnvFile(input.env_file || join(directory,'.env'), directory);
  const previous = getRow(userId);
  if ((previous?.revision ?? 0) !== input.revision) throw new SharedResourceError('配置已更新，请重新加载后保存', 409);
  if (getDb().prepare('SELECT user_id FROM user_shared_resources WHERE env_file = ? AND user_id <> ?').get(file, userId)) {
    throw new SharedResourceError('该凭据文件已由其他账号配置，请使用自己的文件', 403);
  }
  getDb().prepare(`INSERT INTO user_shared_resources (user_id,directory,scope_path,env_file,instructions,enabled,revision)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET directory=excluded.directory,
    scope_path=excluded.scope_path,env_file=excluded.env_file,instructions=excluded.instructions,
    enabled=excluded.enabled,revision=excluded.revision,updated_at=datetime('now')`)
    .run(userId, directory, scope, file, input.instructions, Number(input.enabled), input.revision + 1);
  return getSharedResources(userId);
}
export function deleteSharedResources(userId: string): void {
  // Removing a configuration must not delete a user-selected .env file.
  getDb().prepare('DELETE FROM user_shared_resources WHERE user_id = ?').run(userId);
}
function readEnvFile(row: ResourceRow): Buffer | undefined {
  const path = canonicalEnvFile(row.env_file, canonicalDirectory(row.directory));
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new SharedResourceError('无法打开凭据文件，请检查权限', 403); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new SharedResourceError('凭据文件须为不超过 1 MB 的普通文本文件');
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
function contentHash(value: Buffer | string): string { return createHash('sha256').update(value).digest('hex'); }
export function openSharedEnv(userId: string) {
  const row = requireRow(userId);
  const bytes = readEnvFile(row);
  return { path: row.env_file, content: bytes?.toString('utf8') ?? '', hash: bytes ? contentHash(bytes) : null, exists: bytes !== undefined, revision: row.revision };
}
export function createSharedEnv(userId:string) {
 const row=requireRow(userId),directory=canonicalDirectory(row.directory),path=canonicalEnvFile(row.env_file,directory);
 if(path!==join(directory,'.env'))throw new SharedResourceError('请先保存配置以使用共享目录中的 .env');
 try{const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);closeSync(fd);}
 catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new SharedResourceError('文件已存在，请重新打开',409);throw new SharedResourceError('无法创建凭据文件，请检查目录权限',403);}
 return openSharedEnv(userId);
}
export function writeSharedEnv(userId: string, input: { content: string; expected_hash: string | null; revision: number }) {
  const row = requireRow(userId);
  if (row.revision !== input.revision) throw new SharedResourceError('配置已变更，请重新打开凭据文件', 409);
  if (Buffer.byteLength(input.content) > 1024 * 1024 || input.content.includes('\0')) throw new SharedResourceError('凭据文件须为不超过 1 MB 的普通文本文件');
  const bytes = readEnvFile(row);
  if ((bytes ? contentHash(bytes) : null) !== input.expected_hash) throw new SharedResourceError('文件已被其他程序修改，请重新打开后再编辑', 409);
  const path = canonicalEnvFile(row.env_file, canonicalDirectory(row.directory));
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    if (bytes === undefined) writeFileSync(path, input.content, { flag: 'wx', mode: 0o600 });
    else {
      writeFileSync(temporary, input.content, { flag: 'wx', mode: 0o600 });
      renameSync(temporary, path);
    }
  } catch { throw new SharedResourceError('无法保存凭据文件，请重新打开并检查写入权限', 409); }
  finally { try { unlinkSync(temporary); } catch { /* no temporary file remains */ } }
  return { path, hash: contentHash(input.content), exists: true };
}
export interface SharedResourceLaunch { instructions: string }
export function sharedResourceLaunch(userId: string | null | undefined, projectPath: string): SharedResourceLaunch | undefined {
  if (!userId) return;
  const row = getRow(userId);
  if (!row?.enabled || !row.env_file) return;
  try {
    if (!withinDirectory(realpathSync(row.scope_path), realpathSync(projectPath))) return;
    const project=(getDb().prepare('SELECT id,path FROM projects').all() as Array<{id:string;path:string}>).find(p=>{try{return realpathSync(p.path)===realpathSync(projectPath);}catch{return false;}});
    if(!project||!userOwnsProject(userId,project.id))return;
    canonicalEnvFile(row.env_file, canonicalDirectory(row.directory));
  } catch { return; }
  // Never open .env here: only its location and the separate usage prompt
  // become model context. Credentials are read locally when actually needed.
  return { instructions: `<octoally_shared_resources>\n个人共享工作目录：${row.directory}\n凭据文件：${row.env_file}\n需要访问 Jira、Confluence、GitLab 等外部服务时，先遵循以下共享资源使用说明。不要把凭据文件内容、Token 或认证头输出到工具日志或回复中；由本地程序按需读取文件。\n\n${row.instructions}\n</octoally_shared_resources>` };
}
