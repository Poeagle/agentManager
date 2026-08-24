import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUser } from '../src/auth.js';
import { getDb } from '../src/db/index.js';
import { promptEnhancerRoutes } from '../src/routes/prompt-enhancer.js';
import { effectiveSettings } from '../src/routes/settings.js';
import { createTestDatabase } from './helpers/database.js';

let app: FastifyInstance;
let cleanup: () => void;
let adminId: string;
let memberId: string;
let otherId: string;

beforeEach(async () => {
  ({ cleanup } = createTestDatabase());
  adminId = createUser({ username: 'enhancer-admin', password: 'password1', role: 'admin' }).id;
  memberId = createUser({ username: 'enhancer-member', password: 'password1' }).id;
  otherId = createUser({ username: 'enhancer-other', password: 'password1' }).id;
  const db = getDb();
  db.prepare("INSERT INTO sessions (id, task, status, created_by_user_id) VALUES ('member-session', 'Terminal', 'running', ?)").run(memberId);
  db.prepare("INSERT INTO sessions (id, task, status, created_by_user_id) VALUES ('other-session', 'Terminal', 'running', ?)").run(otherId);
  app = Fastify({ logger: false });
  app.addHook('onRequest', async (req) => {
    const role = req.headers['x-test-role'];
    req.user = role === 'admin'
      ? { id: adminId, username: 'admin', display_name: 'Admin', role: 'admin', disabled: 0, max_tabs: 10, created_at: '' }
      : { id: memberId, username: 'member', display_name: 'Member', role: 'member', disabled: 0, max_tabs: 10, created_at: '' };
  });
  await app.register(promptEnhancerRoutes, { prefix: '/api' });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await app.close();
  cleanup();
});

describe('prompt enhancer settings and ownership', () => {
  it('keeps the API key server-only and reserves writes for admins', async () => {
    const denied = await app.inject({
      method: 'PUT', url: '/api/prompt-enhancer/config',
      payload: { enabled: true },
    });
    expect(denied.statusCode).toBe(403);

    const saved = await app.inject({
      method: 'PUT', url: '/api/prompt-enhancer/config', headers: { 'x-test-role': 'admin' },
      payload: {
        enabled: true,
        endpoint: 'https://llm.example/v1',
        model: 'prompt-model',
        mode: 'standard',
        timeout_ms: 30_000,
        api_key: 'secret-never-send-to-client',
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain('secret-never-send-to-client');

    const read = await app.inject({ method: 'GET', url: '/api/prompt-enhancer/config' });
    expect(read.statusCode).toBe(200);
    expect(read.json().config).toMatchObject({ enabled: true, endpoint: 'https://llm.example/v1', api_key_configured: true });
    expect(read.body).not.toContain('secret-never-send-to-client');
  });

  it('enhances only the current user’s own terminal tab', async () => {
    const saved = await app.inject({
      method: 'PUT', url: '/api/prompt-enhancer/config', headers: { 'x-test-role': 'admin' },
      payload: { enabled: true, endpoint: 'https://llm.example/v1', model: 'prompt-model', api_key: 'server-only-key' },
    });
    expect(saved.statusCode).toBe(200);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '清晰且可执行的提示词' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const forbidden = await app.inject({
      method: 'POST', url: '/api/prompt-enhancer/enhance',
      payload: { session_id: 'other-session', prompt: '帮我修复' },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();

    const allowed = await app.inject({
      method: 'POST', url: '/api/prompt-enhancer/enhance',
      payload: { session_id: 'member-session', prompt: '帮我修复' },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toEqual({ prompt: '清晰且可执行的提示词' });
    expect(fetchMock).toHaveBeenCalledWith('https://llm.example/v1/chat/completions', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer server-only-key' }),
    }));
  });

  it('discovers OpenAI-compatible models without exposing the saved API key', async () => {
    const saved = await app.inject({
      method: 'PUT', url: '/api/prompt-enhancer/config', headers: { 'x-test-role': 'admin' },
      payload: { endpoint: 'https://llm.example/v1', api_key: 'server-only-key' },
    });
    expect(saved.statusCode).toBe(200);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: 'gpt-4.1-mini' }, { id: 'gpt-4.1' }, { id: 'gpt-4.1-mini' }, { id: 42 }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await app.inject({ method: 'POST', url: '/api/prompt-enhancer/models', headers: { 'x-test-role': 'admin' } });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ models: ['gpt-4.1', 'gpt-4.1-mini'] });
    expect(fetchMock).toHaveBeenCalledWith('https://llm.example/v1/models', expect.objectContaining({
      headers: { Authorization: 'Bearer server-only-key' },
    }));
    expect(result.body).not.toContain('server-only-key');
  });

  it('does not expose server-only setting rows through the generic settings response', () => {
    expect(effectiveSettings([
      { key: 'terminal_font_size', value: '14' },
      { key: 'prompt_enhancer_api_key', value: 'secret-never-send-to-client' },
    ])).toEqual(expect.objectContaining({ terminal_font_size: '14' }));
    expect(effectiveSettings([
      { key: 'prompt_enhancer_api_key', value: 'secret-never-send-to-client' },
    ])).not.toHaveProperty('prompt_enhancer_api_key');
  });
});
