import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authHook, createSession, createUser } from '../src/auth.js';
import { getDb } from '../src/db/index.js';
import { sessionRoutes } from '../src/routes/sessions.js';
import { prunePastesDir } from '../src/services/paste-cleanup.js';
import { createTestDatabase } from './helpers/database.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWv8AAAAASUVORK5CYII=', 'base64');

describe('session clipboard uploads', () => {
  let app: FastifyInstance;
  let cleanup: () => void;
  let project: string;
  let ownerCookie: string;
  let otherCookie: string;

  beforeEach(async () => {
    const database = createTestDatabase();
    cleanup = database.cleanup;
    project = join(database.dir, 'project');
    mkdirSync(project);
    const owner = createUser({ username: 'paste-owner', password: 'password1' });
    const other = createUser({ username: 'paste-other', password: 'password2' });
    ownerCookie = `agentmanager_session=${createSession(owner.id)}`;
    otherCookie = `agentmanager_session=${createSession(other.id)}`;
    getDb().prepare('INSERT INTO projects (id, name, path, owner_id) VALUES (?, ?, ?, ?)')
      .run('project-1', 'Project', project, owner.id);
    getDb().prepare(`INSERT INTO sessions (id, project_id, task, status, mode, cli_type, created_by_user_id)
      VALUES ('paste-session', 'project-1', 'Work', 'running', 'session', 'codex', ?)`).run(owner.id);
    app = Fastify({ logger: false });
    app.addHook('onRequest', authHook);
    await app.register(sessionRoutes, { prefix: '/api' });
  });

  afterEach(async () => { await app.close(); cleanup(); });

  const dataUrl = (mime: string, bytes: Buffer) => `data:${mime};base64,${bytes.toString('base64')}`;
  function upload(kind: 'image' | 'file', body: object, cookie = ownerCookie) {
    return app.inject({ method: 'POST', url: `/api/sessions/paste-session/paste-${kind}`, headers: { cookie }, payload: body });
  }

  it('saves pasted screenshots inside the project with unique names', async () => {
    const first = await upload('image', { dataUrl: dataUrl('image/png', png) });
    const second = await upload('image', { dataUrl: dataUrl('image/png', png) });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const paths = [first.json().path, second.json().path] as string[];
    expect(paths[0]).not.toBe(paths[1]);
    for (const path of paths) {
      expect(relative(project, path)).toMatch(/^\.agentmanager\/pastes\/paste-[\w-]+\.png$/);
      expect(readFileSync(path)).toEqual(png);
    }
    expect(readFileSync(join(project, '.agentmanager', '.gitignore'), 'utf8')).toBe('*\n');
  });

  it('rejects inaccessible sessions and invalid or oversized images', async () => {
    expect((await upload('image', { dataUrl: dataUrl('image/png', png) }, otherCookie)).statusCode).toBe(404);
    expect((await upload('image', { dataUrl: dataUrl('image/jpeg', png) })).statusCode).toBe(400);
    expect((await upload('image', { dataUrl: 'data:image/png;base64,%%%%' })).statusCode).toBe(400);
    const oversized = Buffer.concat([png, Buffer.alloc(10 * 1024 * 1024)]);
    expect((await upload('image', { dataUrl: dataUrl('image/png', oversized) })).statusCode).toBe(413);
    expect(existsSync(join(project, '.agentmanager', 'pastes'))).toBe(false);
  });

  it('saves arbitrary pasted files with safe unique names', async () => {
    const body = { dataUrl: dataUrl('text/plain', Buffer.from('hello')), filename: '../notes.txt' };
    const response = await upload('file', body);
    expect(response.statusCode).toBe(200);
    expect(response.json().path).toMatch(/paste-[\w-]+-notes\.txt$/);
    expect(readFileSync(response.json().path, 'utf8')).toBe('hello');
    expect(readdirSync(join(project, '.agentmanager', 'pastes'))).toHaveLength(1);
  });

  it('does not write through a symlinked paste directory', async () => {
    const outside = join(project, '..', 'outside');
    mkdirSync(outside);
    mkdirSync(join(project, '.agentmanager'));
    symlinkSync(outside, join(project, '.agentmanager', 'pastes'));
    const response = await upload('image', { dataUrl: dataUrl('image/png', png) });
    expect(response.statusCode).toBe(500);
    expect(readdirSync(outside)).toHaveLength(0);
  });

  it('does not create a paste directory through a symlinked manager directory', async () => {
    const outside = join(project, '..', 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(project, '.agentmanager'));
    const response = await upload('image', { dataUrl: dataUrl('image/png', png) });
    expect(response.statusCode).toBe(500);
    expect(readdirSync(outside)).toHaveLength(0);
  });

  it('prunes old pasted files while keeping unrelated files', () => {
    const dir = join(project, '.agentmanager', 'pastes');
    mkdirSync(dir, { recursive: true });
    const oldPaste = join(dir, 'paste-old.png');
    const unrelated = join(dir, 'notes.txt');
    writeFileSync(oldPaste, png);
    writeFileSync(unrelated, 'keep');
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(oldPaste, old, old);
    prunePastesDir(dir);
    expect(existsSync(oldPaste)).toBe(false);
    expect(readFileSync(unrelated, 'utf8')).toBe('keep');
  });
});
