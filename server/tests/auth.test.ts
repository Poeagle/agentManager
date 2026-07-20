import { afterEach, describe, expect, it } from 'vitest';
import {
  claimOrphanProjects,
  createSession,
  createUser,
  destroyUserSessions,
  destroySession,
  findUserByUsername,
  getSessionUser,
  hashPassword,
  listUsers,
  readSessionCookie,
  setUserPassword,
  userOwnsProject,
  userOwnsProjectPath,
  userOwnsSession,
  userProjectIds,
  verifyPassword,
} from '../src/auth.js';
import type { FastifyRequest } from 'fastify';
import { getDb } from '../src/db/index.js';
import { createTestDatabase } from './helpers/database.js';

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

describe('password hashing', () => {
  it('verifies the right password and rejects malformed or wrong values', () => {
    const stored = hashPassword('correct horse battery staple');
    expect(stored).toMatch(/^scrypt\$/);
    expect(verifyPassword('correct horse battery staple', stored)).toBe(true);
    expect(verifyPassword('wrong', stored)).toBe(false);
    expect(verifyPassword('anything', 'broken')).toBe(false);
  });
});

describe('login session lifecycle', () => {
  it('creates, resolves and destroys a cookie session', () => {
    ({ cleanup } = createTestDatabase());
    const user = createUser({ username: 'tester', password: 'secret12', role: 'admin' });
    const token = createSession(user.id);
    expect(getSessionUser(token)?.username).toBe('tester');
    destroySession(token);
    expect(getSessionUser(token)).toBeUndefined();
  });

  it('invalidates all sessions and rejects expired or disabled users', () => {
    ({ cleanup } = createTestDatabase());
    const user = createUser({ username: 'tester', password: 'secret12' });
    const first = createSession(user.id);
    const second = createSession(user.id);
    destroyUserSessions(user.id);
    expect(getSessionUser(first)).toBeUndefined();
    expect(getSessionUser(second)).toBeUndefined();

    const expired = createSession(user.id);
    getDb().prepare("UPDATE auth_sessions SET expires_at = datetime('now', '-1 day') WHERE token = ?").run(expired);
    expect(getSessionUser(expired)).toBeUndefined();

    const disabled = createSession(user.id);
    getDb().prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(user.id);
    expect(getSessionUser(disabled)).toBeUndefined();
  });
});

describe('users, cookies and ownership', () => {
  it('updates users and reads the AgentManager cookie among unrelated cookies', () => {
    ({ cleanup } = createTestDatabase());
    const user = createUser({ username: 'alice', password: 'old-password', display_name: 'Alice' });
    expect(listUsers()).toHaveLength(1);
    expect(findUserByUsername('alice')?.display_name).toBe('Alice');
    setUserPassword(user.id, 'new-password');
    expect(verifyPassword('new-password', findUserByUsername('alice')!.password_hash)).toBe(true);
    expect(readSessionCookie({ headers: { cookie: 'other=x; agentmanager_session=token%20123' } } as FastifyRequest)).toBe('token 123');
    expect(readSessionCookie({ headers: {} } as FastifyRequest)).toBeNull();
  });

  it('claims orphan projects and enforces project/session ownership', () => {
    ({ cleanup } = createTestDatabase());
    const alice = createUser({ username: 'alice', password: 'password1' });
    const bob = createUser({ username: 'bob', password: 'password2' });
    const db = getDb();
    db.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)').run('p1', 'Project', '/tmp/p1');
    expect(claimOrphanProjects(alice.id)).toBe(1);
    db.prepare("INSERT INTO sessions (id, project_id, task) VALUES ('s1', 'p1', 'Terminal')").run();

    expect(userProjectIds(alice.id)).toEqual(new Set(['p1']));
    expect(userOwnsProject(alice.id, 'p1')).toBe(true);
    expect(userOwnsProject(bob.id, 'p1')).toBe(false);
    expect(userOwnsProject(alice.id, null)).toBe(false);
    expect(userOwnsProjectPath(alice.id, '/tmp/p1')).toBe(true);
    expect(userOwnsProjectPath(alice.id, undefined)).toBe(false);
    expect(userOwnsSession(alice.id, 's1')).toBe(true);
    expect(userOwnsSession(bob.id, 's1')).toBe(false);
    expect(userOwnsSession(alice.id, null)).toBe(false);
  });
});
