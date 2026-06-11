import type { FastifyPluginAsync } from 'fastify';
import { getDb } from '../db/index.js';

/**
 * Per-user UI view state — the cross-device "same screen everywhere" store.
 *
 * Holds only the *shareable* slice of the dashboard's view: which project tabs
 * are open + their custom names (`app`), and each project's terminal labels /
 * explorer + web-page sub-tabs (`project:<id>`). Per-device bits (active tab,
 * grid layout) stay in the browser's localStorage and never come here.
 *
 * Scoped to req.user.id — every /api/* route is already gated by authHook, so a
 * logged-in user only ever reads/writes their own rows.
 */

// Allowed key shapes: the top-level app doc, or one doc per project.
const KEY_RE = /^(app|project:[A-Za-z0-9_-]+)$/;
// Generous cap — the real payload is a few KB; this only guards against abuse.
const MAX_VALUE_BYTES = 100_000;

export const userStateRoutes: FastifyPluginAsync = async (app) => {
  // All UI state for the logged-in user, as { [key]: parsedValue }.
  app.get('/user-state', async (req, reply) => {
    const userId = req.user?.id;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const rows = getDb()
      .prepare('SELECT key, value FROM user_ui_state WHERE user_id = ?')
      .all(userId) as { key: string; value: string }[];
    const state: Record<string, unknown> = {};
    for (const row of rows) {
      try { state[row.key] = JSON.parse(row.value); } catch { /* skip corrupt row */ }
    }
    return { state };
  });

  // Upsert one key. Last-writer-wins by updated_at — adequate for infrequent,
  // low-stakes UI metadata synced on load.
  app.put<{ Params: { key: string }; Body: { value: unknown } }>(
    '/user-state/:key',
    async (req, reply) => {
      const userId = req.user?.id;
      if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
      const { key } = req.params;
      if (!KEY_RE.test(key)) return reply.code(400).send({ error: 'Invalid key' });
      const value = req.body?.value;
      if (value === undefined) return reply.code(400).send({ error: 'value is required' });
      const json = JSON.stringify(value);
      if (json.length > MAX_VALUE_BYTES) return reply.code(413).send({ error: 'value too large' });
      getDb()
        .prepare(
          `INSERT INTO user_ui_state (user_id, key, value, updated_at)
           VALUES (?, ?, ?, datetime('now'))
           ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(userId, key, json);
      return { ok: true };
    },
  );

  // Drop a key (e.g. housekeeping). Closing a project tab does NOT call this —
  // the project's names persist so reopening restores them.
  app.delete<{ Params: { key: string } }>('/user-state/:key', async (req, reply) => {
    const userId = req.user?.id;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { key } = req.params;
    if (!KEY_RE.test(key)) return reply.code(400).send({ error: 'Invalid key' });
    getDb().prepare('DELETE FROM user_ui_state WHERE user_id = ? AND key = ?').run(userId, key);
    return { ok: true };
  });
};
