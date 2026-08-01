import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authHook, createSession, createUser } from '../src/auth.js';
import { getDb } from '../src/db/index.js';
import { projectRoutes } from '../src/routes/projects.js';
import { createTestDatabase } from './helpers/database.js';

describe('project deletion', () => {
  let app: FastifyInstance;
  let cleanup: () => void;
  let cookie: string;

  beforeEach(async () => {
    const database = createTestDatabase();
    cleanup = database.cleanup;
    const projectPath = join(database.dir, 'project');
    mkdirSync(projectPath);
    const owner = createUser({ username: 'project-owner', password: 'password1', role: 'admin' });
    cookie = `agentmanager_session=${createSession(owner.id)}`;
    getDb().prepare('INSERT INTO projects (id, name, path, owner_id) VALUES (?, ?, ?, ?)')
      .run('project-1', 'Project', projectPath, owner.id);
    getDb().prepare(`
      INSERT INTO sessions (id, project_id, task, mode, status, created_by_user_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('pending-session', 'project-1', 'Terminal', 'terminal', 'pending', owner.id);

    app = Fastify({ logger: false });
    app.addHook('onRequest', authHook);
    await app.register(projectRoutes, { prefix: '/api' });
  });

  afterEach(async () => {
    await app.close();
    cleanup();
  });

  it('cancels active sessions before removing the project boundary', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/projects/project-1',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(getDb().prepare('SELECT id FROM projects WHERE id = ?').get('project-1')).toBeUndefined();
    expect(getDb().prepare('SELECT project_id, status FROM sessions WHERE id = ?').get('pending-session'))
      .toEqual({ project_id: null, status: 'cancelled' });
  });
});
