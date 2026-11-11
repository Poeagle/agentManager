import { readFileSync } from 'fs';
import { lstat, readdir, realpath, unlink } from 'fs/promises';
import { getDb } from '../../../db/index.js';
import { mkdirSync, writeFileSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { config } from '../../../config.js';
import { homedir } from 'os';
import { getCodexEnvironment, environmentConnection } from './environments.js';
import { localHome, forgetEnvironmentRollout } from './account-files.js';
import { accountCommand } from './account-transport.js';
export function persistCodexBinding(sessionId: string, nativeId: string) {
    const directory = join(dirname(config.dbPath), 'codex-bindings');
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${sessionId}.json`), temp = `${path}.new`;
    writeFileSync(temp, JSON.stringify({ session_id: nativeId, source: 'new-conversation' }));
    renameSync(temp, path);
}
const CODEX_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function codexBindingFile(sessionId: string) { const directory = join(dirname(config.dbPath), 'codex-bindings'); mkdirSync(directory, { recursive: true }); return join(directory, `${sessionId}.json`); }

/** Delete only the selected Codex thread's source rollout in its bound Engine.
 * Provider switching/new conversations create new native IDs and historical
 * rows retain their original environment, so never search other Engines here. */
export async function purgeCodexHistory(context: {session: {agent_environment_id?: string | null}; nativeId: string | null}): Promise<void> {
    const nativeId = context.nativeId;
    if (!nativeId || !CODEX_SESSION_ID_RE.test(nativeId)) return;
    const environmentId = context.session.agent_environment_id || 'native';
    const environment = getCodexEnvironment(environmentId);
    if (environment.kind === 'account') {
        const connection = environmentConnection(environment);
        const home = connection.codexHome?.trim() || '~/.codex';
        const script = `import os,pathlib,sys,json\n` +
            `home=pathlib.Path(${JSON.stringify(home)}).expanduser().resolve()\n` +
            `candidates=[home/name for name in ('sessions','archived_sessions')]\n` +
            `if any(root.is_symlink() for root in candidates): raise ValueError('HISTORY_ACCESS')\n` +
            `roots=[root.resolve() for root in candidates]\n` +
            `files=[];count=0\n` +
            `def fail(error): raise error\n` +
            `for root in roots:\n` +
            ` if root.is_symlink(): raise ValueError('HISTORY_ACCESS')\n` +
            ` if not root.exists(): continue\n` +
            ` for current,dirs,names in os.walk(root,followlinks=False,onerror=fail):\n` +
            `  dirs[:]=[name for name in dirs if not pathlib.Path(current,name).is_symlink()]\n` +
            `  for name in names:\n` +
            `   count+=1\n` +
            `   if count>20000: raise ValueError('HISTORY_LIMIT')\n` +
            `   if name.startswith('rollout-') and name.lower().endswith(${JSON.stringify(nativeId.toLowerCase()+'.jsonl')}):\n` +
            `    path=pathlib.Path(current,name)\n` +
            `    if path.is_symlink(): raise ValueError('HISTORY_ACCESS')\n` +
            `    resolved=path.resolve(strict=True)\n` +
            `    if not any(str(resolved).startswith(str(root)+os.sep) for root in roots): raise ValueError('HISTORY_ACCESS')\n` +
            `    if not resolved.is_file(): raise ValueError('HISTORY_ACCESS')\n` +
            `    files.append(resolved)\n` +
            `for path in files: path.unlink()\n` +
            `print(len(files))`;
        await accountCommand(connection, script, 30000);
        await forgetEnvironmentRollout(environmentId, nativeId);
        return;
    }

    const home = environment.kind === 'native'
        ? (process.env.CODEX_HOME || join(homedir(), '.codex'))
        : localHome(environment);
    const roots = ['sessions', 'archived_sessions'].map(name => join(home, name));
    const files: string[] = [];
    let visited = 0;
    for (const root of roots) {
        let rootReal: string;
        try {
            if ((await lstat(root)).isSymbolicLink()) throw Error('Codex Engine 历史目录是符号链接，拒绝删除');
            rootReal = await realpath(root);
        }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
        const visit = async (directory: string): Promise<void> => {
            const entries = await readdir(directory, { withFileTypes: true });
            for (const entry of entries) {
                if (++visited > 20000) throw Error('Codex 会话历史目录超过安全扫描上限，未删除文件');
                const path = join(directory, entry.name);
                if (entry.isSymbolicLink()) continue;
                if (entry.isDirectory()) await visit(path);
                else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.toLowerCase().endsWith(`${nativeId.toLowerCase()}.jsonl`)) {
                    const resolved = await realpath(path);
                    if (!resolved.startsWith(`${rootReal}/`)) throw Error('Codex 会话文件路径超出 Engine 历史目录');
                    files.push(resolved);
                }
            }
        };
        await visit(rootReal);
    }
    for (const file of files) await unlink(file);
    await forgetEnvironmentRollout(environmentId, nativeId);
}
/** Read a hook-written binding and persist it into the canonical session row. */
export function ingestCodexSessionBinding(sessionId: string): string | null {
    try {
        const parsed = JSON.parse(readFileSync(codexBindingFile(sessionId), 'utf8')) as {
            session_id?: unknown;
        };
        const nativeId = typeof parsed.session_id === 'string' ? parsed.session_id : '';
        if (!CODEX_SESSION_ID_RE.test(nativeId))
            return null;
        const row = getDb().prepare('SELECT cli_type, codex_session_id FROM sessions WHERE id = ?').get(sessionId) as {
            cli_type: string | null;
            codex_session_id: string | null;
        } | undefined;
        if (!row || row.cli_type !== 'codex')
            return null;
        // A SessionStart hook also runs on resume. It must confirm the same UUID,
        // never silently rebind an existing tab to a different Codex conversation.
        if (row.codex_session_id && row.codex_session_id !== nativeId) {
            console.warn(`  Ignoring conflicting Codex binding for ${sessionId}: ${nativeId}`);
            return null;
        }
        if (!row.codex_session_id) {
            getDb().prepare('UPDATE sessions SET codex_session_id = ?, updated_at = datetime(\'now\') WHERE id = ?')
                .run(nativeId, sessionId);
            console.log(`  Captured Codex conversation ${nativeId} for session ${sessionId}`);
        }
        return nativeId;
    }
    catch {
        return null;
    }
}
