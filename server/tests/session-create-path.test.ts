import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authHook, createSession as createAuthSession, createUser } from '../src/auth.js';
import { getDb } from '../src/db/index.js';
import { sessionRoutes } from '../src/routes/sessions.js';
import { consumePendingSpawn } from '../src/services/session-manager.js';
import { createTestDatabase } from './helpers/database.js';

describe('session creation project identity', () => {
  let app: FastifyInstance;
  let cleanup: () => void;
  let cookie: string;
  let adminId: string;
  let projectPath: string;

  beforeEach(async () => {
    const database = createTestDatabase();
    cleanup = database.cleanup;
    projectPath = join(database.dir, 'project');
    mkdirSync(projectPath);

    const admin = createUser({ username: 'session-path-admin', password: 'password1', role: 'admin' });
    adminId = admin.id;
    cookie = `agentmanager_session=${createAuthSession(admin.id)}`;
    getDb().prepare('INSERT INTO projects (id, name, path, owner_id) VALUES (?, ?, ?, ?)')
      .run('project-1', 'Project', projectPath, admin.id);

    app = Fastify({ logger: false });
    app.addHook('onRequest', authHook);
    await app.register(sessionRoutes, { prefix: '/api' });
  });

  afterEach(async () => {
    await app.close();
    cleanup();
  });

  it('rejects a project_id paired with a different filesystem path', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie },
      payload: {
        project_id: 'project-1',
        project_path: join(projectPath, 'not-the-registered-root'),
        mode: 'terminal',
        task: 'Terminal',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'project_path does not match project_id' });
    expect((getDb().prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count).toBe(0);
  });

  it('stores and queues the registered project path', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie },
      payload: {
        project_id: 'project-1',
        project_path: projectPath,
        mode: 'terminal',
        task: 'Terminal',
      },
    });

    expect(response.statusCode).toBe(200);
    const sessionId = response.json().session.id as string;
    expect(getDb().prepare('SELECT project_id FROM sessions WHERE id = ?').get(sessionId)).toMatchObject({
      project_id: 'project-1',
    });
    expect(consumePendingSpawn(sessionId)).toMatchObject({
      projectId: 'project-1',
      projectPath,
    });
  });

  it('keeps the regular session list scoped to the current admin account', async () => {
    const otherAdmin = createUser({ username: 'other-session-admin', password: 'password2', role: 'admin' });
    const insert = getDb().prepare(`
      INSERT INTO sessions (id, project_id, task, status, mode, cli_type, created_by_user_id)
      VALUES (?, 'project-1', ?, 'running', 'session', 'claude', ?)
    `);
    insert.run('own-session', 'Own work', adminId);
    insert.run('other-session', 'Other admin work', otherAdmin.id);

    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().sessions.map((session: { id: string }) => session.id)).toEqual(['own-session']);
  });
});
