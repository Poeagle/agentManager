import { getDb } from '../db/index.js';

/** A task starts from the first real conversation input when a session was
 * explicitly opened idle. Later inputs and non-empty task descriptions never
 * replace the established task label. */
export function rememberFirstSessionTask(sessionId: string, input: string): string | null {
  const label = input.trim().replace(/\s+/g, ' ').slice(0, 100);
  if (!label) return null;
  const result = getDb()
    .prepare("UPDATE sessions SET task=?, updated_at=datetime('now') WHERE id=? AND TRIM(COALESCE(task,''))=''")
    .run(label, sessionId);
  return result.changes ? label : null;
}
