import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authHook, createSession, createUser } from '../src/auth.js';
import { userStateRoutes } from '../src/routes/user-state.js';
import { createTestDatabase } from './helpers/database.js';
import { getDb } from '../src/db/index.js';

let app: FastifyInstance;
let cleanup: () => void;
let aliceCookie: string;
let bobCookie: string;

beforeEach(async () => {
  ({ cleanup } = createTestDatabase());
  const alice = createUser({ username: 'alice', password: 'password1', role: 'admin' });
  const bob = createUser({ username: 'bob', password: 'password2' });
  aliceCookie = `agentmanager_session=${createSession(alice.id)}`;
  bobCookie = `agentmanager_session=${createSession(bob.id)}`;
  app = Fastify({ logger: false });
  app.addHook('onRequest', authHook);
  await app.register(userStateRoutes, { prefix: '/api' });
});

afterEach(async () => {
  await app.close();
  cleanup();
});

describe('per-user UI state API', () => {
  it('persists tab state and isolates it by authenticated user', async () => {
    const value = {
      terminalInstances: [{ id: 'session-1', label: 'Terminal 1', customLabel: 'test1' }],
      activeTerminalId: 'session-1',
    };
    const put = await app.inject({
      method: 'PUT',
      url: '/api/user-state/project%3Aproject-1',
      headers: { cookie: aliceCookie },
      payload: { value },
    });
    expect(put.statusCode).toBe(200);

    const alice = await app.inject({ method: 'GET', url: '/api/user-state', headers: { cookie: aliceCookie } });
    expect(alice.json().state['project:project-1']).toEqual(value);

    const bob = await app.inject({ method: 'GET', url: '/api/user-state', headers: { cookie: bobCookie } });
    expect(bob.json().state).toEqual({});
  });

  it('rejects unauthenticated, invalid-key and oversized writes', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/user-state' })).statusCode).toBe(401);
    expect((await app.inject({
      method: 'PUT',
      url: '/api/user-state/not-allowed',
      headers: { cookie: aliceCookie },
      payload: { value: {} },
    })).statusCode).toBe(400);
    expect((await app.inject({
      method: 'PUT',
      url: '/api/user-state/app',
      headers: { cookie: aliceCookie },
      payload: { value: 'x'.repeat(100_001) },
    })).statusCode).toBe(413);
  });

  it('deletes one key and skips corrupt stored JSON', async () => {
    getDb().prepare('INSERT INTO user_ui_state (user_id, key, value) VALUES ((SELECT id FROM users WHERE username = ?), ?, ?)')
      .run('alice', 'app', '{corrupt');
    const before = await app.inject({ method: 'GET', url: '/api/user-state', headers: { cookie: aliceCookie } });
    expect(before.json().state).toEqual({});

    await app.inject({
      method: 'PUT',
      url: '/api/user-state/app',
      headers: { cookie: aliceCookie },
      payload: { value: { activeTab: 'home' } },
    });
    const removed = await app.inject({ method: 'DELETE', url: '/api/user-state/app', headers: { cookie: aliceCookie } });
    expect(removed.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/user-state', headers: { cookie: aliceCookie } })).json().state).toEqual({});
  });
});
