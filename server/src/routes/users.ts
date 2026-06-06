import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { getDb } from '../db/index.js';
import {
  listUsers, createUser, findUserById, findUserByUsername,
  setUserPassword, destroyUserSessions, verifyPassword,
} from '../auth.js';

function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.user?.role !== 'admin') {
    reply.code(403).send({ error: 'Admin only' });
    return false;
  }
  return true;
}

export const userRoutes: FastifyPluginAsync = async (app) => {
  // List users (admin).
  app.get('/users', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return { users: listUsers() };
  });

  // Create user (admin).
  app.post('/users', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { username, password, display_name, role } = (req.body ?? {}) as Record<string, unknown>;
    if (!username || !password) return reply.code(400).send({ error: 'username and password required' });
    if (String(password).length < 6) return reply.code(400).send({ error: 'Password must be at least 6 characters' });
    if (findUserByUsername(String(username).trim())) return reply.code(409).send({ error: 'Username already exists' });
    const user = createUser({
      username: String(username),
      password: String(password),
      display_name: display_name ? String(display_name) : undefined,
      role: role === 'admin' ? 'admin' : 'member',
    });
    return { user };
  });

  // Update a user: role / disabled / reset password (admin).
  app.patch<{ Params: { id: string } }>('/users/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params;
    const target = findUserById(id);
    if (!target) return reply.code(404).send({ error: 'User not found' });
    const { role, disabled, password } = (req.body ?? {}) as Record<string, unknown>;
    const db = getDb();

    // Don't let the last active admin be demoted/disabled into a lockout.
    const losingAdmin = target.role === 'admin' && (role === 'member' || disabled === true);
    if (losingAdmin) {
      const admins = (db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get() as { n: number }).n;
      if (admins <= 1) return reply.code(400).send({ error: 'Cannot remove the last active admin' });
    }

    if (role === 'admin' || role === 'member') {
      db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
    }
    if (disabled !== undefined) {
      db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, id);
      if (disabled) destroyUserSessions(id); // kick out active sessions
    }
    if (password !== undefined) {
      if (String(password).length < 6) return reply.code(400).send({ error: 'Password must be at least 6 characters' });
      setUserPassword(id, String(password));
      destroyUserSessions(id); // force re-login with the new password
    }
    return { user: findUserById(id) };
  });

  // Change your own password (any logged-in user).
  app.post('/auth/change-password', async (req, reply) => {
    const { current_password, new_password } = (req.body ?? {}) as Record<string, unknown>;
    if (!current_password || !new_password) return reply.code(400).send({ error: 'current and new password required' });
    if (String(new_password).length < 6) return reply.code(400).send({ error: 'Password must be at least 6 characters' });
    const row = findUserByUsername(req.user!.username);
    if (!row || !verifyPassword(String(current_password), row.password_hash)) {
      return reply.code(403).send({ error: 'Current password is incorrect' });
    }
    setUserPassword(req.user!.id, String(new_password));
    return { ok: true };
  });
};
