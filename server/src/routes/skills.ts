import { FastifyPluginAsync } from 'fastify';
import { readdir, readFile, writeFile, mkdir, rm, mkdtemp, rename } from 'fs/promises';
import { join, resolve, dirname } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import { unzipSync, type UnzipFileInfo } from 'fflate';
import { getDb } from '../db/index.js';
import { userOwnsProject } from '../auth.js';

/* ================================================================
   Skill manager — enumerate / create / delete SKILL.md-format skills
   for a PROJECT.

   A "skill" is a sub-directory containing a SKILL.md file
   (frontmatter: name/description). Scoped per project:

     • 本项目  <project>/.claude/skills   — read/write (CRUD)
     • 本项目  <project>/.agents/skills   — read/write (Codex / universal agents)
     • 本项目  <project>/skills           — read/write (OpenClaw)
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
  tool: 'claude' | 'codex' | 'openclaw';
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
      key: 'codex:project', tool: 'codex', toolLabel: 'Codex / 通用 Agents', scope: 'project',
      label: '本项目 · .agents/skills', dir: join(projectPath, '.agents', 'skills'), readOnly: false,
    },
    {
      key: 'openclaw:project', tool: 'openclaw', toolLabel: 'OpenClaw', scope: 'project',
      label: '本项目 · skills', dir: join(projectPath, 'skills'), readOnly: false,
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

const CLAWHUB_BASE_URL = 'https://clawhub.ai';
const SKILLS_SH_BASE_URL = 'https://skills.sh';
const MARKETPLACE_TIMEOUT_MS = 15_000;
const MAX_SEARCH_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_SKILL_RESPONSE_BYTES = 20 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const MAX_SKILL_FILES = 1_000;
const MAX_SKILL_FILE_BYTES = 16 * 1024 * 1024;
const MAX_SKILL_TOTAL_BYTES = 64 * 1024 * 1024;

type MarketplaceProvider = 'clawhub' | 'skills.sh';
type MarketplaceInstallTarget = 'claude-code' | 'codex' | 'openclaw';

interface InstallTargetDefinition {
  id: MarketplaceInstallTarget;
  label: string;
  description: string;
  tool: SkillLocation['tool'];
  scope: SkillLocation['scope'];
}

const INSTALL_TARGETS: InstallTargetDefinition[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    description: '.claude/skills',
    tool: 'claude',
    scope: 'project',
  },
  {
    id: 'codex',
    label: 'Codex / 通用 Agents',
    description: '.agents/skills · Cursor、OpenCode 等也可读取',
    tool: 'codex',
    scope: 'project',
  },
  {
    id: 'openclaw',
    label: 'OpenClaw',
    description: 'skills',
    tool: 'openclaw',
    scope: 'project',
  },
];

interface MarketplaceSkill {
  id: string;
  provider: MarketplaceProvider;
  providerLabel: string;
  skillId?: string;
  slug: string;
  name: string;
  description: string;
  author: string | null;
  downloads: number;
  installs: number | null;
  version: string | null;
  url: string;
  featured: boolean;
  official: boolean;
  installed: boolean;
  installedTargets: MarketplaceInstallTarget[];
}

interface MarketplaceProviderStatus {
  id: MarketplaceProvider;
  label: string;
  enabled: boolean;
  ok: boolean;
  message?: string;
}

interface SkillPackageFile {
  path: string;
  contents: Uint8Array;
}

interface ClawHubSearchEntry {
  id?: string;
  source?: 'clawhub' | 'skills-sh';
  slug?: string;
  ownerHandle?: string | null;
  displayName?: string;
  summary?: string | null;
  version?: string | null;
  downloads?: number;
  official?: boolean;
  featured?: boolean;
  canonicalUrl?: string;
  owner?: { handle?: string | null } | null;
  install?: { kind?: string; reference?: string; sourceUrl?: string | null };
  trust?: { installability?: string; sourceFreshness?: string };
}

interface ClawHubPopularEntry {
  slug?: string;
  displayName?: string;
  summary?: string | null;
  description?: string | null;
  stats?: { downloads?: number; installs?: number };
  latestVersion?: { version?: string } | null;
}

interface SkillsShEntry {
  id?: string;
  slug?: string;
  name?: string;
  description?: string | null;
  source?: string;
  installs?: number;
  url?: string;
  isDuplicate?: boolean;
}

class MarketplaceError extends Error {
  constructor(message: string, readonly statusCode = 502) {
    super(message);
  }
}

function skillsShToken(): string | null {
  return process.env.SKILLS_SH_TOKEN?.trim()
    || process.env.VERCEL_OIDC_TOKEN?.trim()
    || null;
}

function safeRemoteError(provider: string, error: unknown): MarketplaceError {
  if (error instanceof MarketplaceError) return error;
  const message = error instanceof Error && error.name === 'TimeoutError'
    ? `${provider} request timed out`
    : `${provider} is temporarily unavailable`;
  return new MarketplaceError(message);
}

async function fetchRemote(url: URL, token?: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: 'application/json, application/zip',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(MARKETPLACE_TIMEOUT_MS),
      redirect: 'error',
    });
  } catch (error) {
    throw safeRemoteError(url.hostname, error);
  }
  if (!response.ok) {
    throw new MarketplaceError(`${url.hostname} returned ${response.status}`);
  }
  return response;
}

async function fetchRemoteJson<T>(url: URL, maxBytes: number, token?: string): Promise<T> {
  const response = await fetchRemote(url, token);
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new MarketplaceError('Marketplace response is too large');
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new MarketplaceError('Marketplace response is too large');
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new MarketplaceError('Marketplace returned invalid JSON');
  }
}

async function fetchRemoteBytes(url: URL, maxBytes: number): Promise<Uint8Array> {
  const response = await fetchRemote(url);
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new MarketplaceError('Skill archive is too large', 422);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new MarketplaceError('Skill archive is too large', 422);
  return bytes;
}

function validateSkillFilePath(path: string): string {
  if (!path || path.length > 500 || path.includes('\\') || path.includes('\0')
    || path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    throw new MarketplaceError('Skill package contains an invalid file path', 422);
  }
  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment === '.git')) {
    throw new MarketplaceError('Skill package contains an unsafe file path', 422);
  }
  return path;
}

/** Expand a marketplace ZIP while bounding file count and decompressed size. */
export function unpackSkillArchive(archive: Uint8Array): SkillPackageFile[] {
  if (archive.byteLength > MAX_ARCHIVE_BYTES) throw new MarketplaceError('Skill archive is too large', 422);
  let fileCount = 0;
  let totalBytes = 0;
  let expanded: Record<string, Uint8Array>;
  try {
    expanded = unzipSync(archive, {
      filter: (file: UnzipFileInfo) => {
        if (file.name.endsWith('/') || file.name.startsWith('__MACOSX/')) return false;
        validateSkillFilePath(file.name);
        fileCount += 1;
        totalBytes += file.originalSize;
        if (fileCount > MAX_SKILL_FILES) throw new MarketplaceError('Skill package contains too many files', 422);
        if (file.originalSize > MAX_SKILL_FILE_BYTES) throw new MarketplaceError('A skill file is too large', 422);
        if (totalBytes > MAX_SKILL_TOTAL_BYTES) throw new MarketplaceError('Skill package is too large after extraction', 422);
        return true;
      },
    });
  } catch (error) {
    if (error instanceof MarketplaceError) throw error;
    throw new MarketplaceError('Skill archive is invalid', 422);
  }
  const files = Object.entries(expanded).map(([path, contents]) => ({
    path: validateSkillFilePath(path),
    contents,
  }));
  if (!files.some((file) => file.path === 'SKILL.md')) {
    throw new MarketplaceError('Skill package does not contain a root SKILL.md', 422);
  }
  return files;
}

