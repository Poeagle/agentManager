import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authHook, createSession as createAuthSession, createUser, setProjectToolAccess } from '../src/auth.js';
import { getDb } from '../src/db/index.js';
import { sessionRoutes } from '../src/routes/sessions.js';
import * as sessionManager from '../src/services/session-manager.js';
import { createTestDatabase } from './helpers/database.js';

describe('session kill ownership', () => {
  let app: FastifyInstance;
  let cleanup: () => void;
  let ownerId: string;
  let ownerCookie: string;
  let viewerCookie: string;

  beforeEach(async () => {
    const database = createTestDatabase();
    cleanup = database.cleanup;

    const owner = createUser({ username: 'kill-owner', password: 'password1' });
    const viewer = createUser({ username: 'kill-viewer', password: 'password2', role: 'admin' });
    ownerId = owner.id;
    ownerCookie = `agentmanager_session=${createAuthSession(owner.id)}`;
    viewerCookie = `agentmanager_session=${createAuthSession(viewer.id)}`;

    getDb().prepare('INSERT INTO projects (id, name, path, owner_id) VALUES (?, ?, ?, ?)')
      .run('project-1', 'Project', database.dir, viewer.id);
    setProjectToolAccess({
      projectId: 'project-1',
      userId: owner.id,
      canSession: true,
      canTerminal: true,
      sessionClients: ['claude', 'codex'],
      grantedBy: viewer.id,
    });

    app = Fastify({ logger: false });
    app.addHook('onRequest', authHook);
    await app.register(sessionRoutes, { prefix: '/api' });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    cleanup();
  });

  it('reload is restricted to the owner and requires Agent write permission',async()=>{
    getDb().prepare("INSERT INTO sessions(id,project_id,task,status,mode,cli_type,codex_session_id,created_by_user_id) VALUES('reload-owned','project-1','Work','running','session','codex','019ff001-3434-7434-8434-343434343434',?)").run(ownerId);
    const reload=vi.spyOn(sessionManager,'reloadCodexSessionById').mockResolvedValue({ok:true,client_version:'0.166.0'});
    const denied=await app.inject({method:'POST',url:'/api/sessions/reload-owned/reload',headers:{cookie:viewerCookie}});expect(denied.statusCode).toBe(404);expect(reload).not.toHaveBeenCalled();
    getDb().prepare("UPDATE users SET role='member' WHERE id=?").run(ownerId);getDb().prepare('DELETE FROM rbac_user_roles WHERE user_id=?').run(ownerId);expect((await app.inject({method:'POST',url:'/api/sessions/reload-owned/reload',headers:{cookie:ownerCookie}})).statusCode).toBe(403);expect(reload).not.toHaveBeenCalled();
    getDb().prepare("UPDATE users SET role='admin' WHERE id=?").run(ownerId);const result=await app.inject({method:'POST',url:'/api/sessions/reload-owned/reload',headers:{cookie:ownerCookie}});expect(result.statusCode).toBe(200);expect(result.json().session.id).toBe('reload-owned');expect(reload).toHaveBeenCalledExactlyOnceWith('reload-owned');
  });
  it('explicit deletion stops the owned running session before purging its record',async()=>{
    getDb().prepare("INSERT INTO sessions(id,project_id,task,status,mode,cli_type,created_by_user_id) VALUES('delete-running','project-1','Task','running','session','codex',?)").run(ownerId);
    const kill=vi.spyOn(sessionManager,'killSession').mockImplementation(async id=>{getDb().prepare("UPDATE sessions SET status='cancelled' WHERE id=?").run(id);return true;});
    const result=await app.inject({method:'DELETE',url:'/api/sessions/delete-running/record?stop=true',headers:{cookie:ownerCookie}});
    expect(result.statusCode).toBe(200);expect(kill).toHaveBeenCalledExactlyOnceWith('delete-running');expect(sessionManager.getSession('delete-running')).toBeNull();
  });
  it('checks ownership before stopping, and retains the record if stopping fails',async()=>{
    getDb().prepare("INSERT INTO sessions(id,project_id,task,status,mode,cli_type,created_by_user_id) VALUES('delete-running','project-1','Task','running','session','codex',?)").run(ownerId);
    const kill=vi.spyOn(sessionManager,'killSession').mockRejectedValue(new Error('stop unavailable'));
    expect((await app.inject({method:'DELETE',url:'/api/sessions/delete-running/record?stop=true',headers:{cookie:viewerCookie}})).statusCode).toBe(404);expect(kill).not.toHaveBeenCalled();
    expect((await app.inject({method:'DELETE',url:'/api/sessions/delete-running/record?stop=invalid',headers:{cookie:ownerCookie}})).statusCode).toBe(400);expect(kill).not.toHaveBeenCalled();
    const result=await app.inject({method:'DELETE',url:'/api/sessions/delete-running/record?stop=true',headers:{cookie:ownerCookie}});expect(result.statusCode).toBe(503);expect(result.json().error).toContain('记录已保留');expect(sessionManager.getSession('delete-running')?.status).toBe('running');
  });
  it('does not let a viewer kill another user\'s open tab', async () => {
    getDb().prepare(`
      INSERT INTO sessions (id, project_id, task, status, mode, cli_type, created_by_user_id)
      VALUES ('owner-session', 'project-1', 'Owner work', 'running', 'session', 'claude', ?)
    `).run(ownerId);
    const kill = vi.spyOn(sessionManager, 'killSession').mockResolvedValue(true);

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/sessions/owner-session',
      headers: { cookie: viewerCookie },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Session not found' });
    expect(kill).not.toHaveBeenCalled();
    expect(getDb().prepare('SELECT status FROM sessions WHERE id = ?').get('owner-session'))
      .toEqual({ status: 'running' });
  });

  it('still lets a user kill their own tab', async () => {
    getDb().prepare(`
      INSERT INTO sessions (id, project_id, task, status, mode, cli_type, created_by_user_id)
      VALUES ('own-session', 'project-1', 'Own work', 'running', 'session', 'claude', ?)
    `).run(ownerId);
    const kill = vi.spyOn(sessionManager, 'killSession').mockResolvedValue(true);

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/sessions/own-session',
      headers: { cookie: ownerCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(kill).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledWith('own-session');
  });

  it('does not expose the retired desktop-terminal pop-out action', async () => {
    getDb().prepare(`
      INSERT INTO sessions (id, project_id, task, status, mode, cli_type, created_by_user_id)
      VALUES ('own-session', 'project-1', 'Own work', 'running', 'session', 'claude', ?)
    `).run(ownerId);
    const response = await app.inject({ method: 'POST', url: '/api/sessions/own-session/pop-out', headers: { cookie: ownerCookie } });
    expect(response.statusCode).toBe(404);
    expect(response.json().message).toContain('not found');
    expect(getDb().prepare('SELECT status FROM sessions WHERE id = ?').get('own-session')).toEqual({ status: 'running' });
  });

  it.each(['completed', 'failed', 'cancelled'])('deletes an owned %s session and its saved history', async (status) => {
    getDb().prepare(`INSERT INTO sessions (id, project_id, task, status, mode, cli_type, created_by_user_id)
      VALUES ('delete-record', 'project-1', 'Ended work', ?, 'session', 'codex', ?)`).run(status, ownerId);
    getDb().prepare("INSERT INTO pty_output (session_id, seq, data) VALUES ('delete-record', 1, 'saved output')").run();
    getDb().prepare("INSERT INTO session_snapshots (session_id, rendered) VALUES ('delete-record', 'saved screen')").run();
    getDb().prepare("INSERT INTO events (session_id, type) VALUES ('delete-record', 'session_end')").run();
    const response = await app.inject({ method: 'DELETE', url: '/api/sessions/delete-record/record', headers: { cookie: ownerCookie } });
    expect(response.statusCode).toBe(200);
    for (const table of ['sessions', 'pty_output', 'session_snapshots', 'events']) {
      expect(getDb().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
  });

  it.each(['running', 'pending', 'launching', 'detached', 'released'])('preserves %s sessions when record deletion is requested', async (status) => {
    getDb().prepare(`INSERT INTO sessions (id, project_id, task, status, mode, cli_type, created_by_user_id)
      VALUES ('active-record', 'project-1', 'Active work', ?, 'session', 'codex', ?)`).run(status, ownerId);
    const response = await app.inject({ method: 'DELETE', url: '/api/sessions/active-record/record', headers: { cookie: ownerCookie } });
    expect(response.statusCode).toBe(409);
    expect(getDb().prepare("SELECT status FROM sessions WHERE id = 'active-record'").get()).toEqual({ status });
  });

  it('does not let an administrator delete another user\'s session through the personal history API', async () => {
    getDb().prepare(`INSERT INTO sessions (id, project_id, task, status, mode, cli_type, created_by_user_id)
      VALUES ('other-record', 'project-1', 'Ended work', 'cancelled', 'session', 'codex', ?)`).run(ownerId);
    const response = await app.inject({ method: 'DELETE', url: '/api/sessions/other-record/record', headers: { cookie: viewerCookie } });
    expect(response.statusCode).toBe(404);
    expect(getDb().prepare("SELECT id FROM sessions WHERE id = 'other-record'").get()).toEqual({ id: 'other-record' });
  });

  it('bulk-deletes only the current user\'s ended records in the selected project', async () => {
    const insert = getDb().prepare(`
      INSERT INTO sessions (id, project_id, task, status, mode, cli_type, created_by_user_id)
      VALUES (?, 'project-1', ?, ?, 'session', 'claude', ?)
    `);
    insert.run('owner-ended', 'Finished owner work', 'completed', ownerId);
    insert.run('owner-running', 'Active owner work', 'running', ownerId);
    const viewer = getDb().prepare('SELECT id FROM users WHERE username = ?').get('kill-viewer') as { id: string };
    insert.run('viewer-ended', 'Finished viewer work', 'cancelled', viewer.id);
    getDb().prepare(`
      INSERT INTO session_snapshots (session_id, rendered) VALUES ('owner-ended', 'saved screen')
    `).run();
    getDb().prepare(`
      INSERT INTO events (session_id, type) VALUES ('owner-ended', 'session_end')
    `).run();

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/sessions/records/ended?project_id=project-1',
      headers: { cookie: ownerCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, deleted: 1, failed: 0 });
    expect(getDb().prepare('SELECT id FROM sessions ORDER BY id').all()).toEqual([
      { id: 'owner-running' },
      { id: 'viewer-ended' },
    ]);
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM session_snapshots').get()).toEqual({ count: 0 });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM events').get()).toEqual({ count: 0 });
  });

  it.each(['completed', 'failed', 'cancelled'])('closes an ended %s session idempotently without signalling its historical PID', async (status) => {
    getDb().prepare(`
      INSERT INTO sessions (id, project_id, task, status, mode, cli_type, created_by_user_id, pid)
      VALUES ('ended-session', 'project-1', 'Finished work', ?, 'session', 'codex', ?, ?)
    `).run(status, ownerId, process.pid);
    getDb().prepare("INSERT INTO pty_output (session_id, seq, data) VALUES ('ended-session', 1, 'buffer')").run();
    const signal = vi.spyOn(process, 'kill');
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await app.inject({ method: 'DELETE', url: '/api/sessions/ended-session', headers: { cookie: ownerCookie } });
      expect(response.statusCode).toBe(200);
    }
    expect(signal).not.toHaveBeenCalled();
    expect(getDb().prepare("SELECT pid, status FROM sessions WHERE id = 'ended-session'").get()).toEqual({ pid: null, status });
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM pty_output WHERE session_id = 'ended-session'").get()).toEqual({ count: 0 });
  });
  it('rejects stale browser automatic-resume requests without starting a process', async () => {
    getDb().prepare(`INSERT INTO sessions (id, project_id, task, status, mode, cli_type, created_by_user_id)
      VALUES ('resume-session','project-1','work','failed','session','codex',?)`).run(ownerId);
    const resume = vi.spyOn(sessionManager, 'resumeSessionById').mockResolvedValue({ ok: true });
    const response = await app.inject({ method: 'POST', url: '/api/sessions/resume-session/resume',
      headers: { cookie: ownerCookie }, payload: { automatic: true } });
    expect(response.statusCode).toBe(409); expect(resume).not.toHaveBeenCalled();
  });

  it('allows an explicit Resume action through the existing permission checks', async () => {
    getDb().prepare(`INSERT INTO sessions (id, project_id, task, status, mode, cli_type, created_by_user_id)
      VALUES ('resume-session','project-1','work','failed','session','codex',?)`).run(ownerId);
    const resume = vi.spyOn(sessionManager, 'resumeSessionById').mockResolvedValue({ ok: true });
    const response = await app.inject({ method: 'POST', url: '/api/sessions/resume-session/resume',
      headers: { cookie: ownerCookie }, payload: {} });
    expect(response.statusCode).toBe(200); expect(resume).toHaveBeenCalledWith('resume-session');
  });

});
