import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authHook, createSession, createUser } from '../src/auth.js';
import { getDb } from '../src/db/index.js';
import { fileRoutes } from '../src/routes/files.js';
import { createTestDatabase } from './helpers/database.js';

let app: FastifyInstance;
let cleanup: () => void;
let project: string;
let outside: string;
let cookie: string;

beforeEach(async () => {
  const database = createTestDatabase();
  cleanup = database.cleanup;
  project = join(database.dir, 'project');
  outside = join(database.dir, 'project-other');
  mkdirSync(join(project, 'sub'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(project, 'inside.txt'), 'inside');
  writeFileSync(join(outside, 'secret.txt'), 'secret');
  symlinkSync(outside, join(project, 'escape'));
  symlinkSync(join(project, 'sub'), join(project, 'safe-link'));
  const admin = createUser({ username: 'admin', password: 'password1', role: 'admin' });
  cookie = `agentmanager_session=${createSession(admin.id)}`;
  getDb().prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)').run('project-1', 'Project', project);
  app = Fastify({ logger: false });
  app.addHook('onRequest', authHook);
  await app.register(fileRoutes, { prefix: '/api' });
});

afterEach(async () => { await app.close(); cleanup(); });

function get(route: string, path: string, projectId = 'project-1') {
  return app.inject({ method: 'GET', url: `/api${route}?project_id=${projectId}&path=${encodeURIComponent(path)}`, headers: { cookie } });
}

describe('project-scoped file API (including administrators)', () => {
  it('lists only the project, omitting symlinks that escape its root', async () => {
    const response = await get('/files', project);
    expect(response.statusCode).toBe(200);
    expect(response.json().files.map((entry: { name: string }) => entry.name)).toEqual(['sub', 'inside.txt', 'safe-link']);
    expect((await get('/files', join(project, 'sub'))).statusCode).toBe(200);
    expect((await get('/files', join(project, 'safe-link'))).statusCode).toBe(200);
    expect((await get('/files/read', join(project, 'inside.txt'))).json().content).toBe('inside');
  });

  it.each(['/files', '/files/read', '/files/export'])('blocks external paths and symlink escapes on %s', async route => {
    for (const target of [outside, join(project, '..'), join(project, '../project-other'), join(project, 'escape')]) {
      expect((await get(route, target)).statusCode).toBe(403);
    }
  });

  it.each([
    ['PUT', '/files/write', 'path'], ['POST', '/files/delete', 'path'],
    ['POST', '/files/rename', 'path'], ['POST', '/files/diff', 'pathB'],
    ['POST', '/files/copy', 'src'], ['POST', '/files/move', 'destDir'],
  ] as const)('checks every path field on %s %s', async (method, route, field) => {
    const response = await app.inject({
      method, url: `/api${route}?project_id=project-1`, headers: { cookie },
      payload: { path: join(project, 'inside.txt'), src: join(project, 'inside.txt'), destDir: project,
        pathA: join(project, 'inside.txt'), pathB: join(project, 'inside.txt'), content: 'modified', newName: 'new.txt', [field]: join(outside, 'secret.txt') },
    });
    expect(response.statusCode).toBe(403);
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('secret');
  });

  it('protects the project root from delete, rename, and move', async () => {
    for (const route of ['delete', 'rename', 'move']) {
      const response = await app.inject({ method: 'POST', url: `/api/files/${route}?project_id=project-1`, headers: { cookie },
        payload: { path: project, src: project, destDir: join(project, 'sub'), newName: 'renamed' } });
      expect(response.statusCode).toBe(403);
      expect(existsSync(project)).toBe(true);
    }
  });

  it('rejects uploads outside the project even for an administrator', async () => {
    for (const target of [outside, join(project, 'escape')]) {
      const response = await app.inject({ method: 'POST', url: `/api/files/upload?project_id=project-1&path=${encodeURIComponent(target)}&filename=new.txt`,
        headers: { cookie, 'content-type': 'application/octet-stream' }, payload: Buffer.from('new') });
      expect(response.statusCode).toBe(403);
    }
    expect(existsSync(join(outside, 'new.txt'))).toBe(false);
  });

  it('allows in-project uploads and writes', async () => {
    const response = await app.inject({ method: 'POST', url: `/api/files/upload?project_id=project-1&path=${encodeURIComponent(project)}&filename=new.txt`,
      headers: { cookie, 'content-type': 'application/octet-stream' }, payload: Buffer.from('new') });
    expect(response.statusCode).toBe(200);
    expect((await app.inject({ method: 'PUT', url: '/api/files/write?project_id=project-1', headers: { cookie },
      payload: { path: join(project, 'new.txt'), content: 'updated' } })).statusCode).toBe(200);
    expect(readFileSync(join(project, 'new.txt'), 'utf8')).toBe('updated');
  });

  it('denies members without access to the selected project', async () => {
    const member = createUser({ username: 'member', password: 'password1' });
    cookie = `agentmanager_session=${createSession(member.id)}`;
    expect((await get('/files', project)).statusCode).toBe(403);
  });

  it('does not permit a fabricated project id', async () => {
    expect((await get('/files', outside, 'not-a-project')).statusCode).toBe(404);
  });
});
