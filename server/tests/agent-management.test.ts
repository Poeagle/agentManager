import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { openAgentSecret, readAgentManagement, sealAgentSecret, updateAgentManagement } from '../src/services/agents/management-store.js';
import { ensureManagedProviderCatalog, removeManagedProviderStorage, renameCodexProvider } from '../src/services/agents/codex/management.js';
import { join } from 'path';
import { tmpdir } from 'os';
import { authHook, createSession, createUser } from '../src/auth.js';
import { agentRoutes } from '../src/routes/agent.js';
import { registerAgent } from '../src/services/agents/index.js';
import { capabilities, type AgentDefinition, type AgentManagementPort, type AgentProviderState } from '../src/services/agents/types.js';
import { createTestDatabase } from './helpers/database.js';
import { commonManagement } from '../src/services/agents/management-common.js';
import { getDb } from '../src/db/index.js';

const configFiles = (root: string) => [
  { path: join(root, 'config.toml'), format: 'TOML', description: 'test config' },
  { path: join(root, 'settings.json'), format: 'JSON', description: 'test settings' },
];

function management(root: string): AgentManagementPort {
  const base = commonManagement({
    descriptor: { id: 'management_fixture', label: 'Managed Fixture', sessionHost: 'managed',
      capabilities: capabilities(['history', 'runtime', 'input', 'stream']), presentation: { icon: 'agent', color: '#888' } },
    executable: '/bin/true', versionArgs: ['--version'], installCommand: '', updateCommand: 'true',
    configFiles: configFiles(root),
    authentication: async () => ({ status: 'authenticated', method: 'fixture', detail: 'fixture' }),
  });
  const state = async () => ({
    agent: { id: 'management_fixture', label: 'Managed Fixture', sessionHost: 'managed' as const,
      capabilities: capabilities(['history', 'runtime', 'input', 'stream']), presentation: { icon: 'agent', color: '#888' } },
    installation: { status: 'ready' as const, executable: '/bin/true', version: '1.0.0', latestVersion: null,
      updateAvailable: false, installCommand: '', updateCommand: '' },
    authentication: { status: 'authenticated' as const, method: 'fixture', detail: 'fixture' },
    defaults: [], providers: [], configFiles: configFiles(root).map(file => ({ ...file, exists: false, writable: true, purpose: file.description })),
    diagnostics: [], actions: [], providerManagement: { create: false, update: false, delete: false, actions: [], fields: [] },
    applySemantics: { settings: 'immediate' as const, providers: 'immediate' as const, detail: 'fixture' }, checkedAt: new Date().toISOString(),
  });
  const provider: AgentProviderState = {
    id: 'provider-a', name: 'Provider A', kind: 'responses', enabled: true, managed: true,
    status: 'ready', statusText: 'Engine running', authentication: { status: 'authenticated', method: 'fixture' },
    models: ['model-a'], defaultModel: 'model-a', socket: join(root, 'provider.sock'), pid: 42,
    launchCommand: 'codex app-server --listen unix://provider.sock', launchArgs: ['app-server', '--listen', `unix://${join(root, 'provider.sock')}`],
    fields: [],
  };
  return {
    inspect: state, update: state, action: state, createProvider: state, updateProvider: state,
    deleteProvider: state,
    inspectProvider: async providerId => providerId === provider.id ? provider : null,
    providerAction: async (_providerId, _action, report) => {
      report?.({ stage: 'spawn', message: 'Starting Engine', progress: 50 });
      return state();
    },
    readConfigFile: async file => ({ path: file.path, content: readFileSync(file.path, 'utf8'), exists: true, format: 'TOML' }),
    writeConfigFile: async file => {
      if (file.expectedContent !== undefined && file.expectedContent !== null) {
        const current = readFileSync(file.path, 'utf8');
        if (current !== file.expectedContent) throw Object.assign(Error('stale'), { statusCode: 409 });
      }
      writeFileSync(file.path, file.content);
      return { path: file.path, content: file.content, exists: true, format: 'TOML' };
    },
    inspect: base.inspect,
  };
}