function validateSkillFiles(files: SkillPackageFile[]): SkillPackageFile[] {
  if (files.length === 0 || files.length > MAX_SKILL_FILES) {
    throw new MarketplaceError('Skill package has an invalid number of files', 422);
  }
  let totalBytes = 0;
  const seen = new Set<string>();
  for (const file of files) {
    file.path = validateSkillFilePath(file.path);
    if (seen.has(file.path)) throw new MarketplaceError('Skill package contains duplicate file paths', 422);
    seen.add(file.path);
    if (file.contents.byteLength > MAX_SKILL_FILE_BYTES) {
      throw new MarketplaceError('A skill file is too large', 422);
    }
    totalBytes += file.contents.byteLength;
    if (totalBytes > MAX_SKILL_TOTAL_BYTES) {
      throw new MarketplaceError('Skill package is too large', 422);
    }
  }
  if (!seen.has('SKILL.md')) throw new MarketplaceError('Skill package does not contain a root SKILL.md', 422);
  return files;
}

const activeInstalls = new Set<string>();

async function writeSkillPackage(loc: SkillLocation, slug: string, files: SkillPackageFile[]): Promise<string> {
  validateSkillFiles(files);
  await mkdir(loc.dir, { recursive: true });
  const target = resolveSkillDir(loc, slug)!;
  if (existsSync(target) || activeInstalls.has(target)) {
    throw new MarketplaceError('A project skill with this name already exists', 409);
  }

  activeInstalls.add(target);
  const temporary = await mkdtemp(join(loc.dir, '.market-install-'));
  try {
    for (const file of files) {
      const output = resolve(temporary, file.path);
      if (!output.startsWith(`${resolve(temporary)}/`)) {
        throw new MarketplaceError('Skill package contains an unsafe file path', 422);
      }
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, file.contents);
    }
    if (existsSync(target)) throw new MarketplaceError('A project skill with this name already exists', 409);
    await rename(temporary, target);
    return target;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  } finally {
    activeInstalls.delete(target);
  }
}

