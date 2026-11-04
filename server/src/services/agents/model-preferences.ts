import { getDb } from '../../db/index.js';
import type { ModelPreference } from './types.js';
const key = (id: string) => `session-control:${id}`;
export function readModelPreference(userId: string, sessionId: string): ModelPreference | null {
    const row = getDb().prepare('SELECT value FROM user_ui_state WHERE user_id=? AND key=?').get(userId, key(sessionId)) as {
        value: string;
    } | undefined;
    try {
        const value = JSON.parse(row?.value || 'null');
        return value && typeof value.model === 'string' && typeof value.effort === 'string' ? { model: value.model, effort: value.effort } : null;
    }
    catch {
        return null;
    }
}
export function saveModelPreference(userId: string, sessionId: string, value: ModelPreference | null, submittedAt?: string) {
    if (!value) {
        getDb().prepare('DELETE FROM user_ui_state WHERE user_id=? AND key=?').run(userId, key(sessionId));
        return;
    }
    getDb().prepare("INSERT INTO user_ui_state(user_id,key,value,updated_at) VALUES(?,?,?,datetime('now')) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(userId, key(sessionId), JSON.stringify({ ...value, ...submittedAt ? { submitted_at: submittedAt } : {} }));
}
export function modelPreferenceSubmittedAt(userId: string, sessionId: string): string | null {
    const row = getDb().prepare('SELECT value FROM user_ui_state WHERE user_id=? AND key=?').get(userId, key(sessionId)) as {
        value: string;
    } | undefined;
    try {
        const value = JSON.parse(row?.value || 'null');
        return typeof value?.submitted_at === 'string' ? value.submitted_at : null;
    }
    catch {
        return null;
    }
}
