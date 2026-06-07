import { FastifyPluginAsync } from 'fastify';
import { readdir, readFile, writeFile, mkdir, rm } from 'fs/promises';
import { join, resolve, dirname } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import { getDb } from '../db/index.js';
import { userOwnsProject } from '../auth.js';

/* ================================================================
   Skill manager — enumerate / create / delete SKILL.md-format skills
   for a PROJECT.

   A "skill" is a sub-directory containing a SKILL.md file
   (frontmatter: name/description). Scoped per project:

     • 本项目  <project>/.claude/skills   — read/write (CRUD)
     • 全局    ~/.claude/skills           — read-only reference
     • 全局    ~/.codex/skills            — read-only reference
     • 全局    ~/.codex/skills/.system    — read-only reference

   Only the project location is writable; the global ones are listed
   for reference (skills inherited into every project) but can't be
   created/deleted from here.

   Browsing/editing the FILES inside a skill is handled by the shared
   FileExplorer component via the generic /api/files endpoints — this
   route only deals with whole-skill listing and lifecycle.
   ================================================================ */

interface SkillLocation {
  key: string;                 // 'claude:project'
  tool: 'claude' | 'codex';
  toolLabel: string;           // 'Claude Code'
  scope: 'project' | 'user' | 'system';
  label: string;               // shown as the directory group label
  dir: string;                 // absolute path to the skills directory
  readOnly: boolean;           // global stores: can't create/delete whole skills here
  excludeDirs?: string[];      // sub-dir names to skip (e.g. Codex's '.system')
}

/** Single source of truth for where skills live, relative to a project. */
function getLocations(projectPath: string): SkillLocation[] {
  const home = homedir();
  return [
    {
      key: 'claude:project', tool: 'claude', toolLabel: 'Claude Code', scope: 'project',
      label: '本项目 · .claude/skills', dir: join(projectPath, '.claude', 'skills'), readOnly: false,
    },
    {
      key: 'claude:user', tool: 'claude', toolLabel: 'Claude Code', scope: 'user',
      label: '全局 · ~/.claude/skills', dir: join(home, '.claude', 'skills'), readOnly: true,
    },
    {
      key: 'codex:user', tool: 'codex', toolLabel: 'Codex', scope: 'user',
      label: '全局 · ~/.codex/skills', dir: join(home, '.codex', 'skills'), readOnly: true,
      excludeDirs: ['.system'],
    },
    {
      key: 'codex:system', tool: 'codex', toolLabel: 'Codex', scope: 'system',
      label: '全局 · ~/.codex/skills/.system', dir: join(home, '.codex', 'skills', '.system'), readOnly: true,
    },
  ];
}

function findLocation(projectPath: string, tool: string, scope: string): SkillLocation | undefined {
  return getLocations(projectPath).find((l) => l.tool === tool && l.scope === scope);
}

/** Resolve { path } from a project id, enforcing ownership. */
function resolveProjectPath(userId: string, projectId: string | undefined):
  | { ok: true; path: string }
  | { ok: false; code: number; error: string } {
  if (!projectId) return { ok: false, code: 400, error: 'project_id is required' };
  if (!userOwnsProject(userId, projectId)) return { ok: false, code: 404, error: 'Project not found' };
  const p = getDb().prepare('SELECT path FROM projects WHERE id = ?').get(projectId) as { path: string } | undefined;
  if (!p?.path) return { ok: false, code: 404, error: 'Project path not found' };
  return { ok: true, path: p.path };
}

const SKILL_NAME_RE = /^[A-Za-z0-9._-]+$/;
function isValidSkillName(name: string | undefined): name is string {
  return !!name && name.length <= 100 && name !== '.' && name !== '..'
    && !name.includes('/') && !name.includes('\\') && SKILL_NAME_RE.test(name);
}

/** Resolve a skill dir inside a location, rejecting any path traversal. */
function resolveSkillDir(loc: SkillLocation, name: string): string | null {
  if (!isValidSkillName(name)) return null;
  const target = resolve(loc.dir, name);
  // Must be a direct child of the location dir — defends against traversal.
  if (dirname(target) !== resolve(loc.dir)) return null;
  return target;
}