type InstalledTargetSkills = Record<MarketplaceInstallTarget, Set<string>>;

async function installedProjectSkillNames(projectPath: string): Promise<InstalledTargetSkills> {
  const installed = {} as InstalledTargetSkills;
  for (const target of INSTALL_TARGETS) {
    const loc = findLocation(projectPath, target.tool, target.scope)!;
    let entries: { name: string; isDirectory: () => boolean }[];
    try { entries = await readdir(loc.dir, { withFileTypes: true }); } catch { entries = []; }
    installed[target.id] = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  }
  return installed;
}

function installedTargetsFor(slug: string, installed: InstalledTargetSkills): MarketplaceInstallTarget[] {
  return INSTALL_TARGETS.filter((target) => installed[target.id].has(slug)).map((target) => target.id);
}

function clawHubPageUrl(entry: ClawHubSearchEntry, slug: string): string {
  if (entry.canonicalUrl?.startsWith('/')) return `${CLAWHUB_BASE_URL}${entry.canonicalUrl}`;
  if (entry.ownerHandle) return `${CLAWHUB_BASE_URL}/${encodeURIComponent(entry.ownerHandle)}/skills/${encodeURIComponent(slug)}`;
  return `${CLAWHUB_BASE_URL}/skills/${encodeURIComponent(slug)}`;
}

