import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { authHook, createSession, createUser } from '../src/auth.js';
import { userRoutes } from '../src/routes/users.js';
import { createTestDatabase } from './helpers/database.js';
import { serverResourceSampler } from '../src/services/server-resources.js';
import * as serverMemory from '../src/services/server-memory.js';

let cleanup: (() => void) | undefined;
afterEach(async () => { await serverResourceSampler.stop(); cleanup?.(); });

it('serves a shared host-only sample to administrators and enforces login and role permissions', async () => {
  ({ cleanup } = createTestDatabase());
  const admin = createUser({ username: 'admin', password: 'password1', role: 'admin' });
  const member = createUser({ username: 'member', password: 'password2' });
  const app = Fastify({ logger: false });
  const collectMemory = vi.spyOn(serverMemory, 'readServerMemory');
  app.addHook('onRequest', authHook);
  await app.register(userRoutes, { prefix: '/api' });
  try {
    expect((await app.inject('/api/admin/server-resources')).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/admin/server-resources', headers: { cookie: `agentmanager_session=${createSession(member.id)}` } })).statusCode).toBe(403);
    const headers = { cookie: `agentmanager_session=${createSession(admin.id)}` };
    const [first, second] = await Promise.all([
      app.inject({ url: '/api/admin/server-resources', headers }),
      app.inject({ url: '/api/admin/server-resources', headers }),
    ]);
    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.json()).toEqual(second.json());
    const monitor = await app.inject({ url: '/api/admin/monitor', headers });
    expect(monitor.statusCode).toBe(200);
    expect(monitor.json().server_resources).toEqual(first.json().server_resources);
    expect(await serverResourceSampler.read()).toEqual(first.json().server_resources);
    expect(collectMemory).toHaveBeenCalledTimes(1);
    expect(Object.keys(first.json())).toEqual(['server_resources']);
    const { cpu, memory, disk } = first.json().server_resources;
    expect(first.json().server_resources.sampled_at).toEqual(expect.any(String));
    expect(cpu.core_count).toBeGreaterThan(0);
    expect(cpu.usage_percent).toBeGreaterThanOrEqual(0);
    expect(cpu.usage_percent).toBeLessThanOrEqual(100);
    expect(memory.used_bytes + memory.available_bytes).toBe(memory.total_bytes);
    if (disk) {
      expect(disk.total_bytes).toBeGreaterThan(0);
      expect(disk.usage_percent).toBeGreaterThanOrEqual(0);
      expect(disk.usage_percent).toBeLessThanOrEqual(100);
    }
  } finally { await app.close(); }
});
