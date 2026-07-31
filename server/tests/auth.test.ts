import { afterEach, describe, expect, it } from 'vitest';
import {
  claimOrphanProjects,
  createSession,
  createUser,
  destroyUserSessions,
  destroySession,
  findUserByUsername,
  getUserTabUsage,
  isAdmin,
  setProjectToolAccess,
  getSessionUser,
  hashPassword,
  userCanUseSessionTool,
  userCanUseToolForProject,
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
    db.prepare("INSERT INTO sessions (id, project_id, task, created_by_user_id) VALUES ('s1', 'p1', 'Terminal', ?)").run(alice.id);

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

  it('computes project permissions through tool matrix and session matrix', () => {
    ({ cleanup } = createTestDatabase());
    const owner = createUser({ username: 'owner', password: 'owner-pass' });
    const member = createUser({ username: 'member', password: 'member-pass' });
    const admin = createUser({ username: 'admin', password: 'admin-pass', role: 'admin' });
    const db = getDb();

    db.prepare('INSERT INTO projects (id, name, path, owner_id) VALUES (?, ?, ?, ?)').run('p1', 'P1', '/tmp/p1', owner.id);
    expect(isAdmin(admin.id)).toBe(true);

    expect(userProjectIds(owner.id)).toEqual(new Set(['p1']));
    expect(userProjectIds(member.id).has('p1')).toBe(false);
    expect(userCanUseToolForProject(member.id, 'p1', 'session', 'claude')).toBe(false);

    setProjectToolAccess({
      projectId: 'p1',
      userId: member.id,
      canSession: true,
      canAgent: true,
      canTerminal: false,
      canClaude: false,
      canCodex: false,
      grantedBy: owner.id,
    });
    expect(userProjectIds(member.id)).toEqual(new Set(['p1']));
    expect(userCanUseToolForProject(member.id, 'p1', 'session', 'claude')).toBe(false);
    expect(userCanUseToolForProject(member.id, 'p1', 'terminal', 'claude')).toBe(false);
    expect(userCanUseToolForProject(member.id, 'p1', 'agent', 'claude')).toBe(false);
    expect(userCanUseToolForProject(member.id, 'p1', 'session', 'codex')).toBe(false);

    setProjectToolAccess({
      projectId: 'p1',
      userId: member.id,
      canSession: false,
      canAgent: false,
      canTerminal: true,
      canClaude: false,
      canCodex: false,
      grantedBy: owner.id,
    });
    expect(userProjectIds(member.id).has('p1')).toBe(true);
    expect(userCanUseToolForProject(member.id, 'p1', 'terminal', 'claude')).toBe(true);
    expect(userCanUseToolForProject(member.id, 'p1', 'session', 'claude')).toBe(false);

    // Explicitly revoke everything: project should disappear from user's allowed-id set.
    setProjectToolAccess({
      projectId: 'p1',
      userId: member.id,
      canSession: false,
      canAgent: false,
      canTerminal: false,
      canClaude: false,
      canCodex: false,
      grantedBy: owner.id,
    });
    expect(userProjectIds(member.id).has('p1')).toBe(false);
    expect(userOwnsProject(member.id, 'p1')).toBe(false);

    // Session-level access should also honor project tool mode and creator fallback.
    db.prepare(`
      INSERT INTO sessions (id, project_id, task, status, mode, cli_type, created_by_user_id)
      VALUES ('s-term', 'p1', 't', 'running', 'terminal', 'claude', NULL)
    `).run();
    db.prepare(`
      INSERT INTO sessions (id, project_id, task, status, mode, cli_type, created_by_user_id)
      VALUES ('s-own', 'p1', 't', 'running', 'session', 'claude', ?)
    `).run(member.id);
    expect(userCanUseSessionTool(member.id, 's-term', 'claude', 'terminal')).toBe(false);
    expect(userCanUseSessionTool(admin.id, 's-term', 'claude', 'terminal')).toBe(true);
    expect(userCanUseSessionTool(member.id, 's-own', 'claude', 'session')).toBe(false);
  });

  it('isolates sessions between members of the same project and enforces tab limits', () => {
    ({ cleanup } = createTestDatabase());
    const alice = createUser({ username: 'alice', password: 'password1', max_tabs: 1 });
    const bob = createUser({ username: 'bob', password: 'password2' });
    const admin = createUser({ username: 'admin', password: 'password3', role: 'admin' });
    const db = getDb();
    db.prepare('INSERT INTO projects (id, name, path, owner_id) VALUES (?, ?, ?, ?)').run('p1', 'P1', '/tmp/p1', admin.id);
    for (const user of [alice, bob]) {
      setProjectToolAccess({
        projectId: 'p1', userId: user.id, canSession: true, canAgent: true,
        canTerminal: true, canClaude: true, canCodex: true, grantedBy: admin.id,
      });
    }
    db.prepare(`
      INSERT INTO sessions (id, project_id, task, status, mode, cli_type, created_by_user_id)
      VALUES ('alice-session', 'p1', 'work', 'running', 'session', 'claude', ?)
    `).run(alice.id);

    expect(userCanUseSessionTool(alice.id, 'alice-session', 'claude', 'session')).toBe(true);
    expect(userCanUseSessionTool(bob.id, 'alice-session', 'claude', 'session')).toBe(false);
    expect(userOwnsSession(bob.id, 'alice-session')).toBe(false);
    expect(userCanUseSessionTool(admin.id, 'alice-session', 'claude', 'session')).toBe(true);
    expect(getUserTabUsage(alice.id)).toEqual({ limit: 1, used: 1, allowed: false });
    expect(getUserTabUsage(bob.id)).toEqual({ limit: 10, used: 0, allowed: true });
  });
});