async function searchClawHub(query: string, installed: InstalledTargetSkills): Promise<MarketplaceSkill[]> {
  if (query) {
    const url = new URL('/api/v1/search', CLAWHUB_BASE_URL);
    url.searchParams.set('q', query);
    url.searchParams.set('limit', '24');
    const data = await fetchRemoteJson<{ results?: ClawHubSearchEntry[] }>(url, MAX_SEARCH_RESPONSE_BYTES);
    return (Array.isArray(data.results) ? data.results : [])
      .filter((entry) => entry.source !== 'skills-sh' && entry.install?.kind !== 'skills-sh')
      .filter((entry) => entry.trust?.installability !== 'blocked')
      .filter((entry) => entry.trust?.sourceFreshness !== 'observed-only')
      .flatMap((entry): MarketplaceSkill[] => {
        const slug = entry.slug?.trim();
        if (!isValidSkillName(slug)) return [];
        const author = entry.ownerHandle || entry.owner?.handle || null;
        const installedTargets = installedTargetsFor(slug, installed);
        return [{
          id: entry.id || `clawhub:${author || ''}/${slug}`,
          provider: 'clawhub',
          providerLabel: 'ClawHub',
          slug,
          name: entry.displayName?.trim() || slug,
          description: entry.summary?.trim() || '',
          author,
          downloads: Number.isFinite(entry.downloads) ? Math.max(0, entry.downloads!) : 0,
          installs: null,
          version: entry.version || null,
          url: clawHubPageUrl(entry, slug),
          featured: entry.featured === true,
          official: entry.official === true,
          installed: installedTargets.length > 0,
          installedTargets,
        }];
      });
  }

  const url = new URL('/api/v1/skills', CLAWHUB_BASE_URL);
  url.searchParams.set('limit', '18');
  url.searchParams.set('sort', 'downloads');
  const data = await fetchRemoteJson<{ items?: ClawHubPopularEntry[] }>(url, MAX_SEARCH_RESPONSE_BYTES);
  return (Array.isArray(data.items) ? data.items : []).flatMap((entry): MarketplaceSkill[] => {
    const slug = entry.slug?.trim();
    if (!isValidSkillName(slug)) return [];
    const installedTargets = installedTargetsFor(slug, installed);
    return [{
      id: `clawhub:${slug}`,
      provider: 'clawhub',
      providerLabel: 'ClawHub',
      slug,
      name: entry.displayName?.trim() || slug,
      description: entry.summary?.trim() || entry.description?.trim() || '',
      author: null,
      downloads: Number.isFinite(entry.stats?.downloads) ? Math.max(0, entry.stats!.downloads!) : 0,
      installs: Number.isFinite(entry.stats?.installs) ? Math.max(0, entry.stats!.installs!) : null,
      version: entry.latestVersion?.version || null,
      url: `${CLAWHUB_BASE_URL}/skills/${encodeURIComponent(slug)}`,
      featured: false,
      official: false,
      installed: installedTargets.length > 0,
      installedTargets,
    }];
  });
}

async function searchSkillsSh(query: string, installed: InstalledTargetSkills, token: string): Promise<MarketplaceSkill[]> {
  const url = query
    ? new URL('/api/v1/skills/search', SKILLS_SH_BASE_URL)
    : new URL('/api/v1/skills', SKILLS_SH_BASE_URL);
  if (query) {
    url.searchParams.set('q', query);
    url.searchParams.set('limit', '24');
  } else {
    url.searchParams.set('view', 'all-time');
    url.searchParams.set('page', '0');
    url.searchParams.set('per_page', '18');
  }
  const data = await fetchRemoteJson<{ results?: SkillsShEntry[]; skills?: SkillsShEntry[]; items?: SkillsShEntry[] }>(
    url,
    MAX_SEARCH_RESPONSE_BYTES,
    token,
  );
  const entries = data.results || data.skills || data.items || [];
  return entries.filter((entry) => !entry.isDuplicate).flatMap((entry): MarketplaceSkill[] => {
    const slug = entry.slug?.trim();
    const skillId = entry.id?.trim();
    if (!isValidSkillName(slug) || !skillId || skillId.length > 300) return [];
    const installedTargets = installedTargetsFor(slug, installed);
    return [{
      id: `skills.sh:${skillId}`,
      provider: 'skills.sh',
      providerLabel: 'skills.sh',
      skillId,
      slug,
      name: entry.name?.trim() || slug,
      description: entry.description?.trim() || '',
      author: entry.source?.trim() || null,
      downloads: Number.isFinite(entry.installs) ? Math.max(0, entry.installs!) : 0,
      installs: Number.isFinite(entry.installs) ? Math.max(0, entry.installs!) : null,
      version: null,
      url: entry.url?.startsWith('https://skills.sh/') ? entry.url : `${SKILLS_SH_BASE_URL}/${skillId}`,
      featured: false,
      official: false,
      installed: installedTargets.length > 0,
      installedTargets,
    }];
  });
}