/** Parse name/description from SKILL.md frontmatter (mirrors projects.ts). */
function parseFrontmatter(content: string): { name?: string; description?: string } {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const fm = m[1];
  const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim()?.replace(/^["']|["']$/g, '');
  const description = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim()?.replace(/^["']|["']$/g, '');
  return { name, description };
}

async function countFiles(dir: string): Promise<number> {
  let count = 0;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    if (e.name === '__pycache__') continue;
    if (e.isDirectory()) count += await countFiles(join(dir, e.name));
    else count += 1;
  }
  return count;
}

async function listSkillsIn(loc: SkillLocation) {
  const out: { name: string; dirName: string; description: string; fileCount: number; path: string }[] = [];
  if (!existsSync(loc.dir)) return out;
  let entries;
  try { entries = await readdir(loc.dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (loc.excludeDirs?.includes(e.name)) continue;
    const skillDir = join(loc.dir, e.name);
    const skillMd = join(skillDir, 'SKILL.md');
    if (!existsSync(skillMd)) continue; // only dirs with a SKILL.md count as skills
    let name = e.name;
    let description = '';
    try {
      const fm = parseFrontmatter(await readFile(skillMd, 'utf-8'));
      if (fm.name) name = fm.name;
      if (fm.description) description = fm.description;
    } catch {}
    out.push({ name, dirName: e.name, description, fileCount: await countFiles(skillDir), path: skillDir });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export const skillsRoutes: FastifyPluginAsync = async (app) => {
  // List a project's skills grouped by location (project + global references).
  app.get<{ Querystring: { project_id?: string } }>('/skills', async (req, reply) => {
    const r = resolveProjectPath(req.user!.id, req.query.project_id);
    if (!r.ok) return reply.status(r.code).send({ error: r.error });

    const groups = [];
    for (const loc of getLocations(r.path)) {
      groups.push({
        key: loc.key,
        tool: loc.tool,
        toolLabel: loc.toolLabel,
        scope: loc.scope,
        label: loc.label,
        dir: loc.dir,
        readOnly: loc.readOnly,
        skills: await listSkillsIn(loc),
      });
    }
    return { groups };
  });

  // Create a new skill (scaffolds <dir>/<name>/SKILL.md). Files inside are
  // then edited via the FileExplorer / /api/files endpoints. Project scope only.
  app.post<{ Params: { tool: string; scope: string }; Body: { project_id?: string; name: string; description?: string; content?: string } }>(
    '/skills/:tool/:scope',
    async (req, reply) => {
      const body = (req.body || {}) as { project_id?: string; name: string; description?: string; content?: string };
      const r = resolveProjectPath(req.user!.id, body.project_id);
      if (!r.ok) return reply.status(r.code).send({ error: r.error });

      const loc = findLocation(r.path, req.params.tool, req.params.scope);
      if (!loc) return reply.status(404).send({ error: 'Unknown skill location' });
      if (loc.readOnly) return reply.status(403).send({ error: 'This skill location is read-only' });

      const { name, description, content } = body;
      if (!isValidSkillName(name)) {
        return reply.status(400).send({ error: 'Invalid skill name — use letters, digits, dot, underscore or hyphen' });
      }
      const skillDir = resolveSkillDir(loc, name)!;
      if (existsSync(skillDir)) return reply.status(409).send({ error: 'A skill with this name already exists' });

      const skillBody = content && content.trim()
        ? content
        : `---\nname: ${name}\ndescription: ${description?.trim() || 'TODO: describe when this skill should be used.'}\n---\n\n# ${name}\n\nTODO: write the skill instructions here.\n`;
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, 'SKILL.md'), skillBody, 'utf-8');
      return { ok: true, tool: loc.tool, scope: loc.scope, dirName: name, path: skillDir };
    },
  );

  // Delete a skill (removes the whole skill directory). Project scope only.
  app.delete<{ Params: { tool: string; scope: string; name: string }; Querystring: { project_id?: string } }>(
    '/skills/:tool/:scope/:name',
    async (req, reply) => {
      const r = resolveProjectPath(req.user!.id, req.query.project_id);
      if (!r.ok) return reply.status(r.code).send({ error: r.error });

      const loc = findLocation(r.path, req.params.tool, req.params.scope);
      if (!loc) return reply.status(404).send({ error: 'Unknown skill location' });
      if (loc.readOnly) return reply.status(403).send({ error: 'This skill location is read-only' });
      const skillDir = resolveSkillDir(loc, req.params.name);
      if (!skillDir) return reply.status(400).send({ error: 'Invalid skill name' });
      if (!existsSync(skillDir)) return reply.status(404).send({ error: 'Skill not found' });

      await rm(skillDir, { recursive: true, force: true });
      return { ok: true };
    },
  );
};
