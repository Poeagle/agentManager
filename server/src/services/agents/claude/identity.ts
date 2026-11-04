import { readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getDb } from '../../../db/index.js';
import { resolveClaudeDir, encodeDir } from './archive.js';
import { getTracker } from '../../session-state.js';
import { processStartedAt } from '../process.js';
import { readFilePrefix } from '../file-prefix.js';
import { explicitClaudeSessionId, selectClaudeSessionCandidate } from './identity-parsing.js';
import type { AgentContext } from '../types.js';
/** Snapshot existing .jsonl UUIDs in a Claude project dir (for diffing after spawn) */
export function snapshotClaudeSessionFiles(projectPath: string): Set<string> {
    const claudeProjectDir = join(homedir(), '.claude', 'projects', encodeDir(projectPath));
    try {
        return new Set(readdirSync(claudeProjectDir)
            .filter(f => f.endsWith('.jsonl') && !f.includes('-topic-'))
            .map(f => f.replace('.jsonl', '')));
    }
    catch {
        return new Set();
    }
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function claudeIdFromProjectLog(cliPid: number, args: string[], projectPath: string, appSessionId: string): string | null {
    const explicit = explicitClaudeSessionId(args);
    if (explicit)
        return explicit;
    const startedAt = processStartedAt(cliPid);
    if (!startedAt)
        return null;
    const dir = join(homedir(), '.claude', 'projects', encodeDir(projectPath));
    let files: string[] = [];
    try {
        files = readdirSync(dir).filter((name) => UUID_RE.test(name.replace(/\.jsonl$/, '')) && name.endsWith('.jsonl'));
    }
    catch {
        return null;
    }
    const used = new Set((getDb().prepare(`
      SELECT claude_session_id FROM sessions
      WHERE id != ? AND claude_session_id IS NOT NULL
    `).all(appSessionId) as Array<{
        claude_session_id: string;
    }>).map((row) => row.claude_session_id));
    const candidates: Array<{
        id: string;
        startedAt: number;
    }> = [];
    for (const file of files) {
        const id = file.slice(0, -'.jsonl'.length);
        if (used.has(id))
            continue;
        const path = join(dir, file);
        const prefix = readFilePrefix(path, 64 * 1024);
        const timestamp = /"timestamp":"([^"]+)"/.exec(prefix)?.[1];
        let fileStartedAt = timestamp ? Date.parse(timestamp) : NaN;
        if (!Number.isFinite(fileStartedAt)) {
            try {
                fileStartedAt = statSync(path).birthtimeMs || statSync(path).ctimeMs;
            }
            catch {
                continue;
            }
        }
        candidates.push({ id, startedAt: fileStartedAt });
    }
    return selectClaudeSessionCandidate(startedAt, candidates, used);
}
export function discoverClaudeTerminal(context: AgentContext, pid: number, args: string[]) { return claudeIdFromProjectLog(pid, args, context.projectPath!, context.session.id!); }
export function watchClaudeTerminal(context: AgentContext, preSpawnFiles?: Set<string>) {
    const sessionId = context.session.id!, projectPath = context.projectPath;
    const source = getTracker(sessionId);
    if (!source)
        return;
    const tracker = source;
    let uuidPersisted = !!context.nativeId;
    if (context.nativeId && projectPath)
        tracker.setJsonlFile(join(homedir(), '.claude', 'projects', encodeDir(projectPath), `${context.nativeId}.jsonl`));
    function persistUuid(uuid: string): void {
        if (uuidPersisted)
            return;
        uuidPersisted = true;
        try {
            const db = getDb();
            db.prepare('UPDATE sessions SET claude_session_id = ? WHERE id = ? AND claude_session_id IS NULL')
                .run(uuid, sessionId);
            console.log(`  Captured Claude session UUID ${uuid} for session ${sessionId}`);
        }
        catch { /* ignore */ }
        if (projectPath) {
            const sanitized = encodeDir(projectPath);
            const jsonlPath = join(homedir(), '.claude', 'projects', sanitized, uuid + '.jsonl');
            tracker.setJsonlFile(jsonlPath);
            console.log(`  JSONL output file: ${jsonlPath}`);
        }
    }
    // Fallback: diff ~/.claude/projects/<path>/ against pre-spawn snapshot
    if (projectPath && preSpawnFiles) {
        const claudeProjectDir = join(homedir(), '.claude', 'projects', encodeDir(projectPath));
        let fileScanDone = false;
        const unsub = tracker.onStateChange(async (state) => {
            if (fileScanDone || uuidPersisted) {
                fileScanDone = true;
                return;
            }
            if (state.processState === 'waiting_for_input' || state.processState === 'idle') {
                fileScanDone = true;
                unsub();
                try {
                    const { readdir, stat: statAsync } = await import('fs/promises');
                    const allFiles = await readdir(claudeProjectDir);
                    const currentFiles = allFiles
                        .filter(f => f.endsWith('.jsonl') && !f.includes('-topic-'))
                        .map(f => f.replace('.jsonl', ''));
                    const newFiles = currentFiles.filter(f => !preSpawnFiles.has(f) && UUID_RE.test(f));
                    if (newFiles.length === 1) {
                        persistUuid(newFiles[0]);
                    }
                    else if (newFiles.length > 1) {
                        const sorted = await Promise.all(newFiles.map(async (f) => {
                            const st = await statAsync(join(claudeProjectDir, f + '.jsonl'));
                            return { uuid: f, mtime: st.mtimeMs };
                        }));
                        sorted.sort((a, b) => b.mtime - a.mtime);
                        persistUuid(sorted[0].uuid);
                    }
                }
                catch { /* dir may not exist yet */ }
            }
        });
    }
    tracker.onStateChange(() => { if (!uuidPersisted && tracker.claudeSessionId)
        persistUuid(tracker.claudeSessionId); });
}
export function captureClaudeTerminal(context: AgentContext) { const tracker = context.session.id ? getTracker(context.session.id) : null; if (tracker?.claudeSessionId && !context.nativeId) {
    getDb().prepare('UPDATE sessions SET claude_session_id=? WHERE id=? AND claude_session_id IS NULL').run(tracker.claudeSessionId, context.session.id);
    context.nativeId = tracker.claudeSessionId;
} }
export function purgeClaudeIdentity(context: AgentContext) { if (!context.nativeId || !UUID_RE.test(context.nativeId) || !context.projectPath)
    return; const directory = resolveClaudeDir(context.projectPath); if (directory)
    try {
        unlinkSync(join(directory, `${context.nativeId}.jsonl`));
    }
    catch { } }
