import {canUseSessionEnvironment,isRetiredEnvironment} from './services/agents/environment-access.js';
/**
 * Authentication: password hashing (scrypt — no native deps), cookie-based
 * login sessions, and the Fastify onRequest hook that gates /api/* behind login.
 *
 * Soft multi-tenant model: this enforces *who is logged in*. Per-row data
 * ownership/filtering lives in the route handlers (see projects.owner_id).
 */
import {createHash,createHmac,randomBytes,scrypt,scryptSync,timingSafeEqual} from 'crypto';
import {chmodSync,readFileSync,realpathSync,writeFileSync} from 'fs';
import {dirname,join,resolve,sep} from 'path';
import {nanoid} from 'nanoid';
import type {FastifyRequest,FastifyReply} from 'fastify';
import {getDb} from './db/index.js';
import {config} from './config.js';
import {runtimeNames} from './services/runtime-namespace.js';
import {userHasPermission,validateGrants,type PermissionGrants,type PermissionKey,type PermissionLevel} from './services/rbac.js';
import {sessionClients,parseSessionClients} from './services/session-clients.js';
import {requestLoginMetadata,type LoginMetadata} from './services/login-metadata.js';
import {privateResourcePath} from './services/shared-resources/path-guard.js';

export interface User {
  id: string;
  username: string;
  display_name: string;
  role: 'admin' | 'member';
  disabled: number;
  max_tabs: number;
  can_create_projects: number;
  created_at: string;
}

// Make req.user available with types everywhere.
declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
    apiKeyGrants?: PermissionGrants;
  }
}

export function sessionCookieName(): string { return runtimeNames().sessionCookie; }
export const SESSION_TTL_DAYS = 30;
const SESSION_TTL_SECONDS = SESSION_TTL_DAYS * 24 * 60 * 60;
export const MIN_PASSWORD_LENGTH = 6;
export const MAX_PASSWORD_LENGTH = 256;

/* ── Password hashing (scrypt) ─────────────────────────────────────── */

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** Password hashing used by request handlers; never blocks the event loop. */
export async function hashPasswordAsync(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await new Promise<Buffer>((resolvePromise, reject) => {
    scrypt(password, salt, 64, (error, derivedKey) => {
      if (error) reject(error);
      else resolvePromise(derivedKey);
    });
  });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !/^[0-9a-f]{32}$/i.test(saltHex || '') || !/^[0-9a-f]{128}$/i.test(hashHex || '')) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Password verification used by public login routes; never blocks the event loop. */
export async function verifyPasswordAsync(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !/^[0-9a-f]{32}$/i.test(saltHex || '') || !/^[0-9a-f]{128}$/i.test(hashHex || '')) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await new Promise<Buffer>((resolvePromise, reject) => {
    scrypt(password, Buffer.from(saltHex, 'hex'), expected.length, (error, derivedKey) => {
      if (error) reject(error);
      else resolvePromise(derivedKey);
    });
  });
  return timingSafeEqual(expected, actual);
}

