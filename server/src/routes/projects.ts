import { FastifyPluginAsync } from 'fastify';
import { getDb } from '../db/index.js';
import { nanoid } from 'nanoid';
import { readdir, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'fs/promises';
import { dirname, join, resolve, basename } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import { getProjectToolAccess, isAdmin as isAdminUser, setProjectToolAccess, removeProjectUserAccess, userOwnsProject, userProjectIds, userCanCreateProjects } from '../auth.js';
import { userHasPermission } from '../services/rbac.js';
import { SESSION_CLIENTS, parseSessionClients } from '../services/session-clients.js';
import { killSession } from '../services/session-manager.js';
import { config } from '../config.js';

export interface Project {
  id: string;
  name: string;
  path: string;
  description: string | null;
  session_prompt: string | null;
  openclaw_prompt: string | null;
  color: string;
  owner_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ProjectAccessRow {
  user_id: string;
  can_session: number;
  can_terminal: number;
  session_clients: string;
  granted_by: string | null;
  created_at: string;
  updated_at: string;
}

function isProjectManager(userId: string, ownerId: string | null): boolean {
  return !!(ownerId && ownerId === userId) || isAdminUser(userId);
}

function toBool(v: number): boolean {
  return Number(v) === 1;
}

/** projects.json beside the configured DB — portable backup, not the source of truth. */
function projectsFile(): string {
  return join(dirname(config.dbPath), 'projects.json');
}

async function canonicalProjectDirectory(input: string): Promise<string> {
  const canonical = await realpath(resolve(input));
  const info = await stat(canonical);
  if (!info.isDirectory()) throw new Error('Project path is not a directory');
  return canonical;
}

/** Export current DB projects to the config file (for portability across DB resets) */
async function exportToConfig(): Promise<void> {
  const db = getDb();
  const rows = db.prepare('SELECT name, path, description, session_prompt, openclaw_prompt FROM projects ORDER BY name COLLATE NOCASE').all();
  const destination = projectsFile();
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ projects: rows }, null, 2), { encoding: 'utf-8', mode: 0o600 });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function findProjectById(db: ReturnType<typeof getDb>, projectId: string): Project | undefined {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Project | undefined;
}

function canReadProject(userId: string, projectId: string): boolean {
  return userOwnsProject(userId, projectId);
}

function canWriteProject(userId: string, project: Project): boolean {
  if (!project) return false;
  return isProjectManager(userId, project.owner_id);
}

