import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { authHook } from '../src/auth.js';
import { getDb } from '../src/db/index.js';
import { updateAgentManagement } from '../src/services/agents/management-store.js';
import { deriveAgentSecret, sealAgentSecret } from '../src/services/agents/management-store.js';
import { codexProviderProxyRoutes } from '../src/routes/codex-provider-proxy.js';
import { createTestDatabase } from './helpers/database.js';

afterEach(() => vi.unstubAllGlobals());

it('requires the local capability and bridges a Chat Completions response', async () => {
  const database = createTestDatabase();
  const app = Fastify();
  const providerId = 'lunar-fixture';
  const apiKey = 'fixture-upstream-key';
  try {
    updateAgentManagement('codex', current => ({
      ...current,
      providers: [{ id: providerId, name: 'Fixture', kind: 'responses', enabled: true, fields: {
        baseUrl: 'https://gateway.example/v1', protocol: 'chat_completions', models: ['fixture-model'], envKey: 'FIXTURE_UPSTREAM_KEY',
      } }],
    }));
    const encrypted = sealAgentSecret(apiKey, `codex-provider:${providerId}`);
    getDb().prepare('INSERT INTO settings (key,value) VALUES (?,?)').run(
      `agent_management_codex_provider_secret:${providerId}`,
      encrypted,
    );
    app.addHook('onRequest', authHook);
    await app.register(codexProviderProxyRoutes, { prefix: '/api' });
    await app.ready();
    const fetchMock = vi.fn(async () => Response.json({
      id: 'chat-fixture', model: 'fixture-model', choices: [{ message: { content: 'bridge works' } }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const url = `/api/codex-providers/${providerId}/v1/responses`;
    const unauthorized = await app.inject({ method: 'POST', url, payload: { model: 'fixture-model', input: 'hello' } });
    expect(unauthorized.statusCode).toBe(401);

    const authorized = await app.inject({ method: 'POST', url, headers: {
      authorization: `Bearer ${deriveAgentSecret(`codex-responses-bridge:${providerId}`)}`,
    }, payload: { model: 'fixture-model', input: 'hello' } });

    expect(authorized.statusCode).toBe(200);
    expect(authorized.json()).toMatchObject({ object: 'response', output_text: 'bridge works' });
    expect(fetchMock).toHaveBeenCalledWith('https://gateway.example/v1/chat/completions', expect.objectContaining({
      headers: expect.objectContaining({ authorization: `Bearer ${apiKey}` }),
      body: JSON.stringify({ model: 'fixture-model', messages: [{ role: 'user', content: 'hello' }] }),
    }));
  } finally {
    await app.close();
    database.cleanup();
  }
});