export function passwordLengthError(password: unknown): string | null {
  if (typeof password !== 'string') return 'password must be a string';
  if (password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (password.length > MAX_PASSWORD_LENGTH) return `Password must be at most ${MAX_PASSWORD_LENGTH} characters`;
  return null;
}

/* ── Per-project event hook authentication ─────────────────────────── */

const hookMasterCache = new Map<string, string>();

function hookMasterSecret(): string {
  if (config.hookSecret) return config.hookSecret;
  const secretPath = join(dirname(config.dbPath), '.events-hook-secret');
  const cached = hookMasterCache.get(secretPath);
  if (cached) return cached;

  let secret: string;
  try {
    secret = readFileSync(secretPath, 'utf8').trim();
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
    secret = randomBytes(32).toString('base64url');
    try {
      writeFileSync(secretPath, `${secret}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      secret = readFileSync(secretPath, 'utf8').trim();
    }
  }
  if (secret.length < 32) throw new Error('Hook secret is too short');
  try { chmodSync(secretPath, 0o600); } catch { /* best effort */ }
  hookMasterCache.set(secretPath, secret);
  return secret;
}

/** Derive a stable secret bound to one exact registered project root. */
export function getEventHookSecret(projectPath: string): string | null {
  const row = getDb().prepare('SELECT path FROM projects WHERE path = ?').get(projectPath) as { path: string } | undefined;
  if (!row) return null;
  return createHmac('sha256', hookMasterSecret()).update(row.path).digest('base64url');
}

export function eventHookSecretMatches(projectPath: string, candidate: string | undefined): boolean {
  if (!candidate) return false;
  const expected = getEventHookSecret(projectPath);
  if (!expected) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(candidate);
  return left.length === right.length && timingSafeEqual(left, right);
}

/* ── User DB ops ───────────────────────────────────────────────────── */

const PUBLIC_COLS = 'id, username, display_name, role, disabled, max_tabs, can_create_projects, created_at';

export function userCanCreateProjects(userId: string): boolean {
  const user = findUserById(userId);
  return !!user && !user.disabled && userHasPermission(userId, 'projects_create', 'write');
}

export function getUserCount(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
}

export function findUserByUsername(username: string): (User & { password_hash: string }) | undefined {
  return getDb().prepare('SELECT * FROM users WHERE username = ?').get(username) as any;
}

export function findUserById(id: string): User | undefined {
  return getDb().prepare(`SELECT ${PUBLIC_COLS} FROM users WHERE id = ?`).get(id) as User | undefined;
}

export function listUsers(): User[] {
  return getDb().prepare(`SELECT ${PUBLIC_COLS} FROM users ORDER BY created_at`).all() as User[];
}

export function createUser(opts: {
  username: string;
  password: string;
  display_name?: string;
  role?: 'admin' | 'member';
  max_tabs?: number;
  can_create_projects?: boolean;
}): User {
  return insertUser(opts, hashPassword(opts.password));
}

export async function createUserAsync(opts: {
  username: string;
  password: string;
  display_name?: string;
  role?: 'admin' | 'member';
  max_tabs?: number;
  can_create_projects?: boolean;
}): Promise<User> {
  return insertUser(opts, await hashPasswordAsync(opts.password));
}

/** Hash first, then atomically claim first-run setup so concurrent requests cannot create two admins. */
export async function createInitialAdminAsync(opts: {
  username: string;
  password: string;
  display_name?: string;
}): Promise<User | null> {
  const passwordHash = await hashPasswordAsync(opts.password);
  return getDb().transaction(() => {
    if (getUserCount() !== 0) return null;
    return insertUser({ ...opts, role: 'admin' }, passwordHash);
  })();
}

function insertUser(opts: {
  username: string;
  display_name?: string;
  role?: 'admin' | 'member';
  max_tabs?: number;
  can_create_projects?: boolean;
}, passwordHash: string): User {
  const id = nanoid(12);
  const username = opts.username.trim();
  getDb()
    .prepare(
      `INSERT INTO users (id, username, password_hash, display_name, role, max_tabs, can_create_projects)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, username, passwordHash, opts.display_name?.trim() || username, opts.role || 'member', opts.max_tabs ?? 10, opts.can_create_projects ? 1 : 0);
  getDb().prepare('INSERT INTO rbac_user_roles (user_id, role_id) VALUES (?, ?)').run(id, opts.role || 'member');
  return findUserById(id)!;
}

export function setUserPassword(id: string, password: string): void {
  getDb().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), id);
}

export async function setUserPasswordAsync(id: string, password: string): Promise<void> {
  const passwordHash = await hashPasswordAsync(password);
  getDb().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
}

/* ── Login sessions ────────────────────────────────────────────────── */

export function createSession(userId: string,metadata?:LoginMetadata): string {
  const token = randomBytes(32).toString('hex');
  getDb()
    .prepare(
      `INSERT INTO auth_sessions (token, user_id, expires_at,login_ip,last_ip,user_agent,session_kind)
       VALUES (?, ?, datetime('now', ?),?,?,?,?)`,
    )
    .run(token, userId, `+${SESSION_TTL_DAYS} days`,metadata?.ip??null,metadata?.ip??null,metadata?.userAgent??null,metadata?.kind??'browser');
  return token;
}

/** Resolve a session token to a live, non-disabled user; slides expiry. */
export function getSessionUser(token: string,metadata?:LoginMetadata): User | undefined {
  const db = getDb();
  const row = db
    .prepare('SELECT user_id, expires_at FROM auth_sessions WHERE token = ?')
    .get(token) as { user_id: string; expires_at: string } | undefined;
  if (!row) return undefined;
  if (new Date(row.expires_at + 'Z').getTime() <= Date.now()) {
    db.prepare('DELETE FROM auth_sessions WHERE token = ?').run(token);
    return undefined;
  }
  db.prepare(
    `UPDATE auth_sessions SET last_seen_at = datetime('now'), expires_at = datetime('now', ?),
      last_ip=COALESCE(?,last_ip),user_agent=COALESCE(?,user_agent) WHERE token = ?`,
  ).run(`+${SESSION_TTL_DAYS} days`,metadata?.ip??null,metadata?.userAgent??null, token);
  const user = findUserById(row.user_id);
  if (!user || user.disabled) return undefined;
  return user;
}

export function destroySession(token: string): void {
  getDb().prepare('DELETE FROM auth_sessions WHERE token = ?').run(token);
}

/** Expired credentials are not a login audit trail. Reclaim them even when
 * the browser never returns to present the old cookie again. */
export function purgeExpiredAuthSessions():number {
  return getDb().prepare("DELETE FROM auth_sessions WHERE expires_at <= datetime('now')").run().changes;
}

/** Invalidate every session for a user (e.g. on disable / password reset). */
export function destroyUserSessions(userId: string): void {
  getDb().prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(userId);
  getDb().prepare('DELETE FROM api_keys WHERE user_id = ?').run(userId);
}

/* ── Cookie helpers ────────────────────────────────────────────────── */

export function readSessionCookie(req: FastifyRequest): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === sessionCookieName()) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Explicit HTTP route families. Personal credentials and authentication
 * endpoints never accept bearer keys. Unknown routes fail closed. */
