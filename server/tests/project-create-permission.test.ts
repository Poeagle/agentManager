import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { authHook, createSession, createUser, findUserById, type User } from '../src/auth.js';
import { closeDb, getDb, initDb } from '../src/db/index.js';
import { projectRoutes } from '../src/routes/projects.js';
import { userRoutes } from '../src/routes/users.js';
import { createTestDatabase } from './helpers/database.js';

vi.mock('../src/data/default-agents.js', () => ({ installDefaultAgents: vi.fn() }));

let app: FastifyInstance;
let cleanup: () => void;
let projectPath: string;
let member: User;
let admin: User;
let adminCookie: string;
let memberCookie: string;

beforeEach(async () => {
  const database = createTestDatabase();
  cleanup = database.cleanup;
  projectPath = join(database.dir, 'project');
  mkdirSync(projectPath);
  admin = createUser({ username: 'admin', password: 'password1', role: 'admin' });
  member = createUser({ username: 'member', password: 'password1' });
  adminCookie = `agentmanager_session=${createSession(admin.id)}`;
  memberCookie = `agentmanager_session=${createSession(member.id)}`;
  app = Fastify({ logger: false });
  app.addHook('onRequest', authHook);
  await app.register(projectRoutes, { prefix: '/api' });
  await app.register(userRoutes, { prefix: '/api' });
});

afterEach(async () => { await app.close(); cleanup(); });

const createProject = (cookie: string) => app.inject({
  method: 'POST', url: '/api/projects', headers: { cookie },
  payload: { name: 'New project', path: projectPath },
});
const browse = () => app.inject({ method: 'GET', url: `/api/browse?path=${encodeURIComponent(projectPath)}`, headers: { cookie: memberCookie } });
const grant = (value: unknown, cookie = adminCookie) => app.inject({
  method: 'PATCH', url: `/api/users/${member.id}`, headers: { cookie }, payload: { can_create_projects: value },
});

it('denies members by default and does not let them grant themselves permission', async () => {
  expect(member.can_create_projects).toBe(0);
  expect((await createProject(memberCookie)).statusCode).toBe(403);
  expect((await browse()).statusCode).toBe(403);
  expect((await grant(true, memberCookie)).statusCode).toBe(403);
  expect(getDb().prepare('SELECT id FROM projects').all()).toHaveLength(0);
});

it('allows an administrator to grant creation and browsing without changing the member role', async () => {
  expect((await grant(true)).statusCode).toBe(200);
  expect(findUserById(member.id)).toMatchObject({ role: 'member', can_create_projects: 1 });
  expect((await browse()).statusCode).toBe(200);
  const created = await createProject(memberCookie);
  expect(created.statusCode).toBe(200);
  expect(created.json().project.owner_id).toBe(member.id);
  const listed = await app.inject({ method: 'GET', url: '/api/projects', headers: { cookie: memberCookie } });
  expect(listed.json().projects.map((p: { id: string }) => p.id)).toContain(created.json().project.id);
  expect((await grant(false)).statusCode).toBe(200);
  expect((await createProject(memberCookie)).statusCode).toBe(403);
  expect((await browse()).statusCode).toBe(403);
  const existing = await app.inject({ method: 'GET', url: `/api/projects/${created.json().project.id}`, headers: { cookie: memberCookie } });
  expect(existing.statusCode).toBe(200);
});

it('keeps administrators allowed and validates the permission value', async () => {
  for (const value of ['true', 1, null]) expect((await grant(value)).statusCode).toBe(400);
  expect((await createProject(adminCookie)).statusCode).toBe(200);
});

it('accepts the permission when creating a user and exposes it in the user list', async () => {
  const response = await app.inject({ method: 'POST', url: '/api/users', headers: { cookie: adminCookie },
    payload: { username: 'creator', password: 'password1', can_create_projects: true } });
  expect(response.statusCode).toBe(200);
  expect(response.json().user).toMatchObject({ role: 'member', can_create_projects: 1 });
  const list = await app.inject({ method: 'GET', url: '/api/users', headers: { cookie: adminCookie } });
  expect(list.json().users).toEqual(expect.arrayContaining([expect.objectContaining({ username: 'creator', can_create_projects: 1 })]));
});

it('migrates version 6 users with permission disabled and preserves their role', () => {
  getDb().exec('ALTER TABLE users DROP COLUMN can_create_projects');
  getDb().pragma('user_version = 6');
  closeDb();
  initDb();
  expect(findUserById(member.id)).toMatchObject({ role: 'member', can_create_projects: 0 });
  expect(findUserById(admin.id)).toMatchObject({ role: 'admin', can_create_projects: 0 });
});
