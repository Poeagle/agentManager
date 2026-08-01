import Fastify, { type FastifyInstance } from 'fastify';
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createUser, getUserCount, hashPassword, verifyPasswordAsync } from '../src/auth.js';
import { config, resolveListenHost } from '../src/config.js';
import { authRoutes } from '../src/routes/auth.js';
import { createTestDatabase } from './helpers/database.js';
import { registerUserConnection } from '../src/services/user-connections.js';

let app: FastifyInstance;
let cleanup: () => void;
let username: string;
let userId: string;
let addressCounter = 1;
let userCounter = 1;
let originalRateLimit: number;
let originalBlockMs: number;
let originalSecureCookies: boolean;

beforeEach(async () => {
  ({ cleanup } = createTestDatabase());
  username = `security-user-${userCounter++}`;
  userId = createUser({ username, password: 'correct-password', role: 'admin' }).id;
  originalRateLimit = config.loginRateLimitMax;
  originalBlockMs = config.loginBlockMs;
  originalSecureCookies = config.secureCookies;
  app = Fastify({ logger: false });
  await app.register(authRoutes, { prefix: '/api' });
});

afterEach(async () => {
  config.loginRateLimitMax = originalRateLimit;
  config.loginBlockMs = originalBlockMs;
  config.secureCookies = originalSecureCookies;
  await app.close();
  cleanup();
});

describe('authentication security controls', () => {
  it('verifies scrypt passwords asynchronously', async () => {
    const stored = hashPassword('correct horse battery staple');
    let eventLoopTurnRan = false;
    const verification = verifyPasswordAsync('correct horse battery staple', stored);
    await new Promise<void>((resolve) => setImmediate(() => {
      eventLoopTurnRan = true;
      resolve();
    }));

    expect(eventLoopTurnRan).toBe(true);
    expect(await verification).toBe(true);
    expect(await verifyPasswordAsync('wrong', stored)).toBe(false);
  });

  it('rate-limits failures across both account and IP keys', async () => {
    config.loginRateLimitMax = 2;
    config.loginBlockMs = 60_000;
    const firstAddress = `198.51.100.${addressCounter++}`;
    const secondAddress = `198.51.100.${addressCounter++}`;

    const first = await app.inject({
      method: 'POST', url: '/api/auth/login', remoteAddress: firstAddress,
      payload: { username, password: 'wrong-password' },
    });
    const second = await app.inject({
      method: 'POST', url: '/api/auth/login', remoteAddress: secondAddress,
      payload: { username, password: 'wrong-password' },
    });
    const blocked = await app.inject({
      method: 'POST', url: '/api/auth/login', remoteAddress: `198.51.100.${addressCounter++}`,
      payload: { username, password: 'correct-password' },
    });

    expect(first.statusCode).toBe(401);
    expect(second.statusCode).toBe(429);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('rate-limits a concurrent login burst before it can all enter password hashing', async () => {
    config.loginRateLimitMax = 2;
    config.loginBlockMs = 60_000;
    const remoteAddress = `192.0.2.${addressCounter++}`;

    const responses = await Promise.all(Array.from({ length: 12 }, () => app.inject({
      method: 'POST', url: '/api/auth/login', remoteAddress,
      payload: { username, password: 'wrong-password' },
    })));

    const statusCounts = responses.reduce<Record<number, number>>((counts, response) => {
      counts[response.statusCode] = (counts[response.statusCode] ?? 0) + 1;
      return counts;
    }, {});
    expect(statusCounts[401]).toBe(1);
    expect(statusCounts[429]).toBe(11);
  });

  it('rejects oversized passwords before hashing and marks HTTPS cookies Secure', async () => {
    const oversized = await app.inject({
      method: 'POST', url: '/api/auth/login', remoteAddress: `203.0.113.${addressCounter++}`,
      payload: { username, password: 'x'.repeat(257) },
    });
    expect(oversized.statusCode).toBe(400);

    config.secureCookies = true;
    const login = await app.inject({
      method: 'POST', url: '/api/auth/login', remoteAddress: `203.0.113.${addressCounter++}`,
      payload: { username, password: 'correct-password' },
    });
    expect(login.statusCode).toBe(200);
    expect(login.headers['set-cookie']).toContain('Secure');
  });

  it('closes live sockets authenticated by the token being logged out', async () => {
    const login = await app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { username, password: 'correct-password' },
    });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const token = cookie.slice(cookie.indexOf('=') + 1);
    class Socket extends EventEmitter {
      readyState = 1;
      closeCode: number | undefined;
      close(code?: number) { this.closeCode = code; this.readyState = 3; this.emit('close'); }
    }
    const socket = new Socket();
    expect(registerUserConnection(userId, token, socket)).toBeTypeOf('function');

    const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect(logout.statusCode).toBe(200);
    expect(socket.closeCode).toBe(1008);
  });

  it('listens on loopback by default and requires an explicit LAN opt-in', () => {
    expect(resolveListenHost({})).toBe('127.0.0.1');
    expect(resolveListenHost({ AGENTMANAGER_ALLOW_LAN: 'true' })).toBe('::');
    expect(resolveListenHost({ HOST: '0.0.0.0' })).toBe('0.0.0.0');
  });

  it('atomically allows only one concurrent first-run setup request', async () => {
    await app.close();
    cleanup();
    ({ cleanup } = createTestDatabase());
    app = Fastify({ logger: false });
    await app.register(authRoutes, { prefix: '/api' });

    const oversized = await app.inject({
      method: 'POST', url: '/api/auth/setup',
      payload: { username: `oversized-admin-${userCounter++}`, password: 'x'.repeat(257) },
    });
    expect(oversized.statusCode).toBe(400);
    expect(getUserCount()).toBe(0);

    const responses = await Promise.all([
      app.inject({
        method: 'POST', url: '/api/auth/setup',
        payload: { username: `first-admin-${userCounter++}`, password: 'first-password' },
      }),
      app.inject({
        method: 'POST', url: '/api/auth/setup',
        payload: { username: `second-admin-${userCounter++}`, password: 'second-password' },
      }),
    ]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect(getUserCount()).toBe(1);
  });
});
