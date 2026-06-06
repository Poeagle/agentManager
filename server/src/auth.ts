/**
 * Authentication: password hashing (scrypt — no native deps), cookie-based
 * login sessions, and the Fastify onRequest hook that gates /api/* behind login.
 *
 * Soft multi-tenant model: this enforces *who is logged in*. Per-row data
 * ownership/filtering lives in the route handlers (see projects.owner_id).
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { nanoid } from 'nanoid';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { getDb } from './db/index.js';

export interface User {
  id: string;
  username: string;
  display_name: string;
  role: 'admin' | 'member';
  disabled: number;
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

/* ── Password hashing (scrypt) ─────────────────────────────────────── */

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/* ── User DB ops ───────────────────────────────────────────────────── */

const PUBLIC_COLS = 'id, username, display_name, role, disabled, created_at';

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
}): User {
  const id = nanoid(12);
  const username = opts.username.trim();
  getDb()
    .prepare(
      `INSERT INTO users (id, username, password_hash, display_name, role)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, username, hashPassword(opts.password), opts.display_name?.trim() || username, opts.role || 'member');
  return findUserById(id)!;
}

export function setUserPassword(id: string, password: string): void {
  getDb().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), id);
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
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.header(
    'Set-Cookie',
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`,
  );
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.header('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
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

/** All project IDs owned by a user. */
export function userProjectIds(userId: string): Set<string> {
  const rows = getDb().prepare('SELECT id FROM projects WHERE owner_id = ?').all(userId) as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

/** Does the user own this project id? */
export function userOwnsProject(userId: string, projectId: string | null | undefined): boolean {
  if (!projectId) return false;
  return !!getDb().prepare('SELECT 1 FROM projects WHERE id = ? AND owner_id = ?').get(projectId, userId);
}

/** Does the user own the project at this filesystem path? */
export function userOwnsProjectPath(userId: string, path: string | null | undefined): boolean {
  if (!path) return false;
  return !!getDb().prepare('SELECT 1 FROM projects WHERE path = ? AND owner_id = ?').get(path, userId);
}

/** Does the user own the project behind this session? (session.project_id → owner) */
export function userOwnsSession(userId: string, sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  return !!getDb()
    .prepare('SELECT 1 FROM sessions s JOIN projects p ON s.project_id = p.id WHERE s.id = ? AND p.owner_id = ?')
    .get(sessionId, userId);
}

/** Assign all ownerless projects to a user (first-admin migration). Returns count. */
export function claimOrphanProjects(ownerId: string): number {
  return getDb().prepare('UPDATE projects SET owner_id = ? WHERE owner_id IS NULL').run(ownerId).changes as number;
}
