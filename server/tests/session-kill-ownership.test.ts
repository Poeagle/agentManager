import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authHook, createSession as createAuthSession, createUser, setProjectToolAccess } from '../src/auth.js';
import { getDb } from '../src/db/index.js';
import { sessionRoutes } from '../src/routes/sessions.js';
import * as sessionManager from '../src/services/session-manager.js';
import { createTestDatabase } from './helpers/database.js';

describe('session kill ownership', () => {
  let app: FastifyInstance;
  let cleanup: () => void;
  let ownerId: string;
  let ownerCookie: string;
  let viewerCookie: string;

  beforeEach(async () => {
    const database = createTestDatabase();
    cleanup = database.cleanup;

    const owner = createUser({ username: 'kill-owner', password: 'password1' });
    const viewer = createUser({ username: 'kill-viewer', password: 'password2', role: 'admin' });
    ownerId = owner.id;
    ownerCookie = `agentmanager_session=${createAuthSession(owner.id)}`;
    viewerCookie = `agentmanager_session=${createAuthSession(viewer.id)}`;

    getDb().prepare('INSERT INTO projects (id, name, path, owner_id) VALUES (?, ?, ?, ?)')
      .run('project-1', 'Project', database.dir, viewer.id);
    setProjectToolAccess({
      projectId: 'project-1',
      userId: owner.id,
      canSession: true,
      canAgent: true,
      canTerminal: true,
      canClaude: true,
      canCodex: true,
      grantedBy: viewer.id,
    });

    app = Fastify({ logger: false });
    app.addHook('onRequest', authHook);
    await app.register(sessionRoutes, { prefix: '/api' });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    cleanup();
  });

  it('does not let a viewer kill another user\'s open tab', async () => {
    getDb().prepare(`
      INSERT INTO sessions (id, project_id, task, status, mode, cli_type, created_by_user_id)
      VALUES ('owner-session', 'project-1', 'Owner work', 'running', 'session', 'claude', ?)
    `).run(ownerId);
    const kill = vi.spyOn(sessionManager, 'killSession').mockResolvedValue(true);

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/sessions/owner-session',
      headers: { cookie: viewerCookie },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Session not found' });
    expect(kill).not.toHaveBeenCalled();
    expect(getDb().prepare('SELECT status FROM sessions WHERE id = ?').get('owner-session'))
      .toEqual({ status: 'running' });
  });

  it('still lets a user kill their own tab', async () => {
    getDb().prepare(`
      INSERT INTO sessions (id, project_id, task, status, mode, cli_type, created_by_user_id)
      VALUES ('own-session', 'project-1', 'Own work', 'running', 'session', 'claude', ?)
    `).run(ownerId);
    const kill = vi.spyOn(sessionManager, 'killSession').mockResolvedValue(true);

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/sessions/own-session',
      headers: { cookie: ownerCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(kill).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledWith('own-session');
  });
});
