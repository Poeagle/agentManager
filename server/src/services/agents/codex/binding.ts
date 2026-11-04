import { mkdirSync, readdirSync, type Dirent } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { config } from '../../../config.js';
import { getDb } from '../../../db/index.js';
import { ingestCodexSessionBinding } from './identity.js';
import { readFilePrefix } from '../file-prefix.js';
import { type CodexRolloutCandidate, codexRolloutCandidateFromPrefix, selectCodexRolloutCandidate } from './identity-parsing.js';
/* Durable Codex identity bridge. Fresh Codex TUI sessions choose their own
 * UUID, so a per-launch SessionStart hook writes it here. Keeping the binding
 * next to the SQLite DB means it survives both process and machine restarts. */
export const CODEX_BINDINGS_DIR = join(dirname(config.dbPath), 'codex-bindings');
const CODEX_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function codexBindingPath(sessionId: string): string {
    mkdirSync(CODEX_BINDINGS_DIR, { recursive: true });
    return join(CODEX_BINDINGS_DIR, `${sessionId}.json`);
}
/** Pick up bindings that were written just before the server crashed/rebooted. */
export function ingestAllCodexSessionBindings(): void {
    try {
        mkdirSync(CODEX_BINDINGS_DIR, { recursive: true });
        for (const name of readdirSync(CODEX_BINDINGS_DIR)) {
            const match = /^([A-Za-z0-9_-]{6,64})\.json$/.exec(name);
            if (match)
                ingestCodexSessionBinding(match[1]);
        }
    }
    catch { /* non-fatal */ }
}
export function collectCodexRollouts(dir: string, result: CodexRolloutCandidate[]): void {
    let entries: Dirent[];
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            collectCodexRollouts(path, result);
            continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.jsonl'))
            continue;
        const idMatch = /([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jsonl$/i.exec(entry.name);
        if (!idMatch)
            continue;
        const candidate = codexRolloutCandidateFromPrefix(readFilePrefix(path), idMatch[1]);
        if (candidate)
            result.push(candidate);
    }
}
/**
 * Upgrade path for Codex tabs created before native UUID capture existed.
 * Bind only a unique path/time (and, when necessary, first-prompt) match. An
 * ambiguous legacy session is deliberately left unbound instead of risking a
 * tab opening the wrong conversation.
 */
export function backfillLegacyCodexSessionIds(): Set<string> {
    const db = getDb();
    const unbound = db.prepare(`
    SELECT s.id, s.task, s.created_at, p.path AS project_path
    FROM sessions s JOIN projects p ON p.id = s.project_id
    WHERE s.codex_session_id IS NULL
      AND s.claude_session_id IS NULL
      AND (s.cli_type = 'codex' OR s.task = 'Terminal')
  `).all() as Array<{
        id: string;
        task: string;
        created_at: string;
        project_path: string;
    }>;
    if (unbound.length === 0)
        return new Set();
    const rollouts: CodexRolloutCandidate[] = [];
    const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
    collectCodexRollouts(join(codexHome, 'sessions'), rollouts);
    if (rollouts.length === 0)
        return new Set();
    const used = new Set((db.prepare('SELECT codex_session_id FROM sessions WHERE codex_session_id IS NOT NULL').all() as Array<{
        codex_session_id: string;
    }>)
        .map((row) => row.codex_session_id));
    let captured = 0;
    let ambiguous = 0;
    const capturedIds = new Set<string>();
    for (const session of unbound) {
        const createdAt = Date.parse(`${session.created_at.replace(' ', 'T')}Z`);
        if (!Number.isFinite(createdAt))
            continue;
        const expectedPrompt = session.task === 'Terminal'
            ? ''
            : session.task.startsWith('Agent (') && session.task.includes('): ')
                ? session.task.slice(session.task.indexOf('): ') + 3)
                : session.task;
        const nativeId = selectCodexRolloutCandidate(createdAt, session.project_path, rollouts, used, expectedPrompt);
        if (!nativeId) {
            const possibleMatches = rollouts.filter((rollout) => !used.has(rollout.id)
                && rollout.cwd === session.project_path
                && Math.abs(rollout.startedAt - createdAt) <= 5 * 60 * 1000);
            if (possibleMatches.length > 1)
                ambiguous++;
            continue;
        }
        db.prepare(`
      UPDATE sessions SET cli_type = 'codex', codex_session_id = ?, claude_session_id = NULL,
        updated_at = datetime('now')
      WHERE id = ? AND codex_session_id IS NULL AND claude_session_id IS NULL
    `)
            .run(nativeId, session.id);
        used.add(nativeId);
        capturedIds.add(session.id);
        captured++;
    }
    if (captured > 0)
        console.log(`  Backfilled ${captured} legacy Codex conversation binding(s)`);
    if (ambiguous > 0)
        console.warn(`  Left ${ambiguous} legacy Codex session(s) unbound because multiple conversations matched`);
    return capturedIds;
}
/** Poll briefly after launch so the mapping reaches SQLite immediately. */
export function watchCodexSessionBinding(sessionId: string, attempts = 150): void {
    if (ingestCodexSessionBinding(sessionId) || attempts <= 0)
        return;
    const timer = setTimeout(() => watchCodexSessionBinding(sessionId, attempts - 1), 200);
    timer.unref();
}
