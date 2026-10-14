import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authHook, createSession, createUser, userCanCreateProjects } from '../src/auth.js';
import { getDb } from '../src/db/index.js';
import { rbacRoutes } from '../src/routes/rbac.js';
import { userRoutes } from '../src/routes/users.js';
import { settingsRoutes } from '../src/routes/settings.js';
import { agentRoutes } from '../src/routes/agent.js';
import { projectRoutes } from '../src/routes/projects.js';
import { effectivePermissions, migrateRbac, setRoleGrants, setUserRoles } from '../src/services/rbac.js';
import { createTestDatabase } from './helpers/database.js';

describe('platform RBAC', () => {
  let app: FastifyInstance;
  let cleanup: () => void;
  let adminId: string;
  let memberId: string;
  let adminHeaders: { cookie: string };
  let memberHeaders: { cookie: string };
  beforeEach(async () => {
    ({ cleanup } = createTestDatabase());
    adminId = createUser({ username: 'admin', password: 'password1', role: 'admin' }).id;
    memberId = createUser({ username: 'member', password: 'password1' }).id;
    getDb().prepare("INSERT INTO rbac_roles (id, name) VALUES ('observer', 'Test observer')").run();
    setRoleGrants('observer', { monitor: 'read' });
    adminHeaders = { cookie: `agentmanager_session=${createSession(adminId)}` };
    memberHeaders = { cookie: `agentmanager_session=${createSession(memberId)}` };
    app = Fastify();
    await app.register(websocket);
    app.addHook('onRequest', authHook);
    for (const plugin of [rbacRoutes, userRoutes, settingsRoutes, agentRoutes, projectRoutes]) await app.register(plugin, { prefix: '/api' });
  });
  afterEach(async () => { await app.close(); cleanup(); });

  async function customRole(permissions: Record<string, string>, name = 'Custom role') {
    const response = await app.inject({ method: 'POST', url: '/api/rbac/roles', headers: adminHeaders, payload: { name, permissions } });
    expect(response.statusCode).toBe(201);
    return response.json().role;
  }
  async function assign(id: string, roleIds: string[]) {
    return app.inject({ method: 'PUT', url: `/api/rbac/users/${id}/roles`, headers: adminHeaders, payload: { role_ids: roleIds } });
  }

  it('migrates legacy admin, member and project creation rights once', () => {
    getDb().prepare('DELETE FROM rbac_user_roles').run();
    getDb().prepare('UPDATE users SET can_create_projects = 1 WHERE id = ?').run(memberId);
    migrateRbac(getDb(), true);
    expect(effectivePermissions(adminId)).toMatchObject({ roles: 'delete', users: 'delete' });
    expect(effectivePermissions(memberId)).toMatchObject({ settings: 'read', agent_api: 'write', projects_create: 'write' });
    setUserRoles(memberId, ['observer']);
    migrateRbac(getDb(), false);
    expect(effectivePermissions(memberId)).toEqual({ monitor: 'read' });
    expect(userCanCreateProjects(memberId)).toBe(false);
  });

  it('denies ungranted management APIs while allowing members to inspect their own permissions', async () => {
    expect((await app.inject({ url: '/api/rbac/me', headers: memberHeaders })).json().permissions).toEqual({ settings: 'read', agent_api: 'write' });
    for (const url of ['/api/rbac/roles', '/api/users', '/api/admin/server-resources', '/api/admin/monitor']) expect((await app.inject({ url, headers: memberHeaders })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/rbac/roles', headers: memberHeaders, payload: { name: 'Escalation', permissions: { roles: 'delete' } } })).statusCode).toBe(403);
  });

  it('combines assigned roles at the highest level and applies revocation immediately', async () => {
    const reader = await customRole({ monitor: 'read', settings: 'read' }, 'Reader');
    const writer = await customRole({ settings: 'write', projects_create: 'write' }, 'Writer');
    expect((await assign(memberId, [reader.id, writer.id])).statusCode).toBe(200);
    expect(effectivePermissions(memberId)).toEqual({ monitor: 'read', settings: 'write', projects_create: 'write' });
    expect(userCanCreateProjects(memberId)).toBe(true);
    expect((await app.inject({ method: 'PUT', url: '/api/settings', headers: memberHeaders, payload: { settings: { terminal_font_size: '14' } } })).statusCode).toBe(200);
    expect((await assign(memberId, [reader.id])).statusCode).toBe(200);
    expect((await app.inject({ method: 'PUT', url: '/api/settings', headers: memberHeaders, payload: { settings: { terminal_font_size: '16' } } })).statusCode).toBe(403);
    expect(userCanCreateProjects(memberId)).toBe(false);
  });

  it('enforces separate read, edit and delete monitoring grants', async () => {
    expect((await assign(memberId, ['observer'])).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/admin/monitor', headers: memberHeaders })).statusCode).toBe(200);
    const url = `/api/admin/monitor/users/${adminId}/projects/project-1/tabs/session-1`;
    expect((await app.inject({ method: 'PATCH', url, headers: memberHeaders, payload: { name: 'Rename' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url, headers: memberHeaders })).statusCode).toBe(403);
    const role = await customRole({ monitor: 'write' });
    await assign(memberId, [role.id]);
    expect((await app.inject({ method: 'PATCH', url, headers: memberHeaders, payload: { name: 'Rename' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url, headers: memberHeaders })).statusCode).toBe(403);
  });

  it('prevents identity managers from granting roles or taking over privileged accounts', async () => {
    const manager = await customRole({ users: 'delete' });
    await assign(memberId, [manager.id]);
    expect((await app.inject({ url: '/api/users', headers: memberHeaders })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/users', headers: memberHeaders, payload: { username: 'new-member', password: 'password1' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/users', headers: memberHeaders, payload: { username: 'new-admin', password: 'password1', role: 'admin' } })).statusCode).toBe(403);
    for (const payload of [{ role: 'admin' }, { password: 'password2' }, { disabled: true }]) expect((await app.inject({ method: 'PATCH', url: `/api/users/${adminId}`, headers: memberHeaders, payload })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/users/${adminId}`, headers: memberHeaders })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: `/api/rbac/users/${memberId}/roles`, headers: memberHeaders, payload: { role_ids: ['admin'] } })).statusCode).toBe(403);
  });

  it('protects built-in roles, the final admin, and roles with assigned members', async () => {
    expect((await app.inject({ method: 'PUT', url: '/api/rbac/roles/admin', headers: adminHeaders, payload: { name: 'Broken', permissions: {} } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'DELETE', url: '/api/rbac/roles/member', headers: adminHeaders })).statusCode).toBe(409);
    expect((await assign(adminId, ['member'])).statusCode).toBe(409);
    const role = await customRole({ monitor: 'read' });
    await assign(memberId, [role.id]);
    expect((await app.inject({ method: 'DELETE', url: `/api/rbac/roles/${role.id}`, headers: adminHeaders })).statusCode).toBe(409);
    await assign(memberId, ['member']);
    expect((await app.inject({ method: 'DELETE', url: `/api/rbac/roles/${role.id}`, headers: adminHeaders })).statusCode).toBe(200);
  });

  it.each([{ unknown: 'read' }, { settings: 'delete' }, { users: 'root' }])('rejects invalid grants atomically: %j', async (permissions) => {
    const response = await app.inject({ method: 'POST', url: '/api/rbac/roles', headers: adminHeaders, payload: { name: 'Invalid role', permissions } });
    expect(response.statusCode).toBe(400);
    expect(getDb().prepare("SELECT id FROM rbac_roles WHERE name = 'Invalid role'").get()).toBeUndefined();
  });

  it('requires Agent API read for inspection and write for commands, even over WebSocket', async () => {
    const role = await customRole({ agent_api: 'read' });
    await assign(memberId, [role.id]);
    expect((await app.inject({ url: '/api/agent/capabilities', headers: memberHeaders })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/sessions/any/execute', headers: memberHeaders, payload: { prompt: 'Run command' } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/sessions/any/agent', headers: memberHeaders })).statusCode).toBe(403);
    await assign(memberId, ['observer']);
    expect((await app.inject({ url: '/api/agent/capabilities', headers: memberHeaders })).statusCode).toBe(403);
  });

  it('lets project permission managers configure grants without granting filesystem access', async () => {
    getDb().prepare('INSERT INTO projects (id, name, path, owner_id) VALUES (?, ?, ?, ?)').run('private-project', 'Private project', '/tmp/rbac-private-project', adminId);
    const role = await customRole({ project_access: 'write' });
    await assign(memberId, [role.id]);
    expect((await app.inject({ url: '/api/projects', headers: memberHeaders })).json().projects).toHaveLength(1);
    expect((await app.inject({ url: '/api/projects/private-project/access', headers: memberHeaders })).statusCode).toBe(200);
    const response = await app.inject({ method: 'PUT', url: `/api/projects/private-project/access/${memberId}`, headers: memberHeaders, payload: { can_session: false, can_terminal: true, session_clients: [] } });
    expect(response.statusCode).toBe(200);
  });

  it('removes disabled identities from every effective permission', () => {
    getDb().prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(adminId);
    expect(effectivePermissions(adminId)).toEqual({});
  });
});
