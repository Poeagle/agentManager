import type { FastifyReply, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { getDb } from '../db/index.js';

export const PERMISSION_CATALOG = [
  { key: 'monitor', label: '用户监控', levels: ['read', 'write', 'delete'] },
  { key: 'users', label: '用户管理', levels: ['read', 'write', 'delete'] },
  { key: 'roles', label: '角色与权限', levels: ['read', 'write', 'delete'] },
  { key: 'project_access', label: '项目与工具授权', levels: ['read', 'write'] },
  { key: 'settings', label: '平台设置', levels: ['read', 'write'] },
  { key: 'agent_api', label: 'Agent API', levels: ['read', 'write'] },
  { key: 'projects_create', label: '添加项目', levels: ['write'] },
] as const;
export type PermissionKey = typeof PERMISSION_CATALOG[number]['key'];
export type PermissionLevel = 'read' | 'write' | 'delete';
export type PermissionGrants = Partial<Record<PermissionKey, PermissionLevel>>;
const RANK: Record<PermissionLevel, number> = { read: 1, write: 2, delete: 3 };

const BUILTINS = [
  { id: 'admin', name: '平台管理员', description: '管理全部平台功能、用户和授权', permissions: Object.fromEntries(PERMISSION_CATALOG.map((item) => [item.key, item.levels.at(-1)!])) },
  { id: 'member', name: '普通成员', description: '查看设置与使用 Agent API；项目访问按项目授权', permissions: { settings: 'read', agent_api: 'write' } },
];

/** Called inside the schema migration transaction; preserves existing accounts. */
export function migrateRbac(db: Database.Database, migrateUsers: boolean): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rbac_roles (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '',
      builtin INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS rbac_role_permissions (
      role_id TEXT NOT NULL REFERENCES rbac_roles(id) ON DELETE CASCADE,
      permission TEXT NOT NULL, level TEXT NOT NULL CHECK(level IN ('read','write','delete')),
      PRIMARY KEY(role_id, permission)
    );
    CREATE TABLE IF NOT EXISTS rbac_user_roles (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role_id TEXT NOT NULL REFERENCES rbac_roles(id) ON DELETE CASCADE,
      PRIMARY KEY(user_id, role_id)
    );
    CREATE INDEX IF NOT EXISTS idx_rbac_user_roles_role ON rbac_user_roles(role_id);
  `);
  for (const role of BUILTINS) {
    db.prepare('INSERT OR IGNORE INTO rbac_roles (id, name, description, builtin) VALUES (?, ?, ?, 1)').run(role.id, role.name, role.description);
    for (const [key, level] of Object.entries(role.permissions)) {
      db.prepare('INSERT OR IGNORE INTO rbac_role_permissions (role_id, permission, level) VALUES (?, ?, ?)').run(role.id, key, level);
    }
  }
  if (migrateUsers) {
    db.exec(`
      INSERT OR IGNORE INTO rbac_user_roles (user_id, role_id) SELECT id, CASE WHEN role = 'admin' THEN 'admin' ELSE 'member' END FROM users;
    `);
  }
}

export function userRoleIds(userId: string): string[] {
  return (getDb().prepare('SELECT role_id FROM rbac_user_roles WHERE user_id = ? ORDER BY role_id').all(userId) as { role_id: string }[]).map((row) => row.role_id);
}

export function effectivePermissions(userId: string): PermissionGrants {
  const db = getDb();
  const user = db.prepare('SELECT role, disabled, can_create_projects FROM users WHERE id = ?').get(userId) as { role: string; disabled: number; can_create_projects: number } | undefined;
  if (!user || user.disabled) return {};
  if (user.role === 'admin') return { ...BUILTINS[0].permissions } as PermissionGrants;
  const rows = db.prepare(`
    SELECT p.permission, p.level FROM rbac_role_permissions p
    JOIN rbac_user_roles r ON r.role_id = p.role_id WHERE r.user_id = ?
  `).all(userId) as { permission: PermissionKey; level: PermissionLevel }[];
  const result: PermissionGrants = {};
  if (user.can_create_projects) result.projects_create = 'write';
  for (const row of rows) {
    if (RANK[row.level] > RANK[result[row.permission] ?? 'read'] || !result[row.permission]) result[row.permission] = row.level;
  }
  return result;
}

export function userHasPermission(userId: string, permission: PermissionKey, level: PermissionLevel = 'read'): boolean {
  const granted = effectivePermissions(userId)[permission];
  return !!granted && RANK[granted] >= RANK[level];
}

export function requirePermission(req: FastifyRequest, reply: FastifyReply, permission: PermissionKey, level: PermissionLevel = 'read'): boolean {
  if (req.user && userHasPermission(req.user.id, permission, level)) return true;
  reply.code(403).send({ error: '权限不足', permission, required: level });
  return false;
}

export function validateGrants(value: unknown): value is PermissionGrants {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, level]) => {
    const item = PERMISSION_CATALOG.find((permission) => permission.key === key);
    return item && (item.levels as readonly unknown[]).includes(level);
  });
}

export function setRoleGrants(roleId: string, grants: PermissionGrants): void {
  const db = getDb();
  db.prepare('DELETE FROM rbac_role_permissions WHERE role_id = ?').run(roleId);
  const insert = db.prepare('INSERT INTO rbac_role_permissions (role_id, permission, level) VALUES (?, ?, ?)');
  for (const [permission, level] of Object.entries(grants)) insert.run(roleId, permission, level);
}

export function setUserRoles(userId: string, roleIds: string[]): void {
  const db = getDb();
  db.prepare('DELETE FROM rbac_user_roles WHERE user_id = ?').run(userId);
  const insert = db.prepare('INSERT INTO rbac_user_roles (user_id, role_id) VALUES (?, ?)');
  for (const id of new Set(roleIds)) insert.run(userId, id);
  db.prepare("UPDATE users SET role = ?, can_create_projects = 0 WHERE id = ?").run(roleIds.includes('admin') ? 'admin' : 'member', userId);
}
