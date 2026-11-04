import { readFileSync } from 'fs';
import { getDb } from '../../../db/index.js';
import { mkdirSync, writeFileSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { config } from '../../../config.js';
export function persistCodexBinding(sessionId: string, nativeId: string) {
    const directory = join(dirname(config.dbPath), 'codex-bindings');
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${sessionId}.json`), temp = `${path}.new`;
    writeFileSync(temp, JSON.stringify({ session_id: nativeId, source: 'new-conversation' }));
    renameSync(temp, path);
}
const CODEX_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function codexBindingFile(sessionId: string) { const directory = join(dirname(config.dbPath), 'codex-bindings'); mkdirSync(directory, { recursive: true }); return join(directory, `${sessionId}.json`); }
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