function parseAccessRow(row: ProjectAccessRow | undefined) {
  if (!row) return null;
  return {
    can_session: toBool(row.can_session),
    can_terminal: toBool(row.can_terminal),
    session_clients: toBool(row.can_session) ? parseSessionClients(row.session_clients) : [],
    granted_by: row.granted_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function stopUserSessions(userId: string): Promise<void> {
  const rows = getDb().prepare(`
    SELECT id FROM sessions
    WHERE created_by_user_id = ? AND status IN ('pending', 'running', 'detached', 'released')
  `).all(userId) as { id: string }[];
  await Promise.allSettled(rows.map((row) => killSession(row.id)));
}

async function stopAllMemberSessions(): Promise<void> {
  const rows = getDb().prepare(`
    SELECT s.id FROM sessions s
    JOIN users u ON u.id = s.created_by_user_id
    WHERE u.role != 'admin' AND s.status IN ('pending', 'running', 'detached', 'released')
  `).all() as { id: string }[];
  await Promise.allSettled(rows.map((row) => killSession(row.id)));
}

/**
 * Called once on startup. If the DB has no projects but the config file does,
 * import them (handles DB reset / fresh install with existing config).
 */
export async function initProjects(): Promise<void> {
  const db = getDb();
  const count = (db.prepare('SELECT COUNT(*) as n FROM projects').get() as { n: number }).n;

  if (count > 0) {
    // DB has projects — make sure config file is up to date
    await exportToConfig();
    return;
  }

  // DB is empty — try importing from config file
  try {
    const raw = await readFile(projectsFile(), 'utf-8');
    const data = JSON.parse(raw);
    const configs = Array.isArray(data.projects) ? data.projects : [];

    const prepared: Array<Record<string, unknown>> = [];
    for (const p of configs) {
      if (!p || typeof p !== 'object' || typeof p.name !== 'string' || !p.name.trim() || typeof p.path !== 'string') continue;
      try {
        prepared.push({
          ...p,
          id: nanoid(12),
          name: p.name.trim(),
          path: await canonicalProjectDirectory(p.path),
        });
      } catch {
        // Ignore stale or inaccessible paths in the portable backup.
      }
    }
    const insert = db.prepare(`
      INSERT OR IGNORE INTO projects
        (id, name, path, description, session_prompt, openclaw_prompt)
      VALUES (@id, @name, @path, @description, @session_prompt, @openclaw_prompt)
    `);
    const imported = db.transaction((rows: Array<Record<string, unknown>>) => {
      let changes = 0;
      for (const row of rows) {
        changes += insert.run({
          id: row.id,
          name: row.name,
          path: row.path,
          description: row.description || null,
          session_prompt: row.session_prompt || null,
          openclaw_prompt: row.openclaw_prompt || null,
        }).changes;
      }
      return changes;
    })(prepared);
    if (imported > 0) {
      console.log(`  Imported ${imported} projects from ~/.agentmanager/projects.json`);
    }
  } catch {
    // No config file — that's fine, new user starts with empty projects
  }
}

export const projectRoutes: FastifyPluginAsync = async (app) => {
  // List projects
  app.get('/projects', async (req) => {
    const db = getDb();
    const isAdmin = isAdminUser(req.user!.id) || userHasPermission(req.user!.id, 'project_access');
    const allowedProjectIds = [...userProjectIds(req.user!.id)];
    if (!isAdmin && allowedProjectIds.length === 0) return { projects: [] };

    const projects = isAdmin
      ? db.prepare('SELECT * FROM projects ORDER BY name COLLATE NOCASE').all()
      : db.prepare(`SELECT * FROM projects WHERE id IN (${allowedProjectIds.map(() => '?').join(',')}) ORDER BY name COLLATE NOCASE`).all(...allowedProjectIds);
    return {
      projects: (projects as Project[]).map((project) => {
        const access = getProjectToolAccess(req.user!.id, project.id);
        return {
          ...project,
          owner: project.owner_id ? db.prepare('SELECT id, username, display_name FROM users WHERE id = ?').get(project.owner_id) ?? null : null,
          tool_access: access ? {
            can_session: access.canSession,
            can_terminal: access.canTerminal,
            session_clients: access.sessionClients,
          } : null,
        };
      }),
    };
  });

  // Get single project
  app.get<{ Params: { id: string } }>('/projects/:id', async (req, reply) => {
    const db = getDb();
    const project = findProjectById(db, req.params.id);
    if (!project || !canReadProject(req.user!.id, req.params.id)) return reply.status(404).send({ error: 'Project not found' });
    return { project };
  });

  // Create project
  app.post<{
    Body: { name: string; path: string; description?: string; session_prompt?: string; openclaw_prompt?: string; color?: string };
  }>('/projects', async (req, reply) => {
    if (!userCanCreateProjects(req.user!.id)) return reply.status(403).send({ error: '没有添加项目权限，请联系管理员' });
    const { name, path, description, session_prompt, openclaw_prompt, color } = req.body ?? {};
    if (typeof name !== 'string' || !name.trim() || name.length > 128 || typeof path !== 'string' || !path.trim()) {
      return reply.status(400).send({ error: 'A valid name and path are required' });
    }
    let canonicalPath: string;
    try {
      canonicalPath = await canonicalProjectDirectory(path);
    } catch {
      return reply.status(400).send({ error: 'Project path must be an existing directory' });
    }

    const db = getDb();
    const id = nanoid(12);

    const existing = db.prepare('SELECT id FROM projects WHERE path = ?').get(canonicalPath);
    if (existing) return reply.status(409).send({ error: 'Project with this path already exists' });

    db.prepare('INSERT INTO projects (id, name, path, description, session_prompt, openclaw_prompt, color, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, name.trim(), canonicalPath, description || null, session_prompt || null, openclaw_prompt || null, color || '', req.user!.id);

    setProjectToolAccess({
      projectId: id,
      userId: req.user!.id,
      canSession: true,
      canTerminal: true,
      sessionClients: SESSION_CLIENTS.map((client) => client.id),
      grantedBy: req.user!.id,
    });
    // A new registered project must immediately become invisible inside every
    // member's existing OS sandbox.
    await stopAllMemberSessions();

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    await exportToConfig();

    return { ok: true, project };
  });

  // Update project
  app.patch<{
    Params: { id: string };
    Body: { name?: string; description?: string; session_prompt?: string | null; openclaw_prompt?: string | null; color?: string };
  }>('/projects/:id', async (req, reply) => {
    const db = getDb();
    const existing = findProjectById(db, req.params.id);
    if (!existing || !canWriteProject(req.user!.id, existing)) {
      return reply.status(404).send({ error: 'Project not found' });
    }

    const updates: string[] = [];
    const params: unknown[] = [];

    if (req.body.name) { updates.push('name = ?'); params.push(req.body.name); }
    if (req.body.description !== undefined) { updates.push('description = ?'); params.push(req.body.description); }
    if (req.body.session_prompt !== undefined) { updates.push('session_prompt = ?'); params.push(req.body.session_prompt); }
    if (req.body.openclaw_prompt !== undefined) { updates.push('openclaw_prompt = ?'); params.push(req.body.openclaw_prompt); }
    if (req.body.color !== undefined) { updates.push('color = ?'); params.push(req.body.color); }

    if (updates.length === 0) return reply.status(400).send({ error: 'Nothing to update' });

    updates.push("updated_at = datetime('now')");
    params.push(req.params.id);

    const result = db.prepare(`UPDATE projects SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    if (result.changes === 0) return reply.status(404).send({ error: 'Project not found' });

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    await exportToConfig();

    return { ok: true, project };
  });

  // Delete project
  app.delete<{ Params: { id: string } }>('/projects/:id', async (req, reply) => {
    const db = getDb();
    const project = findProjectById(db, req.params.id);
    if (!project || !canWriteProject(req.user!.id, project)) return reply.status(404).send({ error: 'Project not found' });

    // A live process must never outlive the project registration that defines
    // its filesystem boundary. Stop it before removing the foreign key.
    const activeSessions = db.prepare(`
      SELECT id FROM sessions
      WHERE project_id = ?
        AND status IN ('pending', 'launching', 'running', 'detached', 'released')
    `).all(req.params.id) as { id: string }[];
    try {
      await Promise.all(activeSessions.map((session) => killSession(session.id)));
    } catch {
      return reply.status(500).send({ error: 'Failed to stop active project sessions' });
    }

    const result = db.transaction((projectId: string) => {
      // Preserve history while removing the project itself.
      db.prepare('UPDATE sessions SET project_id = NULL WHERE project_id = ?').run(projectId);
      db.prepare('UPDATE tasks SET project_id = NULL WHERE project_id = ?').run(projectId);
      db.prepare('UPDATE events SET project_id = NULL WHERE project_id = ?').run(projectId);
      return db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
    })(req.params.id);
    if (result.changes === 0) return reply.status(404).send({ error: 'Project not found' });

    await exportToConfig();
    return { ok: true };
  });

  // Read project-level tool access grants
  app.get<{
    Params: { id: string };
  }>('/projects/:id/access', async (req, reply) => {
    const db = getDb();
    const project = findProjectById(db, req.params.id);
    if (!project || (!userHasPermission(req.user!.id, 'project_access', 'read') && !canWriteProject(req.user!.id, project))) {
      return reply.status(404).send({ error: 'Project not found' });
    }

    const rows = db.prepare(`
      SELECT
        a.user_id,
        a.can_session,
        a.can_terminal,
        a.session_clients,
        a.granted_by,
        a.updated_at,
        a.created_at,
        u.username,
        u.display_name,
        u.role
      FROM project_user_access a
      JOIN users u ON u.id = a.user_id
      WHERE a.project_id = ?
      ORDER BY u.username COLLATE NOCASE
    `).all(req.params.id) as (ProjectAccessRow & { username: string; display_name: string; role: string })[];

    const access = rows.map((row) => ({
      ...parseAccessRow(row),
      user_id: row.user_id,
      username: row.username,
      display_name: row.display_name,
      role: row.role,
      owner_id: project.owner_id,
    }));

    return { access, clients: SESSION_CLIENTS };
  });

  // Update/create a project's user grant
  app.put<{
    Params: { id: string; userId: string };
    Body: {
      can_session: boolean;
      can_terminal: boolean;
      session_clients: string[];
    };
  }>('/projects/:id/access/:userId', async (req, reply) => {
    const db = getDb();
    const project = findProjectById(db, req.params.id);
    if (!project || (!userHasPermission(req.user!.id, 'project_access', 'write') && !canWriteProject(req.user!.id, project))) {
      return reply.status(404).send({ error: 'Project not found' });
    }

    const target = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.userId) as { id: string } | undefined;
    if (!target) return reply.status(404).send({ error: 'User not found' });

    const body = req.body || {};
    const keys: Array<keyof typeof body> = ['can_session', 'can_terminal'];
    for (const key of keys) {
      if (typeof body[key] !== 'boolean') {
        return reply.status(400).send({ error: `Field ${key} is required` });
      }
    }

    if (!Array.isArray(body.session_clients) || !body.session_clients.every((id) => SESSION_CLIENTS.some((client) => client.id === id))
      || (body.can_session && body.session_clients.length === 0)) {
      return reply.status(400).send({ error: 'Session 必须选择至少一个有效客户端' });
    }
    setProjectToolAccess({
      projectId: req.params.id,
      userId: req.params.userId,
      canSession: body.can_session,
      canTerminal: body.can_terminal,
      sessionClients: body.session_clients,
      grantedBy: req.user!.id,
    });
    // The hidden-path list is fixed when a process starts, so grant changes
    // terminate this user's live sessions and take effect immediately.
    await stopUserSessions(req.params.userId);

    return {
      ok: true,
      access: {
        user_id: req.params.userId,
        can_session: body.can_session,
        can_terminal: body.can_terminal,
        session_clients: body.can_session ? [...new Set(body.session_clients)] : [],
      },
    };
  });

  // Remove a project's explicit user grant
  app.delete<{
    Params: { id: string; userId: string };
  }>('/projects/:id/access/:userId', async (req, reply) => {
    const db = getDb();
    const project = findProjectById(db, req.params.id);
    if (!project || (!userHasPermission(req.user!.id, 'project_access', 'write') && !canWriteProject(req.user!.id, project))) {
      return reply.status(404).send({ error: 'Project not found' });
    }

    const removed = removeProjectUserAccess(req.params.id, req.params.userId);
    if (removed === 0) return reply.status(404).send({ error: 'Grant not found' });
    await stopUserSessions(req.params.userId);
    return { ok: true };
  });

  // Browse directories (for folder picker UI)
  app.get<{
    Querystring: { path?: string };
  }>('/browse', async (req, reply) => {
    if (!userCanCreateProjects(req.user!.id)) return reply.status(403).send({ error: '没有添加项目权限，请联系管理员' });
    const dirPath = resolve(req.query.path || homedir());

    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      const dirs: { name: string; path: string; hasChildren: boolean }[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.')) continue;
        if (entry.name === 'node_modules' || entry.name === '__pycache__') continue;

        const fullPath = join(dirPath, entry.name);
        let hasChildren = false;
        try {
          const sub = await readdir(fullPath, { withFileTypes: true });
          hasChildren = sub.some(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules');
        } catch {
          // Can't read subdirectory
        }

        dirs.push({ name: entry.name, path: fullPath, hasChildren });
      }

      dirs.sort((a, b) => a.name.localeCompare(b.name));

      return {
        path: dirPath,
        parent: dirPath === '/' ? null : resolve(dirPath, '..'),
        folderName: basename(dirPath),
        dirs,
      };
    } catch (err: any) {
      if (err.code === 'ENOENT') return reply.status(404).send({ error: 'Directory not found' });
      if (err.code === 'EACCES') return reply.status(403).send({ error: 'Permission denied' });
      return reply.status(500).send({ error: 'Failed to browse directory' });
    }
  });

};
