import type { FastifyPluginAsync } from 'fastify';
import { nanoid } from 'nanoid';
import { getDb } from '../db/index.js';
import { findUserById, destroyUserSessions } from '../auth.js';
import { broadcastEphemeral } from '../services/event-store.js';
import { revokeUserConnections } from '../services/user-connections.js';
import { killSession } from '../services/session-manager.js';
import { PERMISSION_CATALOG, effectivePermissions, requirePermission, setRoleGrants, setUserRoles, userRoleIds, validateGrants } from '../services/rbac.js';

interface RoleRow { id: string; name: string; description: string; builtin: number; }
function roles() {
  const db = getDb();
  return (db.prepare('SELECT * FROM rbac_roles ORDER BY builtin DESC, created_at, name').all() as RoleRow[]).map((role) => ({
    ...role,
    permissions: Object.fromEntries((db.prepare('SELECT permission, level FROM rbac_role_permissions WHERE role_id = ?').all(role.id) as { permission: string; level: string }[]).map((row) => [row.permission, row.level])),
    member_count: (db.prepare('SELECT COUNT(*) AS n FROM rbac_user_roles WHERE role_id = ?').get(role.id) as { n: number }).n,
  }));
}
function changed() { broadcastEphemeral({ type: 'rbac.changed', data: {} }); }

export const rbacRoutes: FastifyPluginAsync = async (app) => {
  app.get('/rbac/me', async (req) => ({
    permissions: effectivePermissions(req.user!.id),
    roles: getDb().prepare('SELECT r.id, r.name FROM rbac_roles r JOIN rbac_user_roles u ON u.role_id = r.id WHERE u.user_id = ? ORDER BY r.name').all(req.user!.id),
    catalog: PERMISSION_CATALOG,
  }));
  app.get('/rbac/roles', async (req, reply) => {
    if (!requirePermission(req, reply, 'roles')) return;
    return { roles: roles(), catalog: PERMISSION_CATALOG };
  });
  app.get('/rbac/assignable-roles', async (req, reply) => {
    if (!requirePermission(req, reply, 'users')) return;
    return { roles: roles().map(({ id, name, builtin }) => ({ id, name, builtin })) };
  });
  app.post('/rbac/roles', async (req, reply) => {
    if (!requirePermission(req, reply, 'roles', 'write')) return;
    const { name, description = '', permissions } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 64 || typeof description !== 'string' || description.length > 500 || !validateGrants(permissions)) return reply.code(400).send({ error: '角色名称或权限配置无效' });
    const db = getDb();
    if (db.prepare('SELECT id FROM rbac_roles WHERE name = ?').get(name.trim())) return reply.code(409).send({ error: '角色名称已存在' });
    const id = nanoid(12);
    db.transaction(() => {
      db.prepare('INSERT INTO rbac_roles (id, name, description) VALUES (?, ?, ?)').run(id, name.trim(), description.trim());
      setRoleGrants(id, permissions);
    })();
    changed();
    return reply.code(201).send({ role: roles().find((role) => role.id === id) });
  });
  app.put<{ Params: { id: string } }>('/rbac/roles/:id', async (req, reply) => {
    if (!requirePermission(req, reply, 'roles', 'write')) return;
    const db = getDb();
    const role = db.prepare('SELECT * FROM rbac_roles WHERE id = ?').get(req.params.id) as RoleRow | undefined;
    if (!role) return reply.code(404).send({ error: '角色不存在' });
    if (role.builtin) return reply.code(409).send({ error: '内置角色不可修改，请创建自定义角色' });
    const { name, description = '', permissions } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 64 || typeof description !== 'string' || description.length > 500 || !validateGrants(permissions)) return reply.code(400).send({ error: '角色名称或权限配置无效' });
    if (db.prepare('SELECT id FROM rbac_roles WHERE name = ? AND id != ?').get(name.trim(), role.id)) return reply.code(409).send({ error: '角色名称已存在' });
    db.transaction(() => {
      db.prepare('UPDATE rbac_roles SET name = ?, description = ? WHERE id = ?').run(name.trim(), description.trim(), role.id);
      setRoleGrants(role.id, permissions);
    })();
    changed();
    return { role: roles().find((item) => item.id === role.id) };
  });
  app.delete<{ Params: { id: string } }>('/rbac/roles/:id', async (req, reply) => {
    if (!requirePermission(req, reply, 'roles', 'delete')) return;
    const db = getDb();
    const role = db.prepare('SELECT * FROM rbac_roles WHERE id = ?').get(req.params.id) as RoleRow | undefined;
    if (!role) return reply.code(404).send({ error: '角色不存在' });
    if (role.builtin) return reply.code(409).send({ error: '内置角色不可删除' });
    if (db.prepare('SELECT 1 FROM rbac_user_roles WHERE role_id = ? LIMIT 1').get(role.id)) return reply.code(409).send({ error: '请先解除所有用户的角色分配' });
    db.prepare('DELETE FROM rbac_roles WHERE id = ?').run(role.id);
    changed();
    return { ok: true };
  });
  app.put<{ Params: { id: string } }>('/rbac/users/:id/roles', async (req, reply) => {
    if (!requirePermission(req, reply, 'roles', 'write')) return;
    const target = findUserById(req.params.id);
    if (!target) return reply.code(404).send({ error: '用户不存在' });
    const { role_ids } = (req.body ?? {}) as Record<string, unknown>;
    if (!Array.isArray(role_ids) || role_ids.length > 50 || !role_ids.every((id) => typeof id === 'string' && getDb().prepare('SELECT 1 FROM rbac_roles WHERE id = ?').get(id))) return reply.code(400).send({ error: '角色列表无效' });
    const db = getDb();
    if (target.role === 'admin' && !role_ids.includes('admin') && !target.disabled) {
      const count = (db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get() as { n: number }).n;
      if (count <= 1) return reply.code(409).send({ error: '不能移除最后一个有效管理员' });
    }
    db.transaction(() => setUserRoles(target.id, role_ids))();
    if (target.role === 'admin' && !role_ids.includes('admin')) {
      destroyUserSessions(target.id);
      revokeUserConnections(target.id);
      const sessions = db.prepare("SELECT id FROM sessions WHERE created_by_user_id = ? AND status IN ('pending','launching','running','detached','released')").all(target.id) as { id: string }[];
      await Promise.all(sessions.map(({ id }) => killSession(id)));
    }
    changed();
    return { ok: true, role_ids: userRoleIds(target.id) };
  });
};
