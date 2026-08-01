import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createUser,
  findUserByUsername,
  hashPasswordAsync,
  verifyPasswordAsync,
  type User,
} from '../src/auth.js';
import { userRoutes } from '../src/routes/users.js';
import { createTestDatabase } from './helpers/database.js';

let app: FastifyInstance;
let cleanup: () => void;
let admin: User;
let member: User;

beforeEach(async () => {
  ({ cleanup } = createTestDatabase());
  admin = createUser({ username: 'password-admin', password: 'admin-password', role: 'admin' });
  member = createUser({ username: 'password-member', password: 'member-password' });
  app = Fastify({ logger: false });
  app.addHook('onRequest', async (req) => {
    req.user = req.headers['x-test-user'] === 'member' ? member : admin;
  });
  await app.register(userRoutes, { prefix: '/api' });
});

afterEach(async () => {
  await app.close();
  cleanup();
});

describe('password mutation security', () => {
  it('hashes passwords without blocking the event loop', async () => {
    let eventLoopTurnRan = false;
    const hashing = hashPasswordAsync('a-valid-password');
    await new Promise<void>((resolve) => setImmediate(() => {
      eventLoopTurnRan = true;
      resolve();
    }));

    expect(eventLoopTurnRan).toBe(true);
    expect(await verifyPasswordAsync('a-valid-password', await hashing)).toBe(true);
  });

  it('rejects oversized passwords on administrator create and reset routes', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/users',
      payload: { username: 'oversized-user', password: 'x'.repeat(257) },
    });
    expect(create.statusCode).toBe(400);
    expect(findUserByUsername('oversized-user')).toBeUndefined();

    const reset = await app.inject({
      method: 'PATCH',
      url: `/api/users/${member.id}`,
      payload: { password: 'x'.repeat(257) },
    });
    expect(reset.statusCode).toBe(400);
    expect(await verifyPasswordAsync('member-password', findUserByUsername(member.username)!.password_hash)).toBe(true);
  });

  it('validates and asynchronously changes the current users password', async () => {
    const oversized = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { 'x-test-user': 'member' },
      payload: { current_password: 'member-password', new_password: 'x'.repeat(257) },
    });
    expect(oversized.statusCode).toBe(400);

    const changed = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { 'x-test-user': 'member' },
      payload: { current_password: 'member-password', new_password: 'new-member-password' },
    });
    expect(changed.statusCode).toBe(200);
    expect(await verifyPasswordAsync('new-member-password', findUserByUsername(member.username)!.password_hash)).toBe(true);
  });
});
