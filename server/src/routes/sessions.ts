import { FastifyPluginAsync } from 'fastify';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Terminal: HeadlessTerminal } = require('@xterm/headless') as { Terminal: any };
const { SerializeAddon } = require('@xterm/addon-serialize') as { SerializeAddon: any };
import * as sessionManager from '../services/session-manager.js';
import { RESIZE_MARKER, registerPendingSpawn } from '../services/session-manager.js';
import { getTracker } from '../services/session-state.js';
import { getDb } from '../db/index.js';
import { getUserTabUsage, isAdmin, userCanUseSessionTool, userCanUseToolForProject, userOwnsProject, userOwnsProjectPath, userProjectIds } from '../auth.js';
import { listClaudeSessions, deleteClaudeSession } from '../services/claude-history.js';
import { strip } from '../lib/ansi.js';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'fs';
import { isAbsolute, join, relative, sep } from 'path';
import { prunePastesDir } from '../services/paste-cleanup.js';
import { sessionPresenter } from '../services/session-labels.js';
import { readCodexRuntime } from '../services/codex-runtime.js';

const MAX_PASTED_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_PASTED_FILE_BYTES = 35 * 1024 * 1024;

function decodePastedDataUrl(dataUrl: unknown): { mime: string; bytes: Buffer } | null {
  if (typeof dataUrl !== 'string') return null;
  const match = /^data:([^;,]*);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match || match[2].length % 4 !== 0) return null;
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.toString('base64') !== match[2]) return null;
  return { mime: match[1].toLowerCase(), bytes };
}

