import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { authHook, createUser, readSessionCookie, sessionCookieName } from '../src/auth.js';
import type { FastifyRequest } from 'fastify';
import { authRoutes } from '../src/routes/auth.js';
import { platformApi } from '../src/services/platform-ai/tools.js';
import { createTestDatabase } from './helpers/database.js';

let app: FastifyInstance | undefined;
let cleanup: (() => void) | undefined;
afterEach(async () => {
  await app?.close();
  cleanup?.();
  vi.unstubAllEnvs();
});

it('keeps the production cookie name unchanged by default', () => {
  vi.stubEnv('AGENTMANAGER_RUNTIME_NAMESPACE', '');
  expect(sessionCookieName()).toBe('agentmanager_session');
});

it('isolates browser login, logout and internal AI calls from another instance', async () => {
  vi.stubEnv('AGENTMANAGER_RUNTIME_NAMESPACE', 'preview');
  ({ cleanup } = createTestDatabase());
  const user = createUser({ username: 'preview-admin', password: 'preview-password', role: 'admin' });
  app = Fastify();
  app.addHook('onRequest', authHook);
  await app.register(authRoutes, { prefix: '/api' });
  app.get('/api/probe', async (req) => ({ userId: req.user!.id }));

  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: user.username, password: 'preview-password' } });
  expect(login.statusCode).toBe(200);
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  expect(cookie).toMatch(/^agentmanager_session_preview=/);
  const token = cookie.slice(cookie.indexOf('=') + 1);
  const originalCookie = `agentmanager_session=${token}`;
  expect(readSessionCookie({ headers: { cookie: originalCookie } } as FastifyRequest)).toBeNull();
  expect((await app.inject({ url: '/api/probe', headers: { cookie: originalCookie } })).statusCode).toBe(401);
  const both = `${originalCookie}; ${cookie}`;
  expect((await app.inject({ url: '/api/probe', headers: { cookie: both } })).json()).toEqual({ userId: user.id });
  expect(await platformApi(app, user.id, 'GET', '/api/probe')).toEqual({ userId: user.id });
  const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: both } });
  expect(logout.statusCode).toBe(200);
  expect(logout.headers['set-cookie']).toMatch(/^agentmanager_session_preview=;.*Max-Age=0/);
  expect((await app.inject({ url: '/api/probe', headers: { cookie } })).statusCode).toBe(401);
});
