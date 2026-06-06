import type { FastifyPluginAsync } from 'fastify';
import {
  getUserCount, findUserByUsername, createUser, verifyPassword,
  createSession, destroySession, setSessionCookie, clearSessionCookie,
  readSessionCookie, claimOrphanProjects,
} from '../auth.js';

export const authRoutes: FastifyPluginAsync = async (app) => {
  // Public: does the app need first-run setup, and am I logged in?
  app.get('/auth/status', async (req) => {
    return {
      needsSetup: getUserCount() === 0,
      authenticated: !!req.user,
      user: req.user ?? null,
    };
  });

  // Public, only valid when there are no users yet: create the first admin.
  app.post('/auth/setup', async (req, reply) => {
    if (getUserCount() > 0) return reply.code(409).send({ error: 'Already set up' });
    const { username, password, display_name } = (req.body ?? {}) as Record<string, unknown>;
    if (!username || !password) return reply.code(400).send({ error: 'username and password required' });
    if (String(password).length < 6) return reply.code(400).send({ error: 'Password must be at least 6 characters' });
    const user = createUser({
      username: String(username),
      password: String(password),
      display_name: display_name ? String(display_name) : undefined,
      role: 'admin',
    });
    // First admin inherits any pre-existing (ownerless) projects.
    claimOrphanProjects(user.id);
    setSessionCookie(reply, createSession(user.id));
    return { user };
  });

  // Public: log in.
  app.post('/auth/login', async (req, reply) => {
    const { username, password } = (req.body ?? {}) as Record<string, unknown>;
    if (!username || !password) return reply.code(400).send({ error: 'username and password required' });
    const row = findUserByUsername(String(username).trim());
    if (!row || row.disabled || !verifyPassword(String(password), row.password_hash)) {
      return reply.code(401).send({ error: 'Invalid username or password' });
    }
    setSessionCookie(reply, createSession(row.id));
    const { password_hash, ...user } = row;
    return { user };
  });

  // Authenticated: who am I.
  app.get('/auth/me', async (req) => ({ user: req.user ?? null }));

  // Authenticated: log out.
  app.post('/auth/logout', async (req, reply) => {
    const token = readSessionCookie(req);
    if (token) destroySession(token);
    clearSessionCookie(reply);
    return { ok: true };
  });
};
