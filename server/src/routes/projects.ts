import { FastifyPluginAsync } from 'fastify';
import { getDb } from '../db/index.js';
import { nanoid } from 'nanoid';
import { readdir, mkdir, readFile, writeFile } from 'fs/promises';
import { join, resolve, basename } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import { installDefaultAgents } from '../data/default-agents.js';

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
  created_at: string;
  updated_at: string;
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
    const projects = db.prepare('SELECT * FROM projects WHERE owner_id = ? ORDER BY name COLLATE NOCASE').all(req.user!.id);
    return { projects };
  });

  // Get single project
  app.get<{ Params: { id: string } }>('/projects/:id', async (req, reply) => {
    const db = getDb();
    const project = db.prepare('SELECT * FROM projects WHERE id = ? AND owner_id = ?').get(req.params.id, req.user!.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    return { project };
  });

  // Create project
  app.post<{
    Body: { name: string; path: string; description?: string; session_prompt?: string; openclaw_prompt?: string; default_web_url?: string; color?: string };
  }>('/projects', async (req, reply) => {
    const { name, path, description, session_prompt, openclaw_prompt, default_web_url, color } = req.body;
    if (!name || !path) return reply.status(400).send({ error: 'name and path are required' });

    const db = getDb();
    const id = nanoid(12);

    const existing = db.prepare('SELECT id FROM projects WHERE path = ?').get(path);
    if (existing) return reply.status(409).send({ error: 'Project with this path already exists' });

    db.prepare('INSERT INTO projects (id, name, path, description, session_prompt, openclaw_prompt, default_web_url, color, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, name, path, description || null, session_prompt || null, openclaw_prompt || null, default_web_url || null, color || '', req.user!.id);

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
    params.push(req.user!.id);

    const result = db.prepare(`UPDATE projects SET ${updates.join(', ')} WHERE id = ? AND owner_id = ?`).run(...params);
    if (result.changes === 0) return reply.status(404).send({ error: 'Project not found' });

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    await exportToConfig();

    return { ok: true, project };
  });

  // Delete project
  app.delete<{ Params: { id: string } }>('/projects/:id', async (req, reply) => {
    const db = getDb();
    // Verify ownership before touching anything.
    const owned = db.prepare('SELECT 1 FROM projects WHERE id = ? AND owner_id = ?').get(req.params.id, req.user!.id);
    if (!owned) return reply.status(404).send({ error: 'Project not found' });
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
    const val = req.body.skip_permissions ? 1 : 0;
    const result = db.prepare('UPDATE projects SET skip_permissions = ?, updated_at = datetime(\'now\') WHERE owner_id = ?').run(val, req.user!.id);
    return { ok: true, updated: result.changes };
  });

  // List available agent types for a project (reads .claude/agents/*.md from project + global)
  app.get<{
    Params: { id: string };
  }>('/projects/:id/agents', async (req, reply) => {
    const db = getDb();
    const project = db.prepare('SELECT * FROM projects WHERE id = ? AND owner_id = ?').get(req.params.id, req.user!.id) as Project | undefined;
    if (!project) return reply.status(404).send({ error: 'Project not found' });

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

  // Browse directories (for folder picker UI)
  app.get<{
    Querystring: { path?: string };
  }>('/browse', async (req, reply) => {
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
