import * as agentSession from '../src/services/agents/session.js';
import * as previews from '../src/services/conversation-preview.js';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authHook, createSession as createAuthSession, createUser } from '../src/auth.js';
import { getDb } from '../src/db/index.js';
import { sessionRoutes } from '../src/routes/sessions.js';
import { consumePendingSpawn } from '../src/services/session-manager.js';
import * as sessionManager from '../src/services/session-manager.js';
import { createTestDatabase } from './helpers/database.js';
import { createClaudeProvider, nativeClaudeProviderState, updateNativeClaudeProvider } from '../src/services/agents/claude/providers.js';
import { saveCodexEnvironment } from '../src/services/agents/codex/environments.js';

describe('session creation project identity', () => {
  let app: FastifyInstance;
  let cleanup: () => void;
  let cookie: string;
  let adminId: string;
  let projectPath: string;

  beforeEach(async () => {
    const database = createTestDatabase();
    cleanup = database.cleanup;
    projectPath = join(database.dir, 'project');
    mkdirSync(projectPath);

    const admin = createUser({ username: 'session-path-admin', password: 'password1', role: 'admin' });
    adminId = admin.id;
    cookie = `agentmanager_session=${createAuthSession(admin.id)}`;
    getDb().prepare('INSERT INTO projects (id, name, path, owner_id) VALUES (?, ?, ?, ?)')
      .run('project-1', 'Project', projectPath, admin.id);

    app = Fastify({ logger: false });
    app.addHook('onRequest', authHook);
    await app.register(sessionRoutes, { prefix: '/api' });
  });

  afterEach(async () => {
    await app.close();
    cleanup();
    vi.restoreAllMocks();
  });

  it('keeps empty and healthy records visible when one native runtime is unavailable',async()=>{
    vi.spyOn(previews,'readConversationPreview').mockResolvedValue(null);
    vi.spyOn(agentSession,'readAgentRuntime').mockRejectedValue(new Error('Thread has no history yet'));
    const insert=getDb().prepare("INSERT INTO sessions(id,project_id,task,status,cli_type,native_session_id,created_by_user_id) VALUES(?,'project-1',?,'running','codex',?,?)");
    insert.run('empty','','unstarted-native',adminId);insert.run('healthy','Existing work',null,adminId);
    const response=await app.inject({url:'/api/sessions?project_id=project-1',headers:{cookie}});
    expect(response.statusCode).toBe(200);
    expect(response.json().sessions).toEqual(expect.arrayContaining([expect.objectContaining({id:'empty',task:''}),expect.objectContaining({id:'healthy'})]));
    expect(response.json().sessions.find((s:{id:string})=>s.id==='empty')).not.toHaveProperty('agent_runtime');
  });

  it('rejects a project_id paired with a different filesystem path', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie },
      payload: {
        project_id: 'project-1',
        project_path: join(projectPath, 'not-the-registered-root'),
        mode: 'terminal',
        task: 'Terminal',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'project_path does not match project_id' });
    expect((getDb().prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count).toBe(0);
  });

  it('stores and queues the registered project path', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie },
      payload: {
        project_id: 'project-1',
        project_path: projectPath,
        mode: 'terminal',
        task: 'Terminal',
      },
    });

    expect(response.statusCode).toBe(200);
    const sessionId = response.json().session.id as string;
    expect(getDb().prepare('SELECT project_id FROM sessions WHERE id = ?').get(sessionId)).toMatchObject({
      project_id: 'project-1',
    });
    expect(consumePendingSpawn(sessionId)).toMatchObject({
      projectId: 'project-1',
      projectPath,
    });
  });

  it.each([
    {title:'replaces a stale environment default',env:{ANTHROPIC_MODEL:'opus'},models:['sonnet'],defaultModel:'sonnet'},
    {title:'keeps an explicitly selected default',env:{ANTHROPIC_MODEL:'opus'},models:['sonnet','opus'],defaultModel:'sonnet',selected:'sonnet'},
    {title:'retains a matching environment default',env:{ANTHROPIC_MODEL:'sonnet'},models:['sonnet','opus'],defaultModel:'sonnet'},
  ])('normalizes the native Claude Provider before a managed session starts: $title', async ({env:environment,models,defaultModel,selected}) => {
    vi.stubEnv('ANTHROPIC_MODEL',environment.ANTHROPIC_MODEL);
    updateNativeClaudeProvider({apiKey:'fixture-native-token',fields:{baseUrl:'https://native.example',models,...selected?{defaultModel:selected}:{}}});
    const provider=nativeClaudeProviderState();
    expect(provider.models).toEqual(models);
    expect(provider.defaultModel).toBe(defaultModel);
    vi.spyOn(sessionManager, 'spawnSession').mockResolvedValue(undefined);
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie },
      payload: {
        project_id: 'project-1',
        project_path: projectPath,
        mode: 'session',
        cli_type: 'claude',
        environment_id: 'anthropic',
        task: 'Reply exactly OK.',
      },
    });

    expect(response.statusCode).toBe(200);
    const sessionId = response.json().session.id as string;
    expect(getDb().prepare('SELECT agent_environment_id FROM sessions WHERE id=?').get(sessionId)).toEqual({
      agent_environment_id: 'claude-provider:anthropic',
    });
    expect(sessionManager.spawnSession).toHaveBeenCalledWith(
      sessionId, projectPath, 'Reply exactly OK.', 120, 40, 'claude',
      undefined,
    );
  });

  it('keeps the regular session list scoped to the current admin account', async () => {
    const otherAdmin = createUser({ username: 'other-session-admin', password: 'password2', role: 'admin' });
    const insert = getDb().prepare(`
      INSERT INTO sessions (id, project_id, task, status, mode, cli_type, created_by_user_id)
      VALUES (?, 'project-1', ?, 'running', 'session', 'claude', ?)
    `);
    insert.run('own-session', 'Own work', adminId);
    insert.run('other-session', 'Other admin work', otherAdmin.id);
    getDb().prepare(`
      INSERT INTO pty_output (session_id, seq, data, created_at)
      VALUES ('own-session', 1, 'latest output', '2026-08-05 06:30:00')
    `).run();

    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().sessions).toEqual([
      expect.objectContaining({
        id: 'own-session',
        last_activity_at: '2026-08-05T06:30:00Z',
        content_summary: 'Own work',
      }),
    ]);
  });

  it('lists every runtime for the requested project without mixing in other projects', async () => {
    const insert = getDb().prepare(`
      INSERT INTO sessions (id, project_id, task, status, mode, cli_type, created_by_user_id)
      VALUES (?, ?, ?, 'completed', ?, ?, ?)
    `);
    insert.run('claude-session', 'project-1', 'Review API', 'session', 'claude', adminId);
    insert.run('codex-session', 'project-1', 'Implement tabs', 'session', 'codex', adminId);
    insert.run('future-session', 'project-1', 'Run migration', 'session', 'codex', adminId);
    getDb().prepare('INSERT INTO projects (id, name, path, owner_id) VALUES (?, ?, ?, ?)')
      .run('project-2', 'Other project', join(projectPath, 'other'), adminId);
    insert.run('other-project-session', 'project-2', 'Do not show', 'session', 'claude', adminId);

    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions?project_id=project-1',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const ids = response.json().sessions.map((session: { id: string }) => session.id);
    expect(ids).toHaveLength(3);
    expect(ids).toEqual(expect.arrayContaining([
      'future-session',
      'codex-session',
      'claude-session',
    ]));
  });

  it('exposes the configured account name for bound Codex and Claude sessions', async () => {
    const codex = await saveCodexEnvironment({
      name: 'Review account', connection: { username: 'review', port: 22 }, allowed_user_ids: [adminId],
    });
    createClaudeProvider({ id: 'fixture', name: 'Claude Gateway', apiKey: 'fixture-token',
      fields: { baseUrl: 'https://fixture.example', models: ['fixture-model'] } });
    const created = await app.inject({ method: 'POST', url: '/api/sessions', headers: { cookie }, payload: {
      project_id: 'project-1', project_path: projectPath, cli_type: 'codex', environment_id: codex.id,
    } });
    expect(created.statusCode).toBe(200);
    expect(created.json().session).toHaveProperty('agent_account_label', 'Review account');
    consumePendingSpawn(created.json().session.id);
    const insert = getDb().prepare(`
      INSERT INTO sessions (id, project_id, task, status, mode, cli_type, agent_environment_id, created_by_user_id)
      VALUES (?, 'project-1', 'Review', 'completed', ?, ?, ?, ?)
    `);
    insert.run('bound-codex', 'session', 'codex', codex.id, adminId);
    insert.run('bound-claude', 'session', 'claude', 'claude-provider:fixture', adminId);
    insert.run('unbound-claude', 'session', 'claude', null, adminId);
    insert.run('plain-terminal', 'terminal', 'codex', null, adminId);

    const response = await app.inject({ url: '/api/sessions?project_id=project-1', headers: { cookie } });
    expect(response.statusCode).toBe(200);
    const byId = new Map(response.json().sessions.map((session: { id: string }) => [session.id, session]));
    for (const [id, name] of [['bound-codex', 'Review account'], ['bound-claude', 'Claude Gateway']]) {
      expect(byId.get(id)).toHaveProperty('agent_account_label', name);
      const detail = await app.inject({ url: `/api/sessions/${id}`, headers: { cookie } });
      expect(detail.json().session).toHaveProperty('agent_account_label', name);
    }
    expect(byId.get('unbound-claude')).not.toHaveProperty('agent_account_label');
    expect(byId.get('plain-terminal')).not.toHaveProperty('agent_account_label');
    expect(response.body).not.toContain('fixture-token');

    const member = createUser({ username: 'session-codex-member', password: 'password1', role: 'member' });
    const memberCookie = `agentmanager_session=${createAuthSession(member.id)}`;
    getDb().prepare(`
      INSERT INTO sessions (id, task, status, mode, cli_type, agent_environment_id, created_by_user_id)
      VALUES ('restricted-codex', 'Review', 'completed', 'session', 'codex', ?, ?)
    `).run(codex.id, member.id);
    const detail = await app.inject({ url: '/api/sessions/restricted-codex', headers: { cookie: memberCookie } });
    expect(detail.statusCode).toBe(403);
    expect(detail.body).not.toContain('Review account');
    const memberList = await app.inject({ url: '/api/sessions', headers: { cookie: memberCookie } });
    expect(memberList.statusCode).toBe(200);
    expect(memberList.json().sessions).toEqual([]);
  });

  it('keeps healthy sessions visible when a Claude Provider-bound record is unavailable', async () => {
    const insert = getDb().prepare(`
      INSERT INTO sessions (id, project_id, task, status, mode, cli_type, agent_environment_id, created_by_user_id)
      VALUES (?, 'project-1', ?, 'cancelled', 'session', ?, ?, ?)
    `);
    insert.run('healthy-codex', 'Keep working', 'codex', null, adminId);
    insert.run('orphaned-claude', 'Old Claude work', 'claude', 'claude-provider:removed', adminId);

    const response = await app.inject({
      url: '/api/sessions?project_id=project-1',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().sessions).toEqual([
      expect.objectContaining({ id: 'healthy-codex' }),
    ]);
  });
});
