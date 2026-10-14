import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authHook, createSession, createUser } from '../src/auth.js';
import { getDb } from '../src/db/index.js';
import { effectiveSettings, getSetting, settingsRoutes } from '../src/routes/settings.js';
import { createTestDatabase } from './helpers/database.js';

describe('settings defaults', () => {
  it('always exposes Claude and Codex commands with all-permissions flags', () => {
    expect(effectiveSettings([])).toMatchObject({
      session_claude_command: 'claude --dangerously-skip-permissions',
      session_codex_command: 'codex --dangerously-bypass-approvals-and-sandbox',
    });

    expect(effectiveSettings([
      { key: 'agent_claude_command', value: 'CLAUDE_CODE_DISABLE_MOUSE=1 claude' },
      { key: 'session_codex_command', value: 'codex --yolo' },
    ])).toMatchObject({
      session_codex_command: 'codex --yolo',
    });
  });

  it('defaults to disabled cleanup and exposes persisted memory settings without exposing private keys', () => {
    expect(effectiveSettings([])).toMatchObject({
      memory_cleanup_enabled: 'false',
      memory_cleanup_threshold_percent: '85',
      memory_cleanup_idle_minutes: '10',
    });
    const settings = effectiveSettings([
      { key: 'memory_cleanup_enabled', value: 'true' },
      { key: 'memory_cleanup_threshold_percent', value: '90.5' },
      { key: 'memory_cleanup_idle_minutes', value: '15' },
      { key: 'llm_api_key', value: 'private' },
    ]);
    expect(settings).toMatchObject({ memory_cleanup_enabled: 'true', memory_cleanup_threshold_percent: '90.5', memory_cleanup_idle_minutes: '15' });
    expect(settings).not.toHaveProperty('llm_api_key');
  });
});

describe('memory cleanup settings API', () => {
  let cleanup: () => void;
  let app: FastifyInstance;
  let adminHeaders: { cookie: string };

  beforeEach(async () => {
    ({ cleanup } = createTestDatabase());
    const admin = createUser({ username: 'admin', password: 'password1', role: 'admin' });
    adminHeaders = { cookie: `agentmanager_session=${createSession(admin.id)}` };
    app = Fastify({ logger: false });
    app.addHook('onRequest', authHook);
    await app.register(settingsRoutes, { prefix: '/api' });
  });

  afterEach(async () => { await app.close(); cleanup(); });

  it('persists valid configuration and immediately exposes it to the server and settings page', async () => {
    const settings = { memory_cleanup_enabled: 'true', memory_cleanup_threshold_percent: '90.5', memory_cleanup_idle_minutes: '15' };
    const update = await app.inject({ method: 'PUT', url: '/api/settings', headers: adminHeaders, payload: { settings } });
    expect(update.statusCode).toBe(200);
    expect(update.json().settings).toMatchObject(settings);
    expect(getSetting('memory_cleanup_threshold_percent')).toBe('90.5');
    const read = await app.inject({ url: '/api/settings', headers: adminHeaders });
    expect(read.json().settings).toMatchObject(settings);
  });

  it('rejects invalid values before writing any part of the settings request', async () => {
    const invalid = [
      { memory_cleanup_enabled: 'yes' },
      ...['', '0', '101', 'NaN', 'Infinity'].map((value) => ({ memory_cleanup_threshold_percent: value })),
      ...['', '0', '-1', '1.5', '10081', 'NaN'].map((value) => ({ memory_cleanup_idle_minutes: value })),
    ];
    for (const settings of invalid) {
      const response = await app.inject({ method: 'PUT', url: '/api/settings', headers: adminHeaders,
        payload: { settings: { server_port: '43000', memory_cleanup_enabled: 'true', ...settings } } });
      expect(response.statusCode).toBe(400);
      expect(getDb().prepare('SELECT COUNT(*) AS count FROM settings').get()).toEqual({ count: 0 });
    }
  });

  it('allows members to read cleanup settings but only admins to change them', async () => {
    const member = createUser({ username: 'member', password: 'password2' });
    const headers = { cookie: `agentmanager_session=${createSession(member.id)}` };
    expect((await app.inject({ url: '/api/settings', headers })).json().settings.memory_cleanup_enabled).toBe('false');
    const response = await app.inject({ method: 'PUT', url: '/api/settings', headers, payload: { settings: { memory_cleanup_enabled: 'true' } } });
    expect(response.statusCode).toBe(403);
    expect(getSetting('memory_cleanup_enabled')).toBe('false');
  });
});