function apiKeyRoute(method: string, path: string): [PermissionKey,PermissionLevel] | null {
  if(!['GET','POST','PUT','PATCH','DELETE'].includes(method)||path.includes('%'))return null;
  const read=method==='GET', level:PermissionLevel=read?'read':method==='DELETE'?'delete':'write';
  if(/^\/api\/agent-management(?:\/|$)/.test(path))return ['settings',read?'read':'write'];
  if(/^\/api\/settings(?:\/|$)/.test(path))return ['settings',read?'read':'write'];
  if(/^\/api\/users(?:\/|$)/.test(path))return ['users',level];
  if(/^\/api\/rbac\/roles(?:\/|$)/.test(path)||/^\/api\/rbac\/users(?:\/|$)/.test(path))return ['roles',level];
  if(/^\/api\/admin(?:\/|$)/.test(path))return ['monitor',level];
  if(path==='/api/projects'&&method==='POST')return ['projects_create','write'];
  if(/^\/api\/projects\/[^/]+\/access(?:\/|$)/.test(path))return ['project_access',read?'read':'write'];
  if(/^\/api\/projects(?:\/|$)/.test(path))return [read?'agent_api':'project_access',read?'read':'write'];
  if(/^\/api\/(?:agent|sessions|scheduled-tasks|agent-quota|codex-quota|context|files|git|tasks|skills|events)(?:\/|$)/.test(path))return ['agent_api',read?'read':'write'];
  if(path==='/api/prompt-enhancer/enhance')return ['agent_api',read?'read':'write'];
  if(/^\/api\/(?:prompt-enhancer|ai-sources)(?:\/|$)/.test(path))return ['settings',read?'read':'write'];
  if(/^\/api\/codex\/environments(?:\/|$)/.test(path))return ['settings',read?'read':'write'];
  if(/^\/api\/platform-ai(?:\/|$)/.test(path))return ['agent_api',read?'read':'write'];
  return null;
}

