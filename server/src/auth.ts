/**
 * Authentication: password hashing (scrypt — no native deps), cookie-based
 * login sessions, and the Fastify onRequest hook that gates /api/* behind login.
 *
 * Soft multi-tenant model: this enforces *who is logged in*. Per-row data
 * ownership/filtering lives in the route handlers (see projects.owner_id).
 */
import { createHmac, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'crypto';
import { chmodSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { dirname, join, resolve, sep } from 'path';
import { nanoid } from 'nanoid';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { getDb } from './db/index.js';
import { config } from './config.js';

export interface User {
  id: string;
  username: string;
  display_name: string;
  role: 'admin' | 'member';
  disabled: number;
  max_tabs: number;
  created_at: string;
}

// Make req.user available with types everywhere.
declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
  }
}

const SESSION_COOKIE = 'agentmanager_session';
const SESSION_TTL_DAYS = 30;
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

const PUBLIC_COLS = 'id, username, display_name, role, disabled, max_tabs, created_at';

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
}): User {
  return insertUser(opts, hashPassword(opts.password));
}

export async function createUserAsync(opts: {
  username: string;
  password: string;
  display_name?: string;
  role?: 'admin' | 'member';
  max_tabs?: number;
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
}, passwordHash: string): User {
  const id = nanoid(12);
  const username = opts.username.trim();
  getDb()
    .prepare(
      `INSERT INTO users (id, username, password_hash, display_name, role, max_tabs)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, username, passwordHash, opts.display_name?.trim() || username, opts.role || 'member', opts.max_tabs ?? 10);
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

export function createSession(userId: string): string {
  const token = randomBytes(32).toString('hex');
  getDb()
    .prepare(
      `INSERT INTO auth_sessions (token, user_id, expires_at)
       VALUES (?, ?, datetime('now', ?))`,
    )
    .run(token, userId, `+${SESSION_TTL_DAYS} days`);
  return token;
}

/** Resolve a session token to a live, non-disabled user; slides expiry. */
export function getSessionUser(token: string): User | undefined {
  const db = getDb();
  const row = db
    .prepare('SELECT user_id, expires_at FROM auth_sessions WHERE token = ?')
    .get(token) as { user_id: string; expires_at: string } | undefined;
  if (!row) return undefined;
  if (new Date(row.expires_at + 'Z').getTime() < Date.now()) {
    db.prepare('DELETE FROM auth_sessions WHERE token = ?').run(token);
    return undefined;
  }
  db.prepare(
    `UPDATE auth_sessions SET last_seen_at = datetime('now'), expires_at = datetime('now', ?) WHERE token = ?`,
  ).run(`+${SESSION_TTL_DAYS} days`, token);
  const user = findUserById(row.user_id);
  if (!user || user.disabled) return undefined;
  return user;
}

export function destroySession(token: string): void {
  getDb().prepare('DELETE FROM auth_sessions WHERE token = ?').run(token);
}

/** Invalidate every session for a user (e.g. on disable / password reset). */
export function destroyUserSessions(userId: string): void {
  getDb().prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(userId);
}

/* ── Cookie helpers ────────────────────────────────────────────────── */

export function readSessionCookie(req: FastifyRequest): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  const secure = config.secureCookies ? '; Secure' : '';
  reply.header(
    'Set-Cookie',
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${secure}`,
  );
}

export function clearSessionCookie(reply: FastifyReply): void {
  const secure = config.secureCookies ? '; Secure' : '';
  reply.header('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
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

  // Always resolve the user when a valid session cookie is present, so public
  // endpoints (e.g. /auth/status) can still report who is logged in.
  const token = readSessionCookie(req);
  const user = token ? getSessionUser(token) : undefined;
  if (user) req.user = user;

  if (PUBLIC_PATHS.has(path)) return;        // public: login not required
  if (!user) return reply.code(401).send({ error: 'Unauthorized' });
}

/* ── Data-ownership access helpers (soft multi-tenant) ─────────────── */

export interface ProjectToolAccess {
  project_id: string;
  canSession: boolean;
  canAgent: boolean;
  canTerminal: boolean;
  canClaude: boolean;
  canCodex: boolean;
}

type RawProjectAccess = {
  can_session: number;
  can_agent: number;
  can_terminal: number;
  can_claude: number;
  can_codex: number;
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
    canAgent: bool(row.can_agent),
    canTerminal: bool(row.can_terminal),
    canClaude: bool(row.can_claude),
    canCodex: bool(row.can_codex),
  };
  if (!access.canSession && !access.canAgent && !access.canTerminal && !access.canClaude && !access.canCodex) return null;
  return access;
}