function imageExtension(mime: string, bytes: Buffer): string | null {
  if (mime === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (mime === 'image/jpeg' && bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) return 'jpg';
  if (mime === 'image/gif' && (bytes.subarray(0, 6).toString() === 'GIF87a' || bytes.subarray(0, 6).toString() === 'GIF89a')) return 'gif';
  if (mime === 'image/webp' && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'webp';
  return null;
}

function sessionPastesDir(projectPath: string): string {
  const projectRoot = realpathSync(projectPath);
  const managerDir = join(projectRoot, '.agentmanager');
  mkdirSync(managerDir, { recursive: true });
  const realManagerDir = realpathSync(managerDir);
  const managerChild = relative(projectRoot, realManagerDir);
  if (!managerChild || isAbsolute(managerChild) || managerChild === '..' || managerChild.startsWith(`..${sep}`)) {
    throw new Error('Paste directory is outside the project');
  }
  const dir = join(realManagerDir, 'pastes');
  mkdirSync(dir, { recursive: true });
  const realDir = realpathSync(dir);
  const child = relative(projectRoot, realDir);
  if (!child || isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`)) {
    throw new Error('Paste directory is outside the project');
  }
  const ignore = join(realManagerDir, '.gitignore');
  if (!existsSync(ignore)) {
    try { writeFileSync(ignore, '*\n', { flag: 'wx' }); }
    catch (error: any) { if (error?.code !== 'EEXIST') throw error; }
  }
  return realDir;
}

function normalizeMode(mode: string | null | undefined): 'session' | 'terminal' {
  if (mode === 'terminal') return mode;
  return 'session';
}

function normalizeCliType(cliType: string | null | undefined): 'claude' | 'codex' {
  return cliType === 'codex' ? 'codex' : 'claude';
}

function canAccessSessionByRow(userId: string, row: {
  id: string;
  project_id: string | null;
  mode: string | null;
  cli_type?: string | null;
  created_by_user_id: string | null;
}): boolean {
  if (isAdmin(userId)) return true;
  if (row.created_by_user_id !== userId) return false;
  if (!row.project_id) return true;
  return userCanUseToolForProject(userId, row.project_id, normalizeMode(row.mode), normalizeCliType(row.cli_type));
}

function canAccessSessionById(userId: string, sessionId: string, mode: 'session' | 'terminal', cliType: 'claude' | 'codex'): boolean {
  return userCanUseSessionTool(userId, sessionId, cliType, mode);
}

function sqliteUtcToIso(value: string | null | undefined): string | null {
  if (!value) return null;
  if (/Z$|[+-]\d\d:\d\d$/.test(value)) return value;
  return `${value.replace(' ', 'T')}Z`;
}

function summarizeSessionContent(task: string | null | undefined, output: string | null | undefined): string {
  const normalizedTask = (task || '').replace(/\s+/g, ' ').trim();
  if (normalizedTask && normalizedTask !== 'Terminal') return normalizedTask.slice(0, 180);

  const text = strip(output || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-4)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, 180) || normalizedTask || '暂无会话内容';
}

export const sessionRoutes: FastifyPluginAsync = async (app) => {
  // List sessions
  app.get<{
    Querystring: { status?: string; project_id?: string };
  }>('/sessions', async (req) => {
    const all = sessionManager.listSessionsForUser(req.user!.id, req.query.status, req.query.project_id);
    const owned = userProjectIds(req.user!.id);
    const visible = all
      .filter((s: any) => !s.project_id || owned.has(s.project_id))
      .filter((s: any) => canAccessSessionByRow(req.user!.id, s));
    const outputActivity = new Map<string, { createdAt: string; data: string }>();
    if (visible.length > 0) {
      const placeholders = visible.map(() => '?').join(',');
      const rows = getDb().prepare(`
        SELECT p.session_id, p.created_at, p.data
        FROM pty_output p
        INNER JOIN (
          SELECT session_id, MAX(seq) AS latest_seq
          FROM pty_output
          WHERE session_id IN (${placeholders})
          GROUP BY session_id
        ) latest ON latest.session_id = p.session_id AND latest.latest_seq = p.seq
      `).all(...visible.map((session: any) => session.id)) as Array<{ session_id: string; created_at: string; data: string }>;
      for (const row of rows) {
        outputActivity.set(row.session_id, { createdAt: row.created_at, data: row.data });
      }
    }
    const present = sessionPresenter(req.user!.id);
    const sessions = await Promise.all(visible
      // Enrich with live process-state (busy/idle/waiting_for_input) so tab signal
      // lights are correct on first load, before any WS state_change arrives.
      .map(async (s: any) => {
        const st = getTracker(s.id)?.state;
        const native = s.cli_type === 'codex' ? {...await readCodexRuntime(s.codex_session_id)} : null;
        if (native && ['running','waiting_for_input'].includes(native.state)
          && await sessionManager.getLiveWorkAgent(s.id) !== 'codex') {
          native.state='unknown'; native.reason='原生记录中的执行尚未结束，但未确认到对应 Codex 进程，当前状态待确认';
        }
        const lastActivityAt = st?.lastActivity
          ? new Date(st.lastActivity).toISOString()
          : sqliteUtcToIso(outputActivity.get(s.id)?.createdAt ?? s.updated_at ?? s.completed_at ?? s.started_at ?? s.created_at);
        return {
          ...s,
          ...present(s),
          last_activity_at: native ? native.last_activity_at : lastActivityAt,
          ...(native ? {agent_runtime:native} : {}),
          content_summary: summarizeSessionContent(s.task, outputActivity.get(s.id)?.data),
          ...(st ? { processState: st.processState, promptType: st.promptType, isPermission: st.isPermission } : {}),
        };
      }));
    return { sessions };
  });

  // Discover external detached sessions available for adoption
  // (must be registered before /sessions/:id to avoid parameterized route match)
  app.get<{
    Querystring: { project_path?: string };
  }>('/sessions/discoverable', async (req) => {
    if (!isAdmin(req.user!.id)) return { sessions: [] };
    if (req.query.project_path && !userOwnsProjectPath(req.user!.id, req.query.project_path)) {
      return { sessions: [] };
    }
    const sessions = await sessionManager.discoverExternalSessions(req.query.project_path);
    return { sessions };
  });

  // Adopt an external detached session into AgentManager
  app.post<{
    Body: { socket_path: string; project_id?: string };
  }>('/sessions/adopt', async (req, reply) => {
    if (!isAdmin(req.user!.id)) return reply.status(403).send({ error: 'Admin only' });
    const { socket_path, project_id } = req.body as any;
    if (!socket_path) {
      return reply.status(400).send({ error: 'socket_path is required' });
    }
    if (!project_id || !userCanUseToolForProject(req.user!.id, project_id, 'terminal', 'claude')) {
      return reply.status(400).send({ error: 'project_id is required and must be accessible' });
    }

    const session = await sessionManager.adoptDtachSession(socket_path, project_id, req.user!.id);
    if (!session) {
      return reply.status(404).send({ error: 'Socket not found or not alive' });
    }
    if (!canAccessSessionById(req.user!.id, session.id, 'terminal', normalizeCliType(session.cli_type))) {
      return reply.status(403).send({ error: 'Project not found or not yours' });
    }

    return { ok: true, session };
  });

  // Get single session
  app.get<{
    Params: { id: string };
  }>('/sessions/:id', async (req, reply) => {
    const session = sessionManager.getSession(req.params.id);
    if (!session || !canAccessSessionByRow(req.user!.id, session)) return reply.status(404).send({ error: 'Session not found' });
    return { session: {...session, ...sessionPresenter(req.user!.id)(session)} };
  });

  // Clipboard data is stored inside the session's project; the terminal only
  // receives the resulting path after the upload succeeds.
  app.post<{ Params: { id: string }; Body: { dataUrl?: string } }>(
    '/sessions/:id/paste-image', { bodyLimit: 15 * 1024 * 1024 }, async (req, reply) => {
      const session = sessionManager.getSession(req.params.id);
      if (!session || !canAccessSessionByRow(req.user!.id, session)) return reply.status(404).send({ error: 'Session not found' });
      const project = session.project_id
        ? getDb().prepare('SELECT path FROM projects WHERE id = ?').get(session.project_id) as { path: string } | undefined
        : undefined;
      if (!project?.path) return reply.status(400).send({ error: 'Session has no associated project path' });

      const data = decodePastedDataUrl(req.body?.dataUrl);
      if (!data) return reply.status(400).send({ error: 'Expected a base64 image data URL' });
      if (data.bytes.length > MAX_PASTED_IMAGE_BYTES) return reply.status(413).send({ error: 'Image too large (max 10 MB)' });
      const ext = imageExtension(data.mime, data.bytes);
      if (!ext) return reply.status(400).send({ error: 'Unsupported or invalid image (png/jpeg/gif/webp)' });

      try {
        const dir = sessionPastesDir(project.path);
        const path = join(dir, `paste-${randomUUID()}.${ext}`);
        writeFileSync(path, data.bytes, { flag: 'wx' });
        prunePastesDir(dir);
        return { ok: true, path };
      } catch (error: any) {
        return reply.status(500).send({ error: `Failed to save image: ${error?.message || 'unknown error'}` });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { dataUrl?: string; filename?: string } }>(
    '/sessions/:id/paste-file', { bodyLimit: 50 * 1024 * 1024 }, async (req, reply) => {
      const session = sessionManager.getSession(req.params.id);
      if (!session || !canAccessSessionByRow(req.user!.id, session)) return reply.status(404).send({ error: 'Session not found' });
      const project = session.project_id
        ? getDb().prepare('SELECT path FROM projects WHERE id = ?').get(session.project_id) as { path: string } | undefined
        : undefined;
      if (!project?.path) return reply.status(400).send({ error: 'Session has no associated project path' });

      const data = decodePastedDataUrl(req.body?.dataUrl);
      if (!data) return reply.status(400).send({ error: 'Expected a base64 file data URL' });
      if (data.bytes.length > MAX_PASTED_FILE_BYTES) return reply.status(413).send({ error: 'File too large (max 35 MB)' });
      const base = (typeof req.body?.filename === 'string' ? req.body.filename : '').split(/[\\/]/).pop() || '';
      const safeName = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 100) || 'file';

      try {
        const dir = sessionPastesDir(project.path);
        const path = join(dir, `paste-${randomUUID()}-${safeName}`);
        writeFileSync(path, data.bytes, { flag: 'wx' });
        prunePastesDir(dir);
        return { ok: true, path };
      } catch (error: any) {
        return reply.status(500).send({ error: `Failed to save file: ${error?.message || 'unknown error'}` });
      }
    },
  );

  // Resume an ended Claude or Codex conversation in place. The AgentManager
  // session id (and therefore the project tab mapping) remains unchanged.
  app.post<{ Params: { id: string }; Body: { automatic?: boolean } }>('/sessions/:id/resume', async (req, reply) => {
    const { id } = req.params;
    const session = sessionManager.getSession(id);
    if (!session || !canAccessSessionByRow(req.user!.id, session)) return reply.status(404).send({ error: 'Session not found' });
    if (req.body?.automatic === true) {
      return reply.status(409).send({ error: 'Automatic resume is disabled; use Resume to restart this session' });
    }
    const result = await sessionManager.resumeSessionById(id);
    if (!result.ok) return reply.status(400).send({ error: result.error });
    return { ok: true, session: sessionManager.getSession(id) };
  });

  // Permanently delete an ended session from history: DB row + events + the
  // Claude JSONL conversation file. Refuses (409) while the session is active.
  app.delete<{ Params: { id: string } }>('/sessions/:id/record', async (req, reply) => {
    const { id } = req.params;
    const session = sessionManager.getSession(id);
    // Match the personal session list and close endpoint: monitoring access
    // does not grant permission to delete another user's conversation.
    if (!session || session.created_by_user_id !== req.user!.id || !canAccessSessionByRow(req.user!.id, session)) {
      return reply.status(404).send({ error: 'Session not found' });
    }
    const result = sessionManager.purgeSessionRecord(id);
    if (!result.ok) return reply.status(409).send({ error: result.error });
    return { ok: true };
  });

  // Bulk-delete this account's ended records for one project. The query is
  // deliberately ownership-scoped even for administrators: the regular project
  // UI is personal, while cross-account management belongs to /admin/monitor.
  app.delete<{ Querystring: { project_id?: string } }>('/sessions/records/ended', async (req, reply) => {
    const projectId = req.query.project_id;
    if (!projectId) return reply.status(400).send({ error: 'project_id is required' });
    if (!userOwnsProject(req.user!.id, projectId)) return reply.status(404).send({ error: 'Project not found' });

    const candidates = getDb().prepare(`
      SELECT id FROM sessions
      WHERE project_id = ? AND created_by_user_id = ?
        AND status IN ('completed', 'failed', 'cancelled')
      ORDER BY COALESCE(completed_at, created_at) DESC
    `).all(projectId, req.user!.id) as Array<{ id: string }>;

    let deleted = 0;
    let failed = 0;
    for (const { id } of candidates) {
      const result = sessionManager.purgeSessionRecord(id);
      if (result.ok) deleted++;
      else failed++;
    }
    return { ok: failed === 0, deleted, failed };
  });

  /* ---- Claude on-disk conversation history (keyed by project path) ---- */

  // Resolve { projectPath, projectId } from a query/body, enforcing ownership.
  function resolveProject(userId: string, pid?: string, ppath?: string): { ok: true; path: string; id: string | null } | { ok: false; code: number; error: string } {
    if (pid) {
      if (!userCanUseToolForProject(userId, pid, 'session', 'claude')) {
        return { ok: false, code: 404, error: 'Project not found' };
      }
      const p = getDb().prepare('SELECT path FROM projects WHERE id = ?').get(pid) as { path: string } | undefined;
      if (!p?.path) return { ok: false, code: 404, error: 'Project path not found' };
      return { ok: true, path: p.path, id: pid };
    }
    if (ppath) {
      const p = getDb().prepare('SELECT id FROM projects WHERE path = ?').get(ppath) as { id: string } | undefined;
      if (!p?.id || !userCanUseToolForProject(userId, p.id, 'session', 'claude')) {
        return { ok: false, code: 404, error: 'Project not found' };
      }
      return { ok: true, path: ppath, id: p?.id ?? null };
    }
    return { ok: false, code: 400, error: 'project_id or project_path is required' };
  }

  // List a project's Claude conversation logs, with live AgentManager status.
  app.get<{ Querystring: { project_id?: string; project_path?: string } }>('/sessions/claude-history', async (req, reply) => {
    const r = resolveProject(req.user!.id, req.query.project_id, req.query.project_path);
    if (!r.ok) return reply.status(r.code).send({ error: r.error });

    let items = listClaudeSessions(r.path);
    if (!isAdmin(req.user!.id)) {
      const ownRows = getDb().prepare(`
        SELECT DISTINCT claude_session_id AS uuid
        FROM sessions
        WHERE project_id = ? AND created_by_user_id = ? AND claude_session_id IS NOT NULL
      `).all(r.id, req.user!.id) as { uuid: string }[];
      const ownUuids = new Set(ownRows.map((row) => row.uuid));
      items = items.filter((item) => ownUuids.has(item.uuid));
    }
    const liveByUuid = new Map<string, { id: string; status: string }>();
    if (items.length && r.id) {
      const uuids = items.map((i) => i.uuid);
      const rows = (isAdmin(req.user!.id)
        ? getDb().prepare(`SELECT id, status, claude_session_id FROM sessions WHERE project_id = ? AND claude_session_id IN (${uuids.map(() => '?').join(',')})`).all(r.id, ...uuids)
        : getDb().prepare(`SELECT id, status, claude_session_id FROM sessions WHERE project_id = ? AND created_by_user_id = ? AND claude_session_id IN (${uuids.map(() => '?').join(',')})`).all(r.id, req.user!.id, ...uuids)) as { id: string; status: string; claude_session_id: string }[];
      for (const row of rows) liveByUuid.set(row.claude_session_id, { id: row.id, status: row.status });
    }
    const sessions = items.map((i) => {
      const l = liveByUuid.get(i.uuid);
      return { ...i, liveSessionId: l?.id ?? null, liveStatus: l?.status ?? null };
    });
    return { projectId: r.id, sessions };
  });

  // Resume a Claude conversation log by uuid (creates a fresh live session).
  app.post<{ Body: { project_id?: string; project_path?: string; claude_session_id?: string; title?: string } }>('/sessions/resume-claude', async (req, reply) => {
    const body = (req.body || {}) as { project_id?: string; project_path?: string; claude_session_id?: string; title?: string };
    if (!body.claude_session_id) return reply.status(400).send({ error: 'claude_session_id is required' });
    const usage = getUserTabUsage(req.user!.id);
    if (!usage.allowed) return reply.status(429).send({ error: `已达到活动标签页上限（${usage.limit}）` });
    const r = resolveProject(req.user!.id, body.project_id, body.project_path);
    if (!r.ok) return reply.status(r.code).send({ error: r.error });
    if (!isAdmin(req.user!.id)) {
      const own = getDb().prepare(`
        SELECT 1 FROM sessions
        WHERE project_id = ? AND created_by_user_id = ? AND claude_session_id = ?
      `).get(r.id, req.user!.id, body.claude_session_id);
      if (!own) return reply.status(404).send({ error: 'Conversation not found' });
    }
    try {
      const session = await sessionManager.resumeClaudeSession(r.path, r.id, body.claude_session_id, body.title || 'Resumed session', req.user!.id);
      return { ok: true, session };
    } catch (err: any) {
      return reply.status(500).send({ error: `Failed to resume: ${err?.message || 'unknown error'}` });
    }
  });

  // Permanently delete a Claude conversation log (+ any AM record bound to it).
  app.delete<{ Params: { uuid: string }; Querystring: { project_id?: string; project_path?: string } }>('/sessions/claude-history/:uuid', async (req, reply) => {
    const r = resolveProject(req.user!.id, req.query.project_id, req.query.project_path);
    if (!r.ok) return reply.status(r.code).send({ error: r.error });
    if (!isAdmin(req.user!.id)) {
      const own = getDb().prepare(`
        SELECT 1 FROM sessions
        WHERE project_id = ? AND created_by_user_id = ? AND claude_session_id = ?
      `).get(r.id, req.user!.id, req.params.uuid);
      if (!own) return reply.status(404).send({ error: 'Conversation not found' });
    }
    const removed = deleteClaudeSession(r.path, req.params.uuid);
    try {
      if (isAdmin(req.user!.id)) getDb().prepare('DELETE FROM sessions WHERE claude_session_id = ?').run(req.params.uuid);
      else getDb().prepare('DELETE FROM sessions WHERE claude_session_id = ? AND created_by_user_id = ?').run(req.params.uuid, req.user!.id);
    } catch { /* ignore */ }
    if (!removed) return reply.status(404).send({ error: 'Conversation log not found' });
    return { ok: true };
  });

  // Create and start a new session (or plain terminal)
  app.post<{
    Body: {
      project_path: string;
      task: string;
      project_id?: string;
      mode?: 'session' | 'terminal';
      cli_type?: 'claude' | 'codex';
    };
  }>('/sessions', async (req, reply) => {
    const { project_path, task, project_id, mode, cli_type } = req.body as any;
    const cliType = cli_type === 'codex' ? 'codex' : 'claude';
    if (mode !== undefined && mode !== 'session' && mode !== 'terminal') return reply.status(400).send({ error: 'mode must be session or terminal' });
    const requestedMode = mode === 'terminal' ? 'terminal' : 'session';
    const usage = getUserTabUsage(req.user!.id);
    if (!usage.allowed) return reply.status(429).send({ error: `已达到活动标签页上限（${usage.limit}）` });

    if (!project_path) return reply.status(400).send({ error: 'project_path is required' });

    let resolvedProjectId = project_id || null;
    let canonicalProjectPath: string;
    if (resolvedProjectId) {
      const row = getDb().prepare('SELECT id, path FROM projects WHERE id = ?').get(resolvedProjectId) as { id: string; path: string } | undefined;
      if (!row || !userCanUseToolForProject(req.user!.id, resolvedProjectId, requestedMode, requestedMode === 'terminal' ? 'claude' : cliType)) {
        return reply.status(403).send({ error: 'Project not found or not yours' });
      }
      if (project_path !== row.path) {
        return reply.status(400).send({ error: 'project_path does not match project_id' });
      }
      canonicalProjectPath = row.path;
    } else {
      const row = getDb().prepare('SELECT id, path FROM projects WHERE path = ?').get(project_path) as { id: string; path: string } | undefined;
      if (!row || !userCanUseToolForProject(req.user!.id, row.id, requestedMode, requestedMode === 'terminal' ? 'claude' : cliType)) {
        return reply.status(403).send({ error: 'Project not found or not yours' });
      }
      resolvedProjectId = row.id;
      canonicalProjectPath = row.path;
    }

    if (mode === 'terminal') {
      const session = sessionManager.createSession(canonicalProjectPath, 'Terminal', resolvedProjectId, 'claude', req.user!.id, 'terminal');
      registerPendingSpawn(session.id, { projectPath: canonicalProjectPath, task: 'Terminal', mode: 'terminal', projectId: resolvedProjectId });
      return { ok: true, session };
    }

    if (!project_path || !task) {
      return reply.status(400).send({ error: 'project_path and task are required' });
    }

    const session = sessionManager.createSession(canonicalProjectPath, task, resolvedProjectId, cliType, req.user!.id, 'session');
    registerPendingSpawn(session.id, { projectPath: canonicalProjectPath, task, mode: 'session', projectId: resolvedProjectId, cliType });

    return { ok: true, session };
  });

  // Kill a session — never blocks longer than 3s
  app.delete<{
    Params: { id: string };
  }>('/sessions/:id', async (req, reply) => {
    const id = req.params.id;
    const session = sessionManager.getSession(id);
    // Viewing and terminating are separate permissions. Administrators may
    // inspect another user's session for monitoring, but closing a tab must
    // never stop a process owned by that other user.
    if (!session || session.created_by_user_id !== req.user!.id) {
      return reply.status(404).send({ error: 'Session not found' });
    }
    let killTimeout: ReturnType<typeof setTimeout> | null = null;
    try {
      const killed = await Promise.race([
        sessionManager.killSession(id),
        new Promise<boolean>((resolve) => { killTimeout = setTimeout(() => {
          console.log(`[KILL] Session ${id} kill timed out after 3s, forcing DB update`);
          try {
            resolve(sessionManager.markSessionCancelledIfProcessBearing(id));
          } catch {
            resolve(false);
          }
        }, 3000); }),
      ]);
      if (killTimeout) clearTimeout(killTimeout);
      if (!killed) return reply.status(404).send({ error: 'Session not found or not running' });
    } catch (error) {
      if (killTimeout) clearTimeout(killTimeout);
      try {
        if (!sessionManager.markSessionCancelledIfProcessBearing(id)) {
          return reply.status(500).send({ error: 'Failed to stop session' });
        }
      } catch {
        return reply.status(500).send({ error: 'Failed to stop session' });
      }
    }
    return { ok: true };
  });

  // Concise context summary for cross-session awareness (low token cost)
  app.get('/context', async (req) => {
    const running = sessionManager.listSessionsForUser(req.user!.id, 'running').filter((session) => canAccessSessionByRow(req.user!.id, session));
    if (running.length === 0) return { active: false, summary: 'No active AgentManager sessions.' };

    const sessions = running.map(s => {
      const tracker = getTracker(s.id);
      const state = tracker?.state;
      const mins = s.started_at ? Math.round((Date.now() - new Date(s.started_at).getTime()) / 60000) : 0;
      return `${s.id}: "${s.task.slice(0, 80)}" [${state?.processState ?? 'unknown'}] ${mins}m`;
    });

    return { active: true, count: running.length, sessions };
  });

  // Reconnect to a detached tmux session
  app.post<{
    Params: { id: string };
  }>('/sessions/:id/reconnect', async (req, reply) => {
    const session = sessionManager.getSession(req.params.id);
    if (!session || !canAccessSessionByRow(req.user!.id, session)) return reply.status(404).send({ error: 'Session not found' });

    const reconnected = await sessionManager.reconnectSession(req.params.id);
    if (!reconnected) return reply.status(404).send({ error: 'Session not found or not detached' });
    return { ok: true, session };
  });

  // Paginated PTY output (stored in SQLite)
  app.get<{
    Params: { id: string };
    Querystring: { before?: string; limit?: string };
  }>('/sessions/:id/output', async (req, reply) => {
    const session = sessionManager.getSession(req.params.id);
    if (!session || !canAccessSessionByRow(req.user!.id, session)) return reply.status(404).send({ error: 'Session not found' });

    const before = req.query.before ? parseInt(req.query.before, 10) : undefined;
    const limit = Math.min(parseInt(req.query.limit || '500', 10) || 500, 2000);

    return sessionManager.querySessionOutput(req.params.id, { before, limit });
  });

  // Rendered terminal history — replays PTY data through a headless terminal,
  // processing resize markers so the terminal dimensions match the original
  // session at every point. This ensures TUI cursor movements render correctly.
  app.get<{
    Params: { id: string };
    Querystring: { cols?: string; rows?: string };
  }>('/sessions/:id/rendered-output', async (req, reply) => {
    const session = sessionManager.getSession(req.params.id);
    if (!session || !canAccessSessionByRow(req.user!.id, session)) return reply.status(404).send({ error: 'Session not found' });

    // Fallback dimensions if no resize markers exist
    const fallbackCols = Math.min(parseInt(req.query.cols || '120', 10) || 120, 300);
    const fallbackRows = Math.min(parseInt(req.query.rows || '40', 10) || 40, 200);

    // Load PTY chunks (including resize markers). Cap at 50k chunks to
    // prevent the headless terminal from choking on very large sessions.
    const allChunks = sessionManager.querySessionOutput(req.params.id, { limit: 50000 });

    // Replay data gone (an ended session — pty_output was deleted on exit)?
    // Fall back to the final-screen snapshot captured when the session closed,
    // so it can still be restored to how it looked at the end.
    if (allChunks.chunks.length === 0) {
      const snap = sessionManager.getSessionSnapshot(req.params.id);
      return { rendered: snap?.rendered ?? '' };
    }

    // Separate resize markers from data chunks. Find first resize to set
    // initial dimensions, then build ordered segments.
    let initCols = fallbackCols;
    let initRows = fallbackRows;

    // Find the first resize marker to use as initial dimensions
    for (const chunk of allChunks.chunks) {
      if (chunk.data.startsWith(RESIZE_MARKER)) {
        const parts = chunk.data.slice(RESIZE_MARKER.length).split(',');
        initCols = parseInt(parts[0], 10) || fallbackCols;
        initRows = parseInt(parts[1], 10) || fallbackRows;
        break;
      }
    }

    const term = new HeadlessTerminal({
      cols: initCols, rows: initRows, scrollback: 200000, allowProposedApi: true,
    });
    const serializeAddon = new SerializeAddon();
    term.loadAddon(serializeAddon);

    // Process chunks sequentially, resizing when markers are encountered.
    // Write in bounded batches (~512KB) so the headless terminal's internal
    // write queue can drain properly — one giant multi-MB write can stall.
    const MAX_BATCH = 512 * 1024;
    const rendered = await new Promise<string>((resolve) => {
      let idx = 0;

      function processNext() {
        let batchData = '';
        while (idx < allChunks.chunks.length) {
          const chunk = allChunks.chunks[idx];
          if (chunk.data.startsWith(RESIZE_MARKER)) {
            // Flush accumulated data first, then resize
            if (batchData) {
              term.write(batchData);
              batchData = '';
            }
            const parts = chunk.data.slice(RESIZE_MARKER.length).split(',');
            const newCols = parseInt(parts[0], 10);
            const newRows = parseInt(parts[1], 10);
            if (newCols > 0 && newRows > 0) {
              term.resize(newCols, newRows);
            }
            idx++;
            continue;
          }
          batchData += chunk.data;
          idx++;
          // Flush when batch exceeds size limit — use callback to chain next batch
          if (batchData.length >= MAX_BATCH) {
            term.write(batchData, () => processNext());
            return;
          }
        }

        // Flush remaining data then finalize. Always use the callback form
        // to drain the async write queue — previous term.write() calls (at
        // resize boundaries) may still be pending.
        term.write(batchData, () => finalize());
      }

      function finalize() {
        const result = serializeAddon.serialize();
        term.dispose();

        // Collapse runs of blank lines to max 1
        const isBlank = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, '').trim() === '';
        const lines = result.split('\n');
        const collapsed: string[] = [];
        let blankRun = 0;
        for (const line of lines) {
          if (isBlank(line)) {
            blankRun++;
            if (blankRun <= 1) collapsed.push('');
          } else {
            blankRun = 0;
            collapsed.push(line);
          }
        }
        // Strip leading/trailing blanks
        while (collapsed.length > 0 && collapsed[0] === '') collapsed.shift();
        while (collapsed.length > 0 && collapsed[collapsed.length - 1] === '') collapsed.pop();
        resolve(collapsed.join('\n'));
      }

      processNext();
    });

    return { rendered };
  });


};
