import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUser } from '../src/auth.js';
import { getDb } from '../src/db/index.js';
import { buildMessages, promptEnhancerRoutes, promptRequiresConversationContext } from '../src/routes/prompt-enhancer.js';
import { effectiveSettings } from '../src/routes/settings.js';
import { createTestDatabase } from './helpers/database.js';

let app: FastifyInstance;
let cleanup: () => void;
let adminId: string;
let memberId: string;
let otherId: string;
let testDir: string;

beforeEach(async () => {
  ({ cleanup, dir: testDir } = createTestDatabase());
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
        context_rounds: 4,
        timeout_ms: 30_000,
        api_key: 'secret-never-send-to-client',
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain('secret-never-send-to-client');

    const read = await app.inject({ method: 'GET', url: '/api/prompt-enhancer/config' });
    expect(read.statusCode).toBe(200);
    expect(read.json().config).toMatchObject({ enabled: true, endpoint: 'https://llm.example/v1', context_rounds: 4, api_key_configured: true });
    expect(read.body).not.toContain('secret-never-send-to-client');
  });

  it('validates the configurable recent context round count', async () => {
    const invalid = await app.inject({
      method: 'PUT', url: '/api/prompt-enhancer/config', headers: { 'x-test-role': 'admin' },
      payload: { context_rounds: 11 },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toContain('between 0 and 10');

    const disabled = await app.inject({
      method: 'PUT', url: '/api/prompt-enhancer/config', headers: { 'x-test-role': 'admin' },
      payload: { context_rounds: 0 },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().config.context_rounds).toBe(0);
  });

  it('places only complete user/final pairs before the current draft', () => {
    const messages = buildMessages('当前草稿', 'standard', [
      { user: '上一轮用户问题', assistant: '上一轮最终结论' },
    ]);
    expect(messages.slice(1)).toEqual([
      { role: 'user', content: '上一轮用户问题' },
      { role: 'assistant', content: '上一轮最终结论' },
      { role: 'user', content: '当前草稿' },
    ]);
    expect(messages[0].content).toContain('read-only recent context');
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
    expect(allowed.json()).toEqual({
      prompt: '清晰且可执行的提示词',
      context: { requested_rounds: 3, included_rounds: 0 },
    });
    expect(fetchMock).toHaveBeenCalledWith('https://llm.example/v1/chat/completions', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer server-only-key' }),
    }));
  });

  it('recognizes short prompts that cannot be enhanced reliably without conversation context', () => {
    expect(promptRequiresConversationContext('继续优化')).toBe(true);
    expect(promptRequiresConversationContext('按照上面的方案继续')).toBe(true);
    expect(promptRequiresConversationContext('修复登录页面的空指针异常')).toBe(false);
  });

  it('does not return a generic enhancement when a referential prompt has no usable history', async () => {
    await app.inject({
      method: 'PUT', url: '/api/prompt-enhancer/config', headers: { 'x-test-role': 'admin' },
      payload: { enabled: true, endpoint: 'https://llm.example/v1', model: 'prompt-model', api_key: 'server-only-key' },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await app.inject({
      method: 'POST', url: '/api/prompt-enhancer/enhance',
      payload: { session_id: 'member-session', prompt: '继续优化' },
    });
    expect(result.statusCode).toBe(400);
    expect(result.json().error).toContain('未读取到完整会话上下文');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('loads the bound native conversation and sends only recent user/final pairs', async () => {
    const nativeId = '019f7f9d-6ad7-7110-8615-8410399fd932';
    const codexHome = join(testDir, 'codex-home');
    const rolloutDir = join(codexHome, 'sessions', '2026', '08', '27');
    mkdirSync(rolloutDir, { recursive: true });
    writeFileSync(join(rolloutDir, `rollout-test-${nativeId}.jsonl`), [
      { type: 'event_msg', payload: { type: 'user_message', message: '上一轮用户问题' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: '不应发送的中间进度' }] } },
      { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: '上一轮最终结论' } },
    ].map((entry) => JSON.stringify(entry)).join('\n'));
    getDb().prepare("UPDATE sessions SET cli_type = 'codex', codex_session_id = ? WHERE id = 'member-session'").run(nativeId);
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;

    const saved = await app.inject({
      method: 'PUT', url: '/api/prompt-enhancer/config', headers: { 'x-test-role': 'admin' },
      payload: {
        enabled: true,
        endpoint: 'https://llm.example/v1',
        model: 'prompt-model',
        context_rounds: 1,
        api_key: 'server-only-key',
      },
    });
    expect(saved.statusCode).toBe(200);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '增强结果' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    try {
      const result = await app.inject({
        method: 'POST', url: '/api/prompt-enhancer/enhance',
        payload: { session_id: 'member-session', prompt: '当前草稿' },
      });
      expect(result.statusCode).toBe(200);
      expect(result.json().context).toEqual({ requested_rounds: 1, included_rounds: 1 });
      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(requestBody.messages.slice(1)).toEqual([
        { role: 'user', content: '上一轮用户问题' },
        { role: 'assistant', content: '上一轮最终结论' },
        { role: 'user', content: '当前草稿' },
      ]);
      expect(JSON.stringify(requestBody.messages)).not.toContain('不应发送的中间进度');
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    }
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