export function getProjectToolAccess(userId: string, projectId: string | null | undefined): ProjectToolAccess | null {
  if (!projectId) return null;
  if (isAdmin(userId)) {
    return {
      project_id: projectId,
      canSession: true,
      canAgent: true,
      canTerminal: true,
      canClaude: true,
      canCodex: true,
    };
  }

  const explicit = getDb()
    .prepare('SELECT can_session, can_agent, can_terminal, can_claude, can_codex FROM project_user_access WHERE project_id = ? AND user_id = ?')
    .get(projectId, userId) as RawProjectAccess | undefined;
  if (explicit) return mapProjectToolAccess(projectId, explicit);

  // Fallback for old owner_id models.
  const ownerMatch = getDb().prepare('SELECT 1 FROM projects WHERE id = ? AND owner_id = ?').get(projectId, userId);
  if (ownerMatch) {
    return {
      project_id: projectId,
      canSession: true,
      canAgent: true,
      canTerminal: true,
      canClaude: true,
      canCodex: true,
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
      AND (can_session = 1 OR can_agent = 1 OR can_terminal = 1 OR can_claude = 1 OR can_codex = 1)
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
  toolMode: 'session' | 'terminal' | 'agent',
  cliType: 'claude' | 'codex' = 'claude',
): boolean {
  const access = getProjectToolAccess(userId, projectId);
  if (!access) return false;
  const modeAllowed = toolMode === 'terminal'
    ? access.canTerminal
    : toolMode === 'agent'
      ? access.canAgent
      : access.canSession;
  if (toolMode === 'terminal') return modeAllowed;
  const cliAllowed = cliType === 'codex' ? access.canCodex : access.canClaude;
  return modeAllowed && cliAllowed;
}

export function userCanUseSessionTool(userId: string, sessionId: string, cliType: 'claude' | 'codex', toolMode: 'session' | 'terminal' | 'agent'): boolean {
  const row = getDb().prepare('SELECT project_id, mode, created_by_user_id FROM sessions WHERE id = ?').get(sessionId) as
    | { project_id: string | null; mode: string | null; created_by_user_id: string | null }
    | undefined;
  if (!row) return false;
  if (isAdmin(userId)) return true;
  // Project membership grants permission to create a session, not permission
  // to inspect or control another user's session in the same project.
  if (row.created_by_user_id !== userId) return false;
  if (!row.project_id) return true;
  if (row.mode === 'agent' && toolMode !== 'agent') return false;
  const resolvedMode = row.mode === 'agent' ? 'agent' : (row.mode === 'terminal' ? 'terminal' : 'session');
  return userCanUseToolForProject(userId, row.project_id, resolvedMode as 'session' | 'terminal' | 'agent', cliType);
}

export function setProjectToolAccess(params: {
  projectId: string;
  userId: string;
  canSession: boolean;
  canAgent: boolean;
  canTerminal: boolean;
  canClaude: boolean;
  canCodex: boolean;
  grantedBy: string;
}): void {
  getDb()
    .prepare(`
      INSERT INTO project_user_access (project_id, user_id, can_session, can_agent, can_terminal, can_claude, can_codex, granted_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(project_id, user_id) DO UPDATE SET
        can_session = excluded.can_session,
        can_agent = excluded.can_agent,
        can_terminal = excluded.can_terminal,
        can_claude = excluded.can_claude,
        can_codex = excluded.can_codex,
        granted_by = excluded.granted_by,
        updated_at = datetime('now')
    `)
    .run(
      params.projectId,
      params.userId,
      params.canSession ? 1 : 0,
      params.canAgent ? 1 : 0,
      params.canTerminal ? 1 : 0,
      params.canClaude ? 1 : 0,
      params.canCodex ? 1 : 0,
      params.grantedBy,
    );
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
