import { FastifyPluginAsync } from 'fastify';
import { getDb } from '../db/index.js';
import { nanoid } from 'nanoid';
import { readdir, mkdir, readFile, writeFile } from 'fs/promises';
import { join, resolve, basename } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import { installDefaultAgents } from '../data/default-agents.js';
import { getProjectToolAccess, isAdmin as isAdminUser, setProjectToolAccess, removeProjectUserAccess, userOwnsProject, userProjectIds } from '../auth.js';
import { killSession } from '../services/session-manager.js';

export interface Project {
  id: string;
  name: string;
  path: string;
  description: string | null;
  session_prompt: string | null;
  openclaw_prompt: string | null;
  default_web_url: string | null;
  skip_permissions: number;
  color: string;
  owner_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ProjectAccessRow {
  user_id: string;
  can_session: number;
  can_agent: number;
  can_terminal: number;
  can_claude: number;
  can_codex: number;
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

/** ~/.agentmanager/projects.json — portable backup, not the source of truth */
const AGENTMANAGER_DIR = join(homedir(), '.agentmanager');
const PROJECTS_FILE = join(AGENTMANAGER_DIR, 'projects.json');

/** Export current DB projects to the config file (for portability across DB resets) */
async function exportToConfig(): Promise<void> {
  const db = getDb();
  const rows = db.prepare('SELECT name, path, description, session_prompt, openclaw_prompt, default_web_url FROM projects ORDER BY name COLLATE NOCASE').all();
  await mkdir(AGENTMANAGER_DIR, { recursive: true });
  await writeFile(PROJECTS_FILE, JSON.stringify({ projects: rows }, null, 2), 'utf-8');
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
    can_agent: toBool(row.can_agent),
    can_terminal: toBool(row.can_terminal),
    can_claude: toBool(row.can_claude),
    can_codex: toBool(row.can_codex),
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
    const raw = await readFile(PROJECTS_FILE, 'utf-8');
    const data = JSON.parse(raw);
    const configs = Array.isArray(data.projects) ? data.projects : [];

    let imported = 0;
    for (const p of configs) {
      if (!p.name || !p.path) continue;
      const id = nanoid(12);
      db.prepare('INSERT INTO projects (id, name, path, description, session_prompt, openclaw_prompt, default_web_url) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, p.name, p.path, p.description || null, p.session_prompt || null, p.openclaw_prompt || null, p.default_web_url || null);
      imported++;
    }
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
    const isAdmin = isAdminUser(req.user!.id);
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
          tool_access: access ? {
            can_session: access.canSession,
            can_agent: access.canAgent,
            can_terminal: access.canTerminal,
            can_claude: access.canClaude,
            can_codex: access.canCodex,
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
    Body: { name: string; path: string; description?: string; session_prompt?: string; openclaw_prompt?: string; default_web_url?: string; color?: string };
  }>('/projects', async (req, reply) => {
    if (!isAdminUser(req.user!.id)) return reply.status(403).send({ error: 'Admin only' });
    const { name, path, description, session_prompt, openclaw_prompt, default_web_url, color } = req.body;
    if (!name || !path) return reply.status(400).send({ error: 'name and path are required' });

    const db = getDb();
    const id = nanoid(12);

    const existing = db.prepare('SELECT id FROM projects WHERE path = ?').get(path);
    if (existing) return reply.status(409).send({ error: 'Project with this path already exists' });

    db.prepare('INSERT INTO projects (id, name, path, description, session_prompt, openclaw_prompt, default_web_url, color, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, name, path, description || null, session_prompt || null, openclaw_prompt || null, default_web_url || null, color || '', req.user!.id);

    setProjectToolAccess({
      projectId: id,
      userId: req.user!.id,
      canSession: true,
      canAgent: true,
      canTerminal: true,
      canClaude: true,
      canCodex: true,
      grantedBy: req.user!.id,
    });
    // A new registered project must immediately become invisible inside every
    // member's existing OS sandbox.
    await stopAllMemberSessions();

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    await exportToConfig();

    // Ensure default agents are installed (no-op if marker exists)
    try { installDefaultAgents(); } catch { /* non-fatal */ }

    return { ok: true, project };
  });

  // Update project
  app.patch<{
    Params: { id: string };
    Body: { name?: string; description?: string; session_prompt?: string | null; openclaw_prompt?: string | null; default_web_url?: string | null; skip_permissions?: number; color?: string };
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
    if (req.body.default_web_url !== undefined) { updates.push('default_web_url = ?'); params.push(req.body.default_web_url); }
    if (req.body.skip_permissions !== undefined) { updates.push('skip_permissions = ?'); params.push(req.body.skip_permissions ? 1 : 0); }
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

    // Nullify foreign key references before deleting (sessions/tasks/events may reference this project)
    db.prepare('UPDATE sessions SET project_id = NULL WHERE project_id = ?').run(req.params.id);
    db.prepare('UPDATE tasks SET project_id = NULL WHERE project_id = ?').run(req.params.id);
    db.prepare('UPDATE events SET project_id = NULL WHERE project_id = ?').run(req.params.id);
    const result = db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
    if (result.changes === 0) return reply.status(404).send({ error: 'Project not found' });

    await exportToConfig();
    return { ok: true };
  });

  // Set skip_permissions for all projects at once
  app.put<{
    Body: { skip_permissions: boolean };
  }>('/projects/skip-permissions-all', async (req, reply) => {
    const db = getDb();
    if (!isAdminUser(req.user!.id)) return reply.status(403).send({ error: 'Admin only' });
    const val = req.body.skip_permissions ? 1 : 0;
    const result = db.prepare('UPDATE projects SET skip_permissions = ?, updated_at = datetime(\'now\')').run(val);
    return { ok: true, updated: result.changes };
  });

  // List available agent types for a project (reads .claude/agents/*.md from project + global)
  app.get<{
    Params: { id: string };
  }>('/projects/:id/agents', async (req, reply) => {
    const db = getDb();
    const project = findProjectById(db, req.params.id);
    if (!project || !canReadProject(req.user!.id, req.params.id)) return reply.status(404).send({ error: 'Project not found' });

    const agents: { name: string; type: string; description: string; category: string }[] = [];

    const walkDir = async (dir: string, category: string) => {
      if (!existsSync(dir)) return;
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            await walkDir(fullPath, entry.name);
          } else if (entry.name.endsWith('.md')) {
            try {
              const content = await readFile(fullPath, 'utf-8');
              const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
              if (frontmatterMatch) {
                const fm = frontmatterMatch[1];
                const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim()?.replace(/^["']|["']$/g, '');
                const type = fm.match(/^type:\s*(.+)$/m)?.[1]?.trim()?.replace(/^["']|["']$/g, '') || '';
                const desc = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim()?.replace(/^["']|["']$/g, '') || '';
                if (name) {
                  agents.push({ name, type, description: desc, category });
                }
              }
            } catch {}
          }
        }
      } catch {}
    };

    // Scan both global and project-level agent directories
    await walkDir(join(homedir(), '.claude', 'agents'), 'global');
    await walkDir(join(project.path, '.claude', 'agents'), 'project');

    // Deduplicate by name (project-level overrides global)
    const seen = new Set<string>();
    const unique = agents.filter(a => {
      if (seen.has(a.name)) return false;
      seen.add(a.name);
      return true;
    });
    unique.sort((a, b) => a.name.localeCompare(b.name));

    return { agents: unique };
  });

  // Read project-level tool access grants
  app.get<{
    Params: { id: string };
  }>('/projects/:id/access', async (req, reply) => {
    const db = getDb();
    const project = findProjectById(db, req.params.id);
    if (!project || !canWriteProject(req.user!.id, project)) {
      return reply.status(404).send({ error: 'Project not found' });
    }

    const rows = db.prepare(`
      SELECT
        a.user_id,
        a.can_session,
        a.can_agent,
        a.can_terminal,
        a.can_claude,
        a.can_codex,
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

    return { access };
  });

  // Update/create a project's user grant
  app.put<{
    Params: { id: string; userId: string };
    Body: {
      can_session: boolean;
      can_agent: boolean;
      can_terminal: boolean;
      can_claude: boolean;
      can_codex: boolean;
    };
  }>('/projects/:id/access/:userId', async (req, reply) => {
    const db = getDb();
    const project = findProjectById(db, req.params.id);
    if (!project || !canWriteProject(req.user!.id, project)) {
      return reply.status(404).send({ error: 'Project not found' });
    }

    const target = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.userId) as { id: string } | undefined;
    if (!target) return reply.status(404).send({ error: 'User not found' });

    const body = req.body || {};
    const keys: Array<keyof typeof body> = ['can_session', 'can_agent', 'can_terminal', 'can_claude', 'can_codex'];
    for (const key of keys) {
      if (typeof body[key] !== 'boolean') {
        return reply.status(400).send({ error: `Field ${key} is required` });
      }
    }

    setProjectToolAccess({
      projectId: req.params.id,
      userId: req.params.userId,
      canSession: body.can_session,
      canAgent: body.can_agent,
      canTerminal: body.can_terminal,
      canClaude: body.can_claude,
      canCodex: body.can_codex,
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
        can_agent: body.can_agent,
        can_terminal: body.can_terminal,
        can_claude: body.can_claude,
        can_codex: body.can_codex,
      },
    };
  });

  // Remove a project's explicit user grant
  app.delete<{
    Params: { id: string; userId: string };
  }>('/projects/:id/access/:userId', async (req, reply) => {
    const db = getDb();
    const project = findProjectById(db, req.params.id);
    if (!project || !canWriteProject(req.user!.id, project)) {
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
    if (!isAdminUser(req.user!.id)) return reply.status(403).send({ error: 'Admin only' });
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