export function hashApiKey(token: string): string { return createHash('sha256').update(token).digest('hex'); }
function apiKeyUser(token: string): {user:User;grants:PermissionGrants} | undefined {
  if (!/^amk_[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
  const db=getDb();
  const row=db.prepare('SELECT id,user_id,expires_at,grants FROM api_keys WHERE token_hash=?').get(hashApiKey(token)) as {id:string;user_id:string;expires_at:string;grants:string}|undefined;
  if(!row || Date.parse(row.expires_at)<=Date.now() || !Number.isFinite(Date.parse(row.expires_at))) return undefined;
  const user=findUserById(row.user_id);
  if(!user || user.disabled) return undefined;
  try{
    const grants:unknown=JSON.parse(row.grants);if(!validateGrants(grants))return undefined;
    db.prepare('UPDATE api_keys SET last_used_at=? WHERE id=?').run(new Date().toISOString(),row.id);
    return {user,grants};
  }catch{return undefined;}
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  const secure = config.secureCookies ? '; Secure' : '';
  reply.header(
    'Set-Cookie',
    `${sessionCookieName()}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${secure}`,
  );
}

export function clearSessionCookie(reply: FastifyReply): void {
  const secure = config.secureCookies ? '; Secure' : '';
  reply.header('Set-Cookie', `${sessionCookieName()}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

/* ── Auth gate (Fastify onRequest hook) ────────────────────────────── */

/** /api paths reachable without a login. */
const PUBLIC_PATHS = new Set([
  '/api/auth/status',
  '/api/auth/setup',
  '/api/auth/login',
  '/api/health',
]);

export async function authHook(req: FastifyRequest, reply: FastifyReply) {
  if (req.method === 'OPTIONS') return; // let CORS preflight through
  const path = req.url.split('?')[0];
  if (!path.startsWith('/api/')) return; // static assets, SPA, etc.

  // Claude Code hooks POST events with no session cookie — allow ingest.
  // (Reads of /api/events still require login + owner filtering in the route.)
  if (req.method === 'POST' && path === '/api/events') return;
  // Channel callbacks authenticate their own signed payloads; no browser cookie.
  if (['GET', 'POST'].includes(req.method) && /^\/api\/platform-ai\/callbacks\/[A-Za-z0-9_-]+$/.test(path)) return;

  // Always resolve the user when a valid session cookie is present, so public
  // endpoints (e.g. /auth/status) can still report who is logged in.
  const authorization=req.headers.authorization;
  const scope=authorization?apiKeyRoute(req.method,path):null;
  if(authorization && !scope) return reply.code(403).send({error:'API Key 无权访问此接口'});
  const token = readSessionCookie(req);
  const apiKey=authorization?apiKeyUser(/^Bearer (\S+)$/.exec(authorization)?.[1] || ''):undefined;
  const user = authorization ? apiKey?.user : token ? getSessionUser(token,requestLoginMetadata(req)) : undefined;
  if(apiKey&&scope){
    const rank={read:1,write:2,delete:3};const grant=apiKey.grants[scope[0]];
    if(!grant||rank[grant]<rank[scope[1]]||!userHasPermission(apiKey.user.id,scope[0],scope[1]))return reply.code(403).send({error:'API Key 权限不足'});
    req.apiKeyGrants=apiKey.grants;
  }
  if (user) req.user = user;

  if (PUBLIC_PATHS.has(path)) return;        // public: login not required
  if (!user) return reply.code(401).send({ error: 'Unauthorized' });
  const match=/^\/api\/sessions\/([^/]+)/.exec(path);
  if(match){let id:string;try{id=decodeURIComponent(match[1]);}catch{return reply.code(400).send({error:'无效的会话地址'});}
    const session=getDb().prepare('SELECT agent_id,cli_type,agent_environment_id FROM sessions WHERE id=?').get(id) as {agent_id:string|null;cli_type:string|null;agent_environment_id:string|null}|undefined;
    if(session&&!canUseSessionEnvironment(session,user.id))return reply.code(403).send({error:'无权使用该会话的 Codex 环境'});
    if(session&&isRetiredEnvironment(session.agent_environment_id)&&!['GET','DELETE'].includes(req.method))return reply.code(410).send({error:'Provider 已删除，该会话仅支持查看历史'});
  }
}

/* ── Data-ownership access helpers (soft multi-tenant) ─────────────── */

export interface ProjectToolAccess {
  project_id: string;
  canSession: boolean;
  canTerminal: boolean;
  sessionClients: string[];
}

type RawProjectAccess = {
  can_session: number;
  can_terminal: number;
  session_clients: string;
};

function bool(v: unknown): boolean {
  return Number(v) === 1;
}

export function isAdmin(userId: string): boolean {
  const row = getDb().prepare("SELECT role FROM users WHERE id = ?").get(userId) as { role: string } | undefined;
  return row?.role === 'admin';
}

export function getUserTabUsage(userId: string): { limit: number; used: number; allowed: boolean } {
  const user = findUserById(userId);
  if (!user) return { limit: 0, used: 0, allowed: false };
  if (user.role === 'admin') return { limit: Number.MAX_SAFE_INTEGER, used: 0, allowed: true };
  const used = (getDb().prepare(`
    SELECT COUNT(*) AS n FROM sessions
    WHERE created_by_user_id = ? AND status IN ('pending', 'launching', 'running', 'detached', 'released')
  `).get(userId) as { n: number }).n;
  const limit = Math.max(0, Number(user.max_tabs) || 0);
  return { limit, used, allowed: used < limit };
}

function mapProjectToolAccess(projectId: string, row: RawProjectAccess | undefined): ProjectToolAccess | null {
  if (!row) return null;
  const access: ProjectToolAccess = {
    project_id: projectId,
    canSession: bool(row.can_session),
    canTerminal: bool(row.can_terminal),
    sessionClients: bool(row.can_session) ? parseSessionClients(row.session_clients) : [],
  };
  if (!access.canSession && !access.canTerminal) return null;
  return access;
}

export function getProjectToolAccess(userId: string, projectId: string | null | undefined): ProjectToolAccess | null {
  if (!projectId) return null;
  if (isAdmin(userId)) {
    return {
      project_id: projectId,
      canSession: true,
      canTerminal: true,
      sessionClients: sessionClients().map((client) => client.id),
    };
  }

  const explicit = getDb()
    .prepare('SELECT can_session, can_terminal, session_clients FROM project_user_access WHERE project_id = ? AND user_id = ?')
    .get(projectId, userId) as RawProjectAccess | undefined;
  if (explicit) return mapProjectToolAccess(projectId, explicit);

  // Fallback for old owner_id models.
  const ownerMatch = getDb().prepare('SELECT 1 FROM projects WHERE id = ? AND owner_id = ?').get(projectId, userId);
  if (ownerMatch) {
    return {
      project_id: projectId,
      canSession: true,
      canTerminal: true,
      sessionClients: sessionClients().map((client) => client.id),
    };
  }

  return null;
}

export function userProjectIds(userId: string): Set<string> {
  if (isAdmin(userId)) {
    const rows = getDb().prepare('SELECT id FROM projects').all() as { id: string }[];
    return new Set(rows.map((r) => r.id));
  }
  const accessRows = getDb().prepare(`
    SELECT project_id AS id
    FROM project_user_access
    WHERE user_id = ?
      AND (can_session = 1 OR can_terminal = 1)
  `).all(userId) as { id: string }[];
  const ownerRows = getDb().prepare(`
    SELECT p.id
    FROM projects p
    WHERE p.owner_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM project_user_access a WHERE a.project_id = p.id AND a.user_id = ?
      )
  `).all(userId, userId) as { id: string }[];
  const ids = new Set<string>(accessRows.map((r) => r.id));
  for (const row of ownerRows) ids.add(row.id);
  return ids;
}

export function userOwnsProject(userId: string, projectId: string | null | undefined): boolean {
  return getProjectToolAccess(userId, projectId) !== null;
}

export function userOwnsProjectPath(userId: string, path: string | null | undefined): boolean {
  if (!path) return false;
  const row = getDb().prepare('SELECT id FROM projects WHERE path = ?').get(path) as { id: string } | undefined;
  return getProjectToolAccess(userId, row?.id) !== null;
}

/**
 * Authorize an existing filesystem path (or a not-yet-created child) against
 * the user's assigned project roots. realpath closes symlink-based escapes.
 */
export function userOwnsFilesystemPath(userId: string, path: string | null | undefined): boolean {
  if (!path) return false;
  if (privateResourcePath(path)) return false;
  if (isAdmin(userId)) return true;

  let target: string;
  try {
    target = realpathSync(resolve(path));
  } catch {
    try {
      target = resolve(realpathSync(dirname(resolve(path))), resolve(path).split(sep).pop() || '');
    } catch {
      return false;
    }
  }

  const rows = getDb().prepare('SELECT id, path FROM projects').all() as { id: string; path: string }[];
  const matches = rows.flatMap((row) => {
    let root: string;
    try { root = realpathSync(resolve(row.path)); } catch { return []; }
    return target === root || target.startsWith(root + sep) ? [{ id: row.id, root }] : [];
  });
  // Nested registered projects are separate authorization boundaries. The
  // most specific project wins, so access to /work never implies access to a
  // separately registered /work/secret project.
  matches.sort((a, b) => b.root.length - a.root.length);
  return matches.length > 0 && getProjectToolAccess(userId, matches[0].id) !== null;
}

/** Registered project roots hidden from a member's spawned shell/agent. */
export function inaccessibleProjectPaths(userId: string): string[] {
  if (isAdmin(userId)) return [];
  const allowed = userProjectIds(userId);
  const rows = getDb().prepare('SELECT id, path FROM projects').all() as { id: string; path: string }[];
  return rows
    .filter((row) => !allowed.has(row.id))
    .map((row) => resolve(row.path))
    .filter((path, index, all) => all.indexOf(path) === index);
}

export function userOwnsSession(userId: string, sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  if (isAdmin(userId)) return true;

  const session = getDb().prepare('SELECT project_id, created_by_user_id FROM sessions WHERE id = ?').get(sessionId) as
    | { project_id: string | null; created_by_user_id: string | null }
    | undefined;
  if (!session) return false;
  return session.created_by_user_id === userId;
}

export function userCanUseToolForProject(
  userId: string,
  projectId: string | null | undefined,
  toolMode: 'session' | 'terminal',
  cliType: string = 'claude',
): boolean {
  const access = getProjectToolAccess(userId, projectId);
  if (!access) return false;
  return toolMode === 'terminal' ? access.canTerminal : access.canSession && access.sessionClients.includes(cliType);
}

export function userCanUseSessionTool(userId: string, sessionId: string, cliType: string, toolMode: 'session' | 'terminal'): boolean {
  const row = getDb().prepare('SELECT project_id, mode, created_by_user_id, agent_id, cli_type, agent_environment_id FROM sessions WHERE id = ?').get(sessionId) as
    | { project_id: string | null; mode: string | null; created_by_user_id: string | null;agent_id:string|null;cli_type:string|null;agent_environment_id:string|null }
    | undefined;
  if (!row || !canUseSessionEnvironment(row,userId)) return false;
  if (isAdmin(userId)) return true;
  // Project membership grants permission to create a session, not permission
  // to inspect or control another user's session in the same project.
  if (row.created_by_user_id !== userId) return false;
  if (!row.project_id) return true;
  const resolvedMode = row.mode === 'terminal' ? 'terminal' : 'session';
  return userCanUseToolForProject(userId, row.project_id, resolvedMode as 'session' | 'terminal', cliType);
}

export function setProjectToolAccess(params: {
  projectId: string;
  userId: string;
  canSession: boolean;
  canTerminal: boolean;
  sessionClients: string[];
  grantedBy: string;
}): void {
  getDb().prepare(`
    INSERT INTO project_user_access (project_id, user_id, can_session, can_terminal, session_clients, granted_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(project_id, user_id) DO UPDATE SET
      can_session = excluded.can_session, can_terminal = excluded.can_terminal,
      session_clients = excluded.session_clients, granted_by = excluded.granted_by, updated_at = datetime('now')
  `).run(params.projectId, params.userId, params.canSession ? 1 : 0, params.canTerminal ? 1 : 0,
    JSON.stringify(params.canSession ? [...new Set(params.sessionClients)] : []), params.grantedBy);
}

export function removeProjectUserAccess(projectId: string, userId: string): number {
  return getDb().prepare('DELETE FROM project_user_access WHERE project_id = ? AND user_id = ?').run(projectId, userId).changes;
}

/** Assign all ownerless projects to a user (first-admin migration). Returns count. */
export function claimOrphanProjects(ownerId: string): number {
  return getDb().prepare('UPDATE projects SET owner_id = ? WHERE owner_id IS NULL').run(ownerId).changes as number;
}

export function getSessionAccess(sessionId: string): {
  project_id: string | null;
  mode: string | null;
  cli_type: string | null;
  created_by_user_id: string | null;
} | null {
  return getDb().prepare('SELECT project_id, mode, cli_type, created_by_user_id FROM sessions WHERE id = ?').get(sessionId) as
    | { project_id: string | null; mode: string | null; cli_type: string | null; created_by_user_id: string | null }
    | null;
}
