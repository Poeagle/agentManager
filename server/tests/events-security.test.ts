import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authHook, createSession, createUser, getEventHookSecret } from '../src/auth.js';
import { config } from '../src/config.js';
import { getDb } from '../src/db/index.js';
import { eventRoutes } from '../src/routes/events.js';
import { hooksRoutes } from '../src/routes/hooks.js';
import { createTestDatabase } from './helpers/database.js';

let app: FastifyInstance;
let cleanup: () => void;
let projectPath: string;
let ownerCookie: string;
let secret: string;
let addressCounter = 1;
let originalRateLimit: number;
let originalRetentionMax: number;
let originalLegacyMode: boolean;

function eventPayload(overrides: Record<string, unknown> = {}) {
  return { type: 'tool_use', project_path: projectPath, tool_name: 'Read', data: { path: 'README.md' }, ...overrides };
}

beforeEach(async () => {
  const database = createTestDatabase();
  cleanup = database.cleanup;
  projectPath = join(database.dir, `project-safe-${addressCounter++}`);
  mkdirSync(projectPath, { recursive: true });
  const owner = createUser({ username: `event-owner-${addressCounter++}`, password: 'password1' });
  ownerCookie = `agentmanager_session=${createSession(owner.id)}`;
  getDb().prepare('INSERT INTO projects (id, name, path, owner_id) VALUES (?, ?, ?, ?)')
    .run('project-1', 'Project', projectPath, owner.id);
  secret = getEventHookSecret(projectPath)!;

  originalRateLimit = config.eventRateLimitPerMinute;
  originalRetentionMax = config.eventRetentionMax;
  originalLegacyMode = config.allowLegacyLocalHooks;
  app = Fastify({ logger: false });
  app.addHook('onRequest', authHook);
  await app.register(eventRoutes, { prefix: '/api' });
  await app.register(hooksRoutes, { prefix: '/api' });
});

afterEach(async () => {
  config.eventRateLimitPerMinute = originalRateLimit;
  config.eventRetentionMax = originalRetentionMax;
  config.allowLegacyLocalHooks = originalLegacyMode;
  await app.close();
  cleanup();
});

describe('event hook security', () => {
  it('requires the project-bound secret off loopback and accepts the correct secret', async () => {
    const address = `198.51.100.${addressCounter++}`;
    const unauthenticated = await app.inject({
      method: 'POST', url: '/api/events', remoteAddress: address, payload: eventPayload(),
    });
    const wrong = await app.inject({
      method: 'POST', url: '/api/events', remoteAddress: address,
      headers: { 'x-agentmanager-hook-secret': 'wrong' }, payload: eventPayload(),
    });
    const accepted = await app.inject({
      method: 'POST', url: '/api/events', remoteAddress: address,
      headers: { 'x-agentmanager-hook-secret': secret }, payload: eventPayload(),
    });

    expect(unauthenticated.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(accepted.statusCode).toBe(200);
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n).toBe(1);
  });

  it('keeps legacy hook posts working only from loopback', async () => {
    config.allowLegacyLocalHooks = true;
    const response = await app.inject({ method: 'POST', url: '/api/events', payload: eventPayload() });
    expect(response.statusCode).toBe(200);

    config.allowLegacyLocalHooks = false;
    const disabled = await app.inject({ method: 'POST', url: '/api/events', payload: eventPayload() });
    expect(disabled.statusCode).toBe(401);
  });

  it('validates event type/data, rate-limits ingestion, and enforces retention', async () => {
    const validationAddress = `203.0.113.${addressCounter++}`;
    const headers = { 'x-agentmanager-hook-secret': secret };
    expect((await app.inject({
      method: 'POST', url: '/api/events', remoteAddress: validationAddress, headers,
      payload: eventPayload({ type: 'made_up' }),
    })).statusCode).toBe(400);
    expect((await app.inject({
      method: 'POST', url: '/api/events', remoteAddress: validationAddress, headers,
      payload: eventPayload({ data: { value: 'x'.repeat(70 * 1024) } }),
    })).statusCode).toBe(413);

    config.eventRateLimitPerMinute = 2;
    config.eventRetentionMax = 2;
    const rateAddress = `203.0.113.${addressCounter++}`;
    const first = await app.inject({ method: 'POST', url: '/api/events', remoteAddress: rateAddress, headers, payload: eventPayload() });
    const second = await app.inject({ method: 'POST', url: '/api/events', remoteAddress: rateAddress, headers, payload: eventPayload() });
    const limited = await app.inject({ method: 'POST', url: '/api/events', remoteAddress: rateAddress, headers, payload: eventPayload() });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(limited.statusCode).toBe(429);
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n).toBe(2);
  });

  it('installs a shell-safe hook that sends the project secret header', async () => {
    const installed = await app.inject({
      method: 'POST', url: '/api/hooks/events', headers: { cookie: ownerCookie },
      payload: { path: projectPath, action: 'install' },
    });
    expect(installed.statusCode).toBe(200);
    const settings = JSON.parse(readFileSync(join(projectPath, '.claude', 'settings.json'), 'utf8'));
    const command = settings.hooks.PostToolUse[0].hooks[0].command as string;
    expect(command).toContain('X-AgentManager-Hook-Secret');
    expect(command).toContain(secret);
  });
});
