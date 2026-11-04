import { getDb } from '../../db/index.js';
import { agentForSession } from './index.js';
import type { AgentSession } from './types.js';
/** Only built-in compatibility columns live alongside the provider-neutral ID. */
export function storeAgentNativeId(session: AgentSession & {
    id: string;
}, nativeId: string | null) {
    const adapter = agentForSession(session), legacy = adapter.identity.legacyField;
    const values: Record<string, string | null> = { agent_id: adapter.descriptor.id, cli_type: adapter.descriptor.id, native_session_id: nativeId, codex_session_id: null, claude_session_id: null };
    if (legacy)
        values[legacy] = nativeId;
    const keys = Object.keys(values);
    getDb().prepare(`UPDATE sessions SET ${keys.map(key => `"${key}"=?`).join(',')},updated_at=datetime('now') WHERE id=?`).run(...keys.map(key => values[key]), session.id);
}