describe('agent management routes', () => {
  let app: FastifyInstance, root: string, database: ReturnType<typeof createTestDatabase>, unregister: () => void;
  let admin: { cookie: string }, member: { cookie: string };
  beforeEach(async () => {
    database = createTestDatabase();
    root = mkdtempSync(join(tmpdir(), 'agent-management-'));
    writeFileSync(join(root, 'config.toml'), 'model = "test"\n');
    writeFileSync(join(root, 'settings.json'), '{}\n');
    unregister = registerAgent({
      descriptor: { sessionHost: 'managed', id: 'management_fixture', label: 'Managed Fixture',
        capabilities: capabilities(['history', 'runtime', 'input', 'stream']), presentation: { icon: 'agent', color: '#888' } },
      history: { read: async () => ({ messages: [], has_more: false, reset: false, available: true, generation: null }) },
      runtime: { read: async () => ({ source: 'fixture', session_id: null, state: 'idle', last_activity_at: null,
        observed_at: new Date().toISOString(), reason: 'fixture' }) },
      input: { submit: async () => true },
      stream: { observe: () => Object.assign(() => {}, { respond: () => {} }) },
      management: management(root),
    } satisfies AgentDefinition);
    const adminUser = createUser({ username: 'management-admin', password: 'password1', role: 'admin' });
    const memberUser = createUser({ username: 'management-member', password: 'password2' });
    admin = { cookie: `agentmanager_session=${createSession(adminUser.id)}` };
    member = { cookie: `agentmanager_session=${createSession(memberUser.id)}` };
    app = Fastify({ logger: false });
    app.addHook('onRequest', authHook);
    await app.register(agentRoutes, { prefix: '/api' });
  });
  afterEach(async () => {
    await app?.close(); unregister?.(); database?.cleanup(); rmSync(root, { recursive: true, force: true });
  });

  it('allows members to inspect but not edit Agent files', async () => {
    expect((await app.inject({ url: '/api/agent-management', headers: member })).statusCode).toBe(200);
    const read = await app.inject({ method: 'POST', url: '/api/agent-management/management_fixture/config-file', headers: member,
      payload: { path: join(root, 'config.toml') } });
    expect(read.statusCode).toBe(200);
    expect(read.json().file.content).toContain('model');
    const write = await app.inject({ method: 'PUT', url: '/api/agent-management/management_fixture/config-file', headers: member,
      payload: { path: join(root, 'config.toml'), content: 'changed' } });
    expect(write.statusCode).toBe(403);
    expect(readFileSync(join(root, 'config.toml'), 'utf8')).toContain('model');
  });

  it('reads and writes declared files and reports state', async () => {
    const read = await app.inject({ method: 'POST', url: '/api/agent-management/management_fixture/config-file', headers: admin,
      payload: { path: join(root, 'config.toml') } });
    expect(read.statusCode).toBe(200);
    const write = await app.inject({ method: 'PUT', url: '/api/agent-management/management_fixture/config-file', headers: admin,
      payload: { path: join(root, 'settings.json'), content: '{"a":1}\n', expectedContent: '{}\n' } });
    expect(write.statusCode).toBe(200);
    expect(readFileSync(join(root, 'settings.json'), 'utf8')).toBe('{"a":1}\n');
  });

  it('rejects stale writes and paths outside the Agent whitelist', async () => {
    const stale = await app.inject({ method: 'PUT', url: '/api/agent-management/management_fixture/config-file', headers: admin,
      payload: { path: join(root, 'settings.json'), content: '{}', expectedContent: 'old contents' } });
    expect(stale.statusCode).toBe(409);
    const outside = await app.inject({ method: 'POST', url: '/api/agent-management/management_fixture/config-file', headers: admin,
      payload: { path: join(root, '..', 'outside.toml') } });
    expect(outside.statusCode).toBe(400);
  });

  it('uses the declared ConfigFile purpose and sensitive flag', async () => {
    const state = (await app.inject({ url: '/api/agent-management/management_fixture', headers: admin })).json();
    expect(state.state.configFiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: join(root, 'config.toml'), purpose: 'test config', writable: true }),
    ]));
  });

  it('returns one Provider state and streams Engine operation progress', async () => {
    const read = await app.inject({ url: '/api/agent-management/management_fixture/providers/provider-a', headers: member });
    expect(read.statusCode).toBe(200);
    expect(read.json().provider).toMatchObject({ id: 'provider-a', status: 'ready', pid: 42 });

    const stream = await app.inject({
      method: 'POST',
      url: '/api/agent-management/management_fixture/providers/provider-a/action-stream',
      headers: admin,
      payload: { action: 'restart' },
    });
    expect(stream.statusCode).toBe(200);
    const events = stream.body.trim().split('\n').map(line => JSON.parse(line));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'progress', stage: 'spawn', progress: 50 }),
      expect.objectContaining({ type: 'complete', provider: expect.objectContaining({ id: 'provider-a' }) }),
    ]));
  });
});