async function downloadClawHubSkill(slug: string, ownerHandle?: string): Promise<SkillPackageFile[]> {
  const installUrl = new URL(`/api/v1/skills/${encodeURIComponent(slug)}/install`, CLAWHUB_BASE_URL);
  if (ownerHandle) installUrl.searchParams.set('ownerHandle', ownerHandle);
  const resolution = await fetchRemoteJson<{
    ok?: boolean;
    message?: string;
    installKind?: string;
    archive?: { version?: string };
  }>(installUrl, MAX_SEARCH_RESPONSE_BYTES);
  if (!resolution.ok || resolution.installKind !== 'archive' || !resolution.archive?.version) {
    throw new MarketplaceError(resolution.message || 'This ClawHub skill is not available as an installable archive', 422);
  }

  const downloadUrl = new URL('/api/v1/download', CLAWHUB_BASE_URL);
  downloadUrl.searchParams.set('slug', slug);
  if (ownerHandle) downloadUrl.searchParams.set('ownerHandle', ownerHandle);
  downloadUrl.searchParams.set('version', resolution.archive.version);
  const archive = await fetchRemoteBytes(downloadUrl, MAX_ARCHIVE_BYTES);
  return unpackSkillArchive(archive);
}

async function downloadSkillsShSkill(skillId: string, token: string): Promise<SkillPackageFile[]> {
  if (!skillId || skillId.length > 300) throw new MarketplaceError('Invalid skills.sh skill id', 400);
  const detailUrl = new URL(`/api/v1/skills/${encodeURIComponent(skillId)}`, SKILLS_SH_BASE_URL);
  const detail = await fetchRemoteJson<{ files?: { path?: string; contents?: string }[] | null }>(
    detailUrl,
    MAX_SKILL_RESPONSE_BYTES,
    token,
  );
  if (!Array.isArray(detail.files)) throw new MarketplaceError('This skills.sh entry has no installable file snapshot', 422);
  const files = detail.files.flatMap((file): SkillPackageFile[] => {
    if (typeof file.path !== 'string' || typeof file.contents !== 'string') return [];
    return [{ path: file.path, contents: new TextEncoder().encode(file.contents) }];
  });
  return validateSkillFiles(files);
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

  // Search supported public skill registries. ClawHub works without credentials;
  // skills.sh joins the aggregate when SKILLS_SH_TOKEN/VERCEL_OIDC_TOKEN is set.
  app.get<{ Querystring: { project_id?: string; q?: string } }>('/skills/marketplace/search', async (req, reply) => {
    const r = resolveProjectPath(req.user!.id, req.query.project_id);
    if (!r.ok) return reply.status(r.code).send({ error: r.error });
    const query = (req.query.q || '').trim();
    if (query.length === 1) return reply.status(400).send({ error: 'Search query must contain at least 2 characters' });
    if (query.length > 100) return reply.status(400).send({ error: 'Search query is too long' });

    const installed = await installedProjectSkillNames(r.path);
    const token = skillsShToken();
    const clawHubPromise = searchClawHub(query, installed);
    const skillsShPromise = token ? searchSkillsSh(query, installed, token) : null;
    const [clawHub, skillsSh] = await Promise.all([
      clawHubPromise.then((skills) => ({ ok: true as const, skills })).catch((error: unknown) => ({ ok: false as const, error: safeRemoteError('ClawHub', error) })),
      skillsShPromise
        ? skillsShPromise.then((skills) => ({ ok: true as const, skills })).catch((error: unknown) => ({ ok: false as const, error: safeRemoteError('skills.sh', error) }))
        : Promise.resolve(null),
    ]);

    const providers: MarketplaceProviderStatus[] = [
      {
        id: 'clawhub', label: 'ClawHub', enabled: true, ok: clawHub.ok,
        ...(!clawHub.ok ? { message: clawHub.error.message } : {}),
      },
      {
        id: 'skills.sh', label: 'skills.sh', enabled: !!token, ok: skillsSh?.ok === true,
        ...(!token ? { message: '配置 SKILLS_SH_TOKEN 后启用' } : skillsSh && !skillsSh.ok ? { message: skillsSh.error.message } : {}),
      },
    ];
    const skills = [
      ...(clawHub.ok ? clawHub.skills : []),
      ...(skillsSh?.ok ? skillsSh.skills : []),
    ];
    if (!providers.some((provider) => provider.ok)) {
      return reply.status(502).send({ error: 'Skill marketplaces are temporarily unavailable', providers });
    }
    if (!query) skills.sort((a, b) => b.downloads - a.downloads);
    return {
      query,
      skills: skills.slice(0, 36),
      providers,
      installTargets: INSTALL_TARGETS.map(({ id, label, description }) => ({ id, label, description })),
    };
  });

  // Install one remote snapshot into one or more project-local agent stores.
  app.post<{ Body: { project_id?: string; provider?: MarketplaceProvider; slug?: string; ownerHandle?: string; skillId?: string; targets?: MarketplaceInstallTarget[] } }>(
    '/skills/marketplace/install',
    async (req, reply) => {
      const body = (req.body || {}) as { project_id?: string; provider?: MarketplaceProvider; slug?: string; ownerHandle?: string; skillId?: string; targets?: MarketplaceInstallTarget[] };
      const r = resolveProjectPath(req.user!.id, body.project_id);
      if (!r.ok) return reply.status(r.code).send({ error: r.error });
      if (!isValidSkillName(body.slug)) return reply.status(400).send({ error: 'Invalid skill name' });
      if (body.ownerHandle && (!isValidSkillName(body.ownerHandle) || body.ownerHandle.length > 100)) {
        return reply.status(400).send({ error: 'Invalid marketplace owner' });
      }
      const requestedTargetIds = Array.from(new Set(Array.isArray(body.targets) ? body.targets : []));
      if (requestedTargetIds.length === 0) return reply.status(400).send({ error: 'Choose at least one install target' });
      const requestedTargets = requestedTargetIds.map((id) => INSTALL_TARGETS.find((target) => target.id === id));
      if (requestedTargets.some((target) => !target)) return reply.status(400).send({ error: 'Unknown install target' });
      const destinations = requestedTargets.map((target) => {
        const definition = target!;
        const loc = findLocation(r.path, definition.tool, definition.scope)!;
        return { definition, loc, path: resolveSkillDir(loc, body.slug!)! };
      });
      const missingDestinations = destinations.filter((destination) => !existsSync(destination.path));
      if (missingDestinations.length === 0) {
        return reply.status(409).send({ error: 'This skill already exists in every selected target' });
      }

      const writtenPaths: string[] = [];
      try {
        let files: SkillPackageFile[];
        if (body.provider === 'clawhub') {
          files = await downloadClawHubSkill(body.slug, body.ownerHandle);
        } else if (body.provider === 'skills.sh') {
          const token = skillsShToken();
          if (!token) throw new MarketplaceError('skills.sh is not configured on this server', 503);
          files = await downloadSkillsShSkill(body.skillId || '', token);
        } else {
          return reply.status(400).send({ error: 'Unknown skill marketplace' });
        }

        for (const destination of missingDestinations) {
          writtenPaths.push(await writeSkillPackage(destination.loc, body.slug, files));
        }
        const primary = missingDestinations[0];
        const skillMd = await readFile(join(primary.path, 'SKILL.md'), 'utf8');
        const frontmatter = parseFrontmatter(skillMd);
        return {
          ok: true,
          tool: primary.loc.tool,
          scope: primary.loc.scope,
          dirName: body.slug,
          path: primary.path,
          name: frontmatter.name || body.slug,
          description: frontmatter.description || '',
          installedTargets: requestedTargetIds,
          destinations: destinations.map(({ definition, path }) => ({ id: definition.id, label: definition.label, path })),
        };
      } catch (error) {
        for (const path of writtenPaths) await rm(path, { recursive: true, force: true });
        const safe = error instanceof MarketplaceError ? error : safeRemoteError(body.provider || 'Marketplace', error);
        req.log.warn({ provider: body.provider, slug: body.slug, err: error }, 'Skill marketplace install failed');
        return reply.status(safe.statusCode).send({ error: safe.message });
      }
    },
  );

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
