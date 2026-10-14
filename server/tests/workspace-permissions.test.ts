import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authHook, createSession, createUser, setProjectToolAccess } from '../src/auth.js';
import { closeDb, getDb, initDb } from '../src/db/index.js';
import { projectRoutes } from '../src/routes/projects.js';
import { sessionRoutes } from '../src/routes/sessions.js';
import { getAgentApiContract } from '../src/routes/agent.js';
import { effectiveSettings } from '../src/routes/settings.js';
import * as sessionManager from '../src/services/session-manager.js';
import { setRoleGrants, setUserRoles } from '../src/services/rbac.js';
import { createTestDatabase } from './helpers/database.js';

describe('Session clients and Terminal authorization', () => {
  let app: FastifyInstance;
  let cleanup: () => void;
  let adminId: string;
  let memberId: string;
  let adminHeaders: { cookie: string };
  let memberHeaders: { cookie: string };
  beforeEach(async () => {
    const database = createTestDatabase(); cleanup = database.cleanup;
    adminId = createUser({ username: 'owner', password: 'password1', display_name: 'Project owner', role: 'admin' }).id;
    memberId = createUser({ username: 'member', password: 'password2' }).id;
    adminHeaders = { cookie: `agentmanager_session=${createSession(adminId)}` };
    memberHeaders = { cookie: `agentmanager_session=${createSession(memberId)}` };
    getDb().prepare('INSERT INTO projects (id, name, path, owner_id) VALUES (?, ?, ?, ?)').run('project-1', 'Project', database.dir, adminId);
    app = Fastify(); app.addHook('onRequest', authHook);
    await app.register(projectRoutes, { prefix: '/api' });
    await app.register(sessionRoutes, { prefix: '/api' });
    vi.spyOn(sessionManager, 'spawnTerminal').mockResolvedValue(undefined);
  });
  afterEach(async () => { vi.restoreAllMocks(); await app.close(); cleanup(); });

  it('initializes only admin and member roles and omits removed Agent configuration', () => {
    expect(getDb().prepare('SELECT id FROM rbac_roles WHERE builtin = 1 ORDER BY id').all()).toEqual([{ id: 'admin' }, { id: 'member' }]);
    for (const key of ['agent_claude_command', 'agent_codex_command', 'server_port']) expect(effectiveSettings([])).not.toHaveProperty(key);
    expect(getAgentApiContract().endpoints.some((endpoint) => endpoint.path.endsWith('/agents'))).toBe(false);
  });

  it('returns owner metadata and a data-driven client catalog with only two tool grants', async () => {
    const projects = await app.inject({ url: '/api/projects', headers: adminHeaders });
    expect(projects.json().projects[0].owner).toEqual({ id: adminId, username: 'owner', display_name: 'Project owner' });
    const response = await app.inject({ url: '/api/projects/project-1/access', headers: adminHeaders });
    expect(response.json().clients).toEqual([{ id: 'claude', label: 'Claude' }, { id: 'codex', label: 'Codex' }]);
    expect(projects.json().projects[0].tool_access).toEqual({ can_session: true, can_terminal: true, session_clients: ['claude', 'codex'] });
  });

  it('enforces a Codex-only Session grant while Terminal remains independently available', async () => {
    const response = await app.inject({ method: 'PUT', url: `/api/projects/project-1/access/${memberId}`, headers: adminHeaders,
      payload: { can_session: true, can_terminal: true, session_clients: ['codex'] } });
    expect(response.statusCode).toBe(200);
    const projectPath = (getDb().prepare("SELECT path FROM projects WHERE id = 'project-1'").get() as { path: string }).path;
    const create = (mode: string, cli_type: string) => app.inject({ method: 'POST', url: '/api/sessions', headers: memberHeaders, payload: { project_id: 'project-1', project_path: projectPath, task: 'Work', mode, cli_type } });
    expect((await create('session', 'claude')).statusCode).toBe(403);
    for (const [mode, cli] of [['session', 'codex'], ['terminal', 'claude']]) {
      const result = await create(mode, cli);
      expect(result.statusCode, result.body).toBe(200);
      await sessionManager.killSession(result.json().session.id);
    }
    expect((await create('agent', 'codex')).statusCode).toBe(400);
  });

  it('rejects empty or unknown client selections before changing the grant', async () => {
    setProjectToolAccess({ projectId: 'project-1', userId: memberId, canSession: true, canTerminal: false, sessionClients: ['claude'], grantedBy: adminId });
    for (const session_clients of [[], ['unknown'], 'claude']) {
      const result = await app.inject({ method: 'PUT', url: `/api/projects/project-1/access/${memberId}`, headers: adminHeaders, payload: { can_session: true, can_terminal: false, session_clients } });
      expect(result.statusCode).toBe(400);
    }
    expect(getDb().prepare('SELECT session_clients FROM project_user_access WHERE user_id = ?').get(memberId)).toEqual({ session_clients: '["claude"]' });
  });

  it('migrates old client grants, Agent sessions and assigned roles without losing conversation history', () => {
    const db = getDb();
    setProjectToolAccess({ projectId: 'project-1', userId: memberId, canSession: false, canTerminal: true, sessionClients: [], grantedBy: adminId });
    db.exec(`ALTER TABLE project_user_access ADD COLUMN can_agent INTEGER DEFAULT 0;
      ALTER TABLE project_user_access ADD COLUMN can_claude INTEGER DEFAULT 0;
      ALTER TABLE project_user_access ADD COLUMN can_codex INTEGER DEFAULT 0;
      ALTER TABLE project_user_access DROP COLUMN session_clients;
      ALTER TABLE sessions ADD COLUMN agent_type TEXT;
      ALTER TABLE scheduled_tasks ADD COLUMN new_agent_type TEXT;`);
    db.prepare('UPDATE project_user_access SET can_agent = 1, can_codex = 1 WHERE user_id = ?').run(memberId);
    db.prepare("INSERT INTO sessions (id, project_id, task, status, mode, cli_type, codex_session_id, agent_type, created_by_user_id) VALUES ('legacy-session', 'project-1', 'Previous task', 'completed', 'agent', 'codex', 'native-conversation', 'reviewer', ?)").run(memberId);
    db.prepare("INSERT INTO session_snapshots (session_id, rendered) VALUES ('legacy-session', 'saved screen')").run();
    db.prepare("INSERT INTO scheduled_tasks (id, user_id, project_id, name, prompt, schedule_kind, schedule_value, target_type, new_mode, new_agent_type, enabled) VALUES ('legacy-task', ?, 'project-1', 'Legacy task', 'Work', 'interval', '60', 'new', 'agent', 'reviewer', 0)").run(memberId);
    for (const id of ['observer', 'operator']) db.prepare('INSERT INTO rbac_roles (id, name, builtin) VALUES (?, ?, 1)').run(id, id);
    setRoleGrants('observer', { monitor: 'read' }); setUserRoles(memberId, ['observer']);
    db.pragma('user_version = 9'); closeDb(); initDb();
    expect(getDb().prepare('SELECT can_session, can_terminal, session_clients FROM project_user_access WHERE user_id = ?').get(memberId)).toEqual({ can_session: 1, can_terminal: 1, session_clients: '["codex"]' });
    expect(getDb().prepare("SELECT mode, codex_session_id FROM sessions WHERE id = 'legacy-session'").get()).toEqual({ mode: 'session', codex_session_id: 'native-conversation' });
    expect(getDb().prepare("SELECT rendered FROM session_snapshots WHERE session_id = 'legacy-session'").get()).toEqual({ rendered: 'saved screen' });
    expect(getDb().prepare("SELECT new_mode, enabled FROM scheduled_tasks WHERE id = 'legacy-task'").get()).toEqual({ new_mode: 'session', enabled: 0 });
    expect(getDb().prepare("SELECT builtin FROM rbac_roles WHERE id = 'observer'").get()).toEqual({ builtin: 0 });
    expect(getDb().prepare("SELECT id FROM rbac_roles WHERE id = 'operator'").get()).toBeUndefined();
    const columns = (getDb().prepare('PRAGMA table_info(project_user_access)').all() as { name: string }[]).map((column) => column.name);
    for (const removed of ['can_agent', 'can_claude', 'can_codex']) expect(columns).not.toContain(removed);
    closeDb(); initDb();
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM rbac_roles WHERE id = 'observer'").get()).toEqual({ n: 1 });
  });
});
