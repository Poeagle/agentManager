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

  it('bulk-deletes only the current user\'s ended records in the selected project', async () => {
    const insert = getDb().prepare(`
      INSERT INTO sessions (id, project_id, task, status, mode, cli_type, created_by_user_id)
      VALUES (?, 'project-1', ?, ?, 'session', 'claude', ?)
    `);
    insert.run('owner-ended', 'Finished owner work', 'completed', ownerId);
    insert.run('owner-running', 'Active owner work', 'running', ownerId);
    const viewer = getDb().prepare('SELECT id FROM users WHERE username = ?').get('kill-viewer') as { id: string };
    insert.run('viewer-ended', 'Finished viewer work', 'cancelled', viewer.id);
    getDb().prepare(`
      INSERT INTO session_snapshots (session_id, rendered) VALUES ('owner-ended', 'saved screen')
    `).run();
    getDb().prepare(`
      INSERT INTO events (session_id, type) VALUES ('owner-ended', 'session_end')
    `).run();

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/sessions/records/ended?project_id=project-1',
      headers: { cookie: ownerCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, deleted: 1, failed: 0 });
    expect(getDb().prepare('SELECT id FROM sessions ORDER BY id').all()).toEqual([
      { id: 'owner-running' },
      { id: 'viewer-ended' },
    ]);
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM session_snapshots').get()).toEqual({ count: 0 });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM events').get()).toEqual({ count: 0 });
  });
  it('rejects stale browser automatic-resume requests without starting a process', async () => {
    getDb().prepare(`INSERT INTO sessions (id, project_id, task, status, mode, cli_type, created_by_user_id)
      VALUES ('resume-session','project-1','work','failed','session','codex',?)`).run(ownerId);
    const resume = vi.spyOn(sessionManager, 'resumeSessionById').mockResolvedValue({ ok: true });
    const response = await app.inject({ method: 'POST', url: '/api/sessions/resume-session/resume',
      headers: { cookie: ownerCookie }, payload: { automatic: true } });
    expect(response.statusCode).toBe(409); expect(resume).not.toHaveBeenCalled();
  });

  it('allows an explicit Resume action through the existing permission checks', async () => {
    getDb().prepare(`INSERT INTO sessions (id, project_id, task, status, mode, cli_type, created_by_user_id)
      VALUES ('resume-session','project-1','work','failed','session','codex',?)`).run(ownerId);
    const resume = vi.spyOn(sessionManager, 'resumeSessionById').mockResolvedValue({ ok: true });
    const response = await app.inject({ method: 'POST', url: '/api/sessions/resume-session/resume',
      headers: { cookie: ownerCookie }, payload: {} });
    expect(response.statusCode).toBe(200); expect(resume).toHaveBeenCalledWith('resume-session');
  });

});
