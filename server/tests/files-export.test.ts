import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authHook, createSession, createUser } from '../src/auth.js';
import { getDb } from '../src/db/index.js';
import { fileRoutes } from '../src/routes/files.js';
import { createTestDatabase } from './helpers/database.js';

let app: FastifyInstance;
let cleanup: () => void;
let ownerCookie: string;
let projectPath: string;

beforeEach(async () => {
  const database = createTestDatabase();
  cleanup = database.cleanup;
  projectPath = join(database.dir, 'project');
  mkdirSync(join(projectPath, 'reports'), { recursive: true });
  writeFileSync(join(projectPath, 'notes.txt'), 'hello export');
  writeFileSync(join(projectPath, 'reports', 'daily.txt'), 'daily report');

  const owner = createUser({ username: 'owner', password: 'password1' });
  ownerCookie = `agentmanager_session=${createSession(owner.id)}`;
  getDb().prepare('INSERT INTO projects (id, name, path, owner_id) VALUES (?, ?, ?, ?)')
    .run('project-1', 'Project', projectPath, owner.id);

  app = Fastify({ logger: false });
  app.addHook('onRequest', authHook);
  await app.register(fileRoutes, { prefix: '/api' });
});

afterEach(async () => {
  await app.close();
  cleanup();
});

describe('file export API', () => {
  it('streams a file with an attachment filename', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/files/export?path=${encodeURIComponent(join(projectPath, 'notes.txt'))}`,
      headers: { cookie: ownerCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/octet-stream');
    expect(response.headers['content-disposition']).toContain('notes.txt');
    expect(response.rawPayload.toString()).toBe('hello export');
  });

  it('streams a directory as a ZIP archive', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/files/export?path=${encodeURIComponent(join(projectPath, 'reports'))}`,
      headers: { cookie: ownerCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/zip');
    expect(response.headers['content-disposition']).toContain('reports.zip');
    expect(Number(response.headers['x-export-estimated-size'])).toBeGreaterThan(0);
    expect(Number(response.headers['x-export-entry-count'])).toBeGreaterThan(0);
    expect(response.rawPayload.subarray(0, 2).toString()).toBe('PK');
    expect(response.rawPayload.includes(Buffer.from('daily.txt'))).toBe(true);
  });

  it('refuses to follow a selected symlink', async () => {
    const outsideFile = join(projectPath, '..', 'outside-secret.txt');
    writeFileSync(outsideFile, 'secret');
    const linkPath = join(projectPath, 'outside-link.txt');
    symlinkSync(outsideFile, linkPath);

    const response = await app.inject({
      method: 'GET',
      url: `/api/files/export?path=${encodeURIComponent(linkPath)}`,
      headers: { cookie: ownerCookie },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error).toContain('outside your assigned projects');
  });
});