describe('agent management secrets', () => {
  it('round-trips an API key with authenticated encryption', () => {
    const secret = 'sk-test-provider-key';
    const sealed = sealAgentSecret(secret, 'codex-provider:wz-gork1');
    expect(sealed).not.toContain(secret);
    expect(openAgentSecret(sealed, 'codex-provider:wz-gork1')).toBe(secret);
    expect(() => openAgentSecret(sealed, 'codex-provider:other')).toThrow();
  });
});

describe('codex provider deletion', () => {
  it('removes the encrypted secret, stored provider and managed directory together', async () => {
    const database = createTestDatabase();
    const home = join(database.dir, 'codex-agentmanager', 'delete-me');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.toml'), 'model = "test"\n');
    updateAgentManagement('codex', current => ({
      ...current,
      providers: [...current.providers, {
        id: 'delete-me', name: 'Delete Me', kind: 'responses', enabled: false,
        fields: { baseUrl: 'https://example.com/v1', codexHome: home, models: ['model-a'] },
      }],
    }));
    getDb().prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(
      'agent_management_codex_provider_secret:delete-me',
      sealAgentSecret('sk-delete-test', 'codex-provider:delete-me'),
    );
    try {
      await removeManagedProviderStorage('delete-me');
      expect(readAgentManagement('codex').providers.some(provider => provider.id === 'delete-me')).toBe(false);
      expect(existsSync(home)).toBe(false);
      expect(getDb().prepare('SELECT 1 FROM settings WHERE key=?').get('agent_management_codex_provider_secret:delete-me')).toBeUndefined();
    } finally {
      database.cleanup();
    }
  });
});

describe('codex provider catalog migration', () => {
  it('fills fields required by the installed Codex while preserving model capabilities', async () => {
    const database = createTestDatabase();
    const home = join(database.dir, 'catalog-provider');
    mkdirSync(home, { recursive: true });
    const catalogPath = join(home, 'model-catalog.json');
    writeFileSync(catalogPath, JSON.stringify({
      models: [{
        slug: 'custom-model', display_name: 'Custom Model', context_window: 1_000_000,
        max_context_window: 1_000_000, effective_context_window_percent: 95,
        input_modalities: ['text', 'image'],
      }],
    }));
    try {
      const changed = await ensureManagedProviderCatalog({
        id: 'catalog-provider', name: 'Catalog Provider', kind: 'responses', enabled: false,
        fields: { baseUrl: 'https://example.com', codexHome: home, models: ['custom-model'] },
      });
      expect(changed).toBe(true);
      const model = JSON.parse(readFileSync(catalogPath, 'utf8')).models[0];
      expect(model).toMatchObject({
        context_window: 1_000_000,
        max_context_window: 1_000_000,
        effective_context_window_percent: 95,
        input_modalities: ['text', 'image'],
        truncation_policy: { mode: 'tokens', limit: 10_000 },
        support_verbosity: true,
        default_verbosity: 'low',
      });
      expect(typeof model.base_instructions).toBe('string');
      expect(typeof model.model_messages.instructions_template).toBe('string');
    } finally {
      database.cleanup();
    }
  });
});

describe('Codex provider display names', () => {
 it('renames native and configured providers without changing their engine settings', () => {
  const db=createTestDatabase();
  try {
   updateAgentManagement('codex',current=>({...current,providers:[{id:'one',name:'Old',kind:'responses',enabled:true,fields:{baseUrl:'https://example.invalid',models:['m']}}]}));
   renameCodexProvider('native','  本机  ');renameCodexProvider('one','新名称');
   const state=readAgentManagement('codex');expect(state.defaults.nativeDisplayName).toBe('本机');expect(state.providers[0]).toMatchObject({id:'one',name:'新名称',fields:{models:['m']}});
   expect(()=>renameCodexProvider('one','  ')).toThrow();expect(()=>renameCodexProvider('missing','x')).toThrow();
  } finally { db.cleanup(); }
 });
});
