import { FastifyPluginAsync } from 'fastify';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Terminal: HeadlessTerminal } = require('@xterm/headless') as { Terminal: any };
const { SerializeAddon } = require('@xterm/addon-serialize') as { SerializeAddon: any };
import { spawn } from 'child_process';
import { platform } from 'os';
import * as sessionManager from '../services/session-manager.js';
import { RESIZE_MARKER, registerPendingSpawn, getSessionTmuxServer } from '../services/session-manager.js';
import { getTracker } from '../services/session-state.js';
import { getDb } from '../db/index.js';
import { userProjectIds, userOwnsProject, userOwnsProjectPath, userOwnsSession } from '../auth.js';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { prunePastesDir } from '../services/paste-cleanup.js';
import { listClaudeSessions, deleteClaudeSession } from '../services/claude-history.js';

export const sessionRoutes: FastifyPluginAsync = async (app) => {
  // List sessions
  app.get<{
    Querystring: { status?: string };
  }>('/sessions', async (req) => {
    const all = sessionManager.listSessions(req.query.status);
    const owned = userProjectIds(req.user!.id);
    const sessions = all
      .filter((s: any) => s.project_id && owned.has(s.project_id))
      // Enrich with live process-state (busy/idle/waiting_for_input) so tab signal
      // lights are correct on first load, before any WS state_change arrives.
      .map((s: any) => {
        const st = getTracker(s.id)?.state;
        return st
          ? { ...s, processState: st.processState, promptType: st.promptType, isPermission: st.isPermission }
          : s;
      });
    return { sessions };
  });

  // Discover external detached sessions available for adoption
  // (must be registered before /sessions/:id to avoid parameterized route match)
  app.get<{
    Querystring: { project_path?: string };
  }>('/sessions/discoverable', async (req) => {
    const sessions = await sessionManager.discoverExternalSessions(req.query.project_path);
    return { sessions };
  });

  // Adopt an external detached session into AgentManager
  app.post<{
    Body: { socket_path: string; project_id?: string };
  }>('/sessions/adopt', async (req, reply) => {
    const { socket_path, project_id } = req.body as any;
    if (!socket_path) {
      return reply.status(400).send({ error: 'socket_path is required' });
    }

    const session = await sessionManager.adoptDtachSession(socket_path, project_id);
    if (!session) {
      return reply.status(404).send({ error: 'Socket not found or not alive' });
    }

    return { ok: true, session };
  });

  // Get single session
  app.get<{
    Params: { id: string };
  }>('/sessions/:id', async (req, reply) => {
    const session = sessionManager.getSession(req.params.id);
    if (!session || !userOwnsSession(req.user!.id, req.params.id)) return reply.status(404).send({ error: 'Session not found' });
    return { session };
  });

  // Save a pasted image into the session's project and return its absolute path.
  // The dashboard injects that path into the terminal so the CLI (Claude) can
  // read the file — the server-side process can't see the browser's clipboard,
  // so we upload + reference by path instead of forwarding the paste.
  app.post<{
    Params: { id: string };
    Body: { dataUrl?: string };
  }>('/sessions/:id/paste-image', { bodyLimit: 15 * 1024 * 1024 }, async (req, reply) => {
    const { id } = req.params;
    if (!userOwnsSession(req.user!.id, id)) return reply.status(404).send({ error: 'Session not found' });

    const session = sessionManager.getSession(id);
    const projectId = (session as any)?.project_id;
    const proj = projectId
      ? (getDb().prepare('SELECT path FROM projects WHERE id = ?').get(projectId) as { path: string } | undefined)
      : undefined;
    if (!proj?.path) return reply.status(400).send({ error: 'Session has no associated project path' });

    const dataUrl = req.body?.dataUrl || '';
    const m = dataUrl.match(/^data:(image\/(?:png|jpeg|jpg|gif|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!m) return reply.status(400).send({ error: 'Expected a base64 image data URL (png/jpeg/gif/webp)' });
    const mime = m[1];
    const ext = mime === 'image/jpeg' || mime === 'image/jpg' ? 'jpg' : mime.split('/')[1];
    const b64 = m[2];
    if (b64.length > 14_000_000) return reply.status(413).send({ error: 'Image too large (max ~10MB)' });

    let buf: Buffer;
    try { buf = Buffer.from(b64, 'base64'); } catch { return reply.status(400).send({ error: 'Invalid base64 data' }); }

    try {
      const dir = join(proj.path, '.agentmanager', 'pastes');
      mkdirSync(dir, { recursive: true });
      // Self-contained ignore so pasted images are never committed — leaves the
      // project's own .gitignore untouched.
      const gi = join(proj.path, '.agentmanager', '.gitignore');
      if (!existsSync(gi)) writeFileSync(gi, '*\n', 'utf-8');
      const filePath = join(dir, `paste-${Date.now()}.${ext}`);
      writeFileSync(filePath, buf);
      prunePastesDir(dir); // bound the directory: drop old / excess pastes
      return { ok: true, path: filePath };
    } catch (err: any) {
      return reply.status(500).send({ error: `Failed to save image: ${err?.message || 'unknown error'}` });
    }
  });

  // Save an arbitrary pasted/dropped file into the session's project and return
  // its absolute path — the paste-image model generalized to any file so the
  // user can drop a document and ask Claude about it. The original filename is
  // preserved (sanitized) for readability; the `paste-` prefix keeps it under
  // the same retention sweep as pasted images.
  app.post<{
    Params: { id: string };
    Body: { dataUrl?: string; filename?: string };
  }>('/sessions/:id/paste-file', { bodyLimit: 50 * 1024 * 1024 }, async (req, reply) => {
    const { id } = req.params;
    if (!userOwnsSession(req.user!.id, id)) return reply.status(404).send({ error: 'Session not found' });

    const session = sessionManager.getSession(id);
    const projectId = (session as any)?.project_id;
    const proj = projectId
      ? (getDb().prepare('SELECT path FROM projects WHERE id = ?').get(projectId) as { path: string } | undefined)
      : undefined;
    if (!proj?.path) return reply.status(400).send({ error: 'Session has no associated project path' });

    const dataUrl = req.body?.dataUrl || '';
    const m = dataUrl.match(/^data:[^;,]*;base64,([A-Za-z0-9+/=]+)$/);
    if (!m) return reply.status(400).send({ error: 'Expected a base64 data URL' });
    const b64 = m[1];
    if (b64.length > 50_000_000) return reply.status(413).send({ error: 'File too large (max ~35MB)' });

    let buf: Buffer;
    try { buf = Buffer.from(b64, 'base64'); } catch { return reply.status(400).send({ error: 'Invalid base64 data' }); }

    // Reduce to a safe basename: strip any path, drop leading dots (no hidden
    // files / traversal), allow only a conservative character set.
    const rawName = (req.body?.filename || '').toString();
    const base = (rawName.split(/[\\/]/).pop() || '').trim();
    const safe = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 100) || 'file';

    try {
      const dir = join(proj.path, '.agentmanager', 'pastes');
      mkdirSync(dir, { recursive: true });
      const gi = join(proj.path, '.agentmanager', '.gitignore');
      if (!existsSync(gi)) writeFileSync(gi, '*\n', 'utf-8');
      const filePath = join(dir, `paste-${Date.now()}-${safe}`);
      writeFileSync(filePath, buf);
      prunePastesDir(dir); // bound the directory: drop old / excess pastes
      return { ok: true, path: filePath };
    } catch (err: any) {
      return reply.status(500).send({ error: `Failed to save file: ${err?.message || 'unknown error'}` });
    }
  });

  // Resume an ended Claude session — re-launch the CLI and /resume the
  // conversation. Reuses the same session id (it comes back to life as running).
  app.post<{ Params: { id: string } }>('/sessions/:id/resume', async (req, reply) => {
    const { id } = req.params;
    if (!userOwnsSession(req.user!.id, id)) return reply.status(404).send({ error: 'Session not found' });
    const result = await sessionManager.resumeSessionById(id);
    if (!result.ok) return reply.status(400).send({ error: result.error });
    return { ok: true, session: sessionManager.getSession(id) };
  });

  // Permanently delete an ended session from history: DB row + events + the
  // Claude JSONL conversation file. Refuses (409) while the session is active.
  app.delete<{ Params: { id: string } }>('/sessions/:id/record', async (req, reply) => {
    const { id } = req.params;
    if (!userOwnsSession(req.user!.id, id)) return reply.status(404).send({ error: 'Session not found' });
    const result = sessionManager.purgeSessionRecord(id);
    if (!result.ok) return reply.status(409).send({ error: result.error });
    return { ok: true };
  });

  /* ---- Claude on-disk conversation history (keyed by project path) ---- */

  // Resolve { projectPath, projectId } from a query/body, enforcing ownership.
  function resolveProject(userId: string, pid?: string, ppath?: string): { ok: true; path: string; id: string | null } | { ok: false; code: number; error: string } {
    if (pid) {
      if (!userOwnsProject(userId, pid)) return { ok: false, code: 404, error: 'Project not found' };
      const p = getDb().prepare('SELECT path FROM projects WHERE id = ?').get(pid) as { path: string } | undefined;
      if (!p?.path) return { ok: false, code: 404, error: 'Project path not found' };
      return { ok: true, path: p.path, id: pid };
    }
    if (ppath) {
      if (!userOwnsProjectPath(userId, ppath)) return { ok: false, code: 404, error: 'Project not found' };
      const p = getDb().prepare('SELECT id FROM projects WHERE path = ? AND owner_id = ?').get(ppath, userId) as { id: string } | undefined;
      return { ok: true, path: ppath, id: p?.id ?? null };
    }
    return { ok: false, code: 400, error: 'project_id or project_path is required' };
  }

  // List a project's Claude conversation logs, with live AgentManager status.
  app.get<{ Querystring: { project_id?: string; project_path?: string } }>('/sessions/claude-history', async (req, reply) => {
    const r = resolveProject(req.user!.id, req.query.project_id, req.query.project_path);
    if (!r.ok) return reply.status(r.code).send({ error: r.error });

    const items = listClaudeSessions(r.path);
    const liveByUuid = new Map<string, { id: string; status: string }>();
    if (items.length && r.id) {
      const uuids = items.map((i) => i.uuid);
      const rows = getDb()
        .prepare(`SELECT id, status, claude_session_id FROM sessions WHERE project_id = ? AND claude_session_id IN (${uuids.map(() => '?').join(',')})`)
        .all(r.id, ...uuids) as { id: string; status: string; claude_session_id: string }[];
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
    const r = resolveProject(req.user!.id, body.project_id, body.project_path);
    if (!r.ok) return reply.status(r.code).send({ error: r.error });
    try {
      const session = await sessionManager.resumeClaudeSession(r.path, r.id, body.claude_session_id, body.title || 'Resumed session');
      return { ok: true, session };
    } catch (err: any) {
      return reply.status(500).send({ error: `Failed to resume: ${err?.message || 'unknown error'}` });
    }
  });

  // Permanently delete a Claude conversation log (+ any AM record bound to it).
  app.delete<{ Params: { uuid: string }; Querystring: { project_id?: string; project_path?: string } }>('/sessions/claude-history/:uuid', async (req, reply) => {
    const r = resolveProject(req.user!.id, req.query.project_id, req.query.project_path);
    if (!r.ok) return reply.status(r.code).send({ error: r.error });
    const removed = deleteClaudeSession(r.path, req.params.uuid);
    try { getDb().prepare('DELETE FROM sessions WHERE claude_session_id = ?').run(req.params.uuid); } catch { /* ignore */ }
    if (!removed) return reply.status(404).send({ error: 'Conversation log not found' });
    return { ok: true };
  });

  // Create and start a new session (or plain terminal)
  app.post<{
    Body: {
      project_path: string;
      task: string;
      project_id?: string;
      mode?: 'session' | 'terminal' | 'agent';
      agent_type?: string;
      cli_type?: 'claude' | 'codex';
    };
  }>('/sessions', async (req, reply) => {
    const { project_path, task, project_id, mode, agent_type, cli_type } = req.body as any;
    const cliType = cli_type === 'codex' ? 'codex' : 'claude';

    // Ownership: a new session must belong to one of the caller's projects.
    if (!userOwnsProject(req.user!.id, project_id) && !userOwnsProjectPath(req.user!.id, project_path)) {
      return reply.status(403).send({ error: 'Project not found or not yours' });
    }

    if (mode === 'terminal') {
      if (!project_path) {
        return reply.status(400).send({ error: 'project_path is required' });
      }
      const session = sessionManager.createSession(project_path, 'Terminal', project_id);
      registerPendingSpawn(session.id, { projectPath: project_path, task: 'Terminal', mode: 'terminal', projectId: project_id });
      return { ok: true, session };
    }

    if (!project_path || !task) {
      return reply.status(400).send({ error: 'project_path and task are required' });
    }

    if (mode === 'agent') {
      if (!agent_type) {
        return reply.status(400).send({ error: 'agent_type is required for agent mode' });
      }
      const session = sessionManager.createSession(project_path, `Agent (${agent_type}): ${task}`, project_id, cliType);
      registerPendingSpawn(session.id, { projectPath: project_path, task, mode: 'agent', agentType: agent_type, projectId: project_id, cliType });
      return { ok: true, session };
    }

    const session = sessionManager.createSession(project_path, task, project_id, cliType);
    registerPendingSpawn(session.id, { projectPath: project_path, task, mode: 'session', projectId: project_id, cliType });

    return { ok: true, session };
  });

  // Kill a session — never blocks longer than 3s
  app.delete<{
    Params: { id: string };
  }>('/sessions/:id', async (req, reply) => {
    const id = req.params.id;
    if (!userOwnsSession(req.user!.id, id)) return reply.status(404).send({ error: 'Session not found' });
    try {
      const killed = await Promise.race([
        sessionManager.killSession(id),
        new Promise<boolean>((resolve) => setTimeout(() => {
          console.log(`[KILL] Session ${id} kill timed out after 3s, forcing DB update`);
          // Force DB update even if kill is stuck
          try {
            getDb().prepare(`
              UPDATE sessions SET status = 'cancelled', completed_at = datetime('now'), updated_at = datetime('now')
              WHERE id = ? AND status IN ('running', 'pending', 'detached')
            `).run(id);
          } catch { /* ignore */ }
          resolve(true);
        }, 3000)),
      ]);
      if (!killed) return reply.status(404).send({ error: 'Session not found or not running' });
    } catch {
      // Kill threw — still mark as cancelled
      try {
        getDb().prepare(`
          UPDATE sessions SET status = 'cancelled', completed_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ? AND status IN ('running', 'pending', 'detached')
        `).run(id);
      } catch { /* ignore */ }
    }
    return { ok: true };
  });

  // Concise context summary for cross-session awareness (low token cost)
  app.get('/context', async () => {
    const running = sessionManager.listSessions('running');
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
    const reconnected = await sessionManager.reconnectSession(req.params.id);
    if (!reconnected) return reply.status(404).send({ error: 'Session not found or not detached' });
    const session = sessionManager.getSession(req.params.id);
    return { ok: true, session };
  });

  // Paginated PTY output (stored in SQLite)
  app.get<{
    Params: { id: string };
    Querystring: { before?: string; limit?: string };
  }>('/sessions/:id/output', async (req, reply) => {
    const session = sessionManager.getSession(req.params.id);
    if (!session) return reply.status(404).send({ error: 'Session not found' });

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
    if (!session) return reply.status(404).send({ error: 'Session not found' });

    // Fallback dimensions if no resize markers exist
    const fallbackCols = Math.min(parseInt(req.query.cols || '120', 10) || 120, 300);
    const fallbackRows = Math.min(parseInt(req.query.rows || '40', 10) || 40, 200);

    // Load PTY chunks (including resize markers). Cap at 50k chunks to
    // prevent the headless terminal from choking on very large sessions.
    const allChunks = sessionManager.querySessionOutput(req.params.id, { limit: 50000 });

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

  // Pop out a session into an external terminal emulator
  app.post<{
    Params: { id: string };
  }>('/sessions/:id/pop-out', async (req, reply) => {
    const session = sessionManager.getSession(req.params.id);
    if (!session) return reply.status(404).send({ error: 'Session not found' });

    const sessionId = req.params.id;
    const socketPath = sessionManager.getSessionSocketPath(sessionId);
    const tmuxSession = sessionManager.getSessionTmuxName(sessionId);

    // Build the attach command — prefer dtach socket, fall back to tmux session
    let attachCmd: string;
    if (socketPath) {
      attachCmd = `dtach -a ${socketPath} -Ez`;
    } else if (tmuxSession) {
      const tmuxServer = getSessionTmuxServer(req.params.id);
      attachCmd = `tmux -L ${tmuxServer} attach-session -t ${tmuxSession}`;
    } else {
      return reply.status(400).send({ error: 'No dtach socket or tmux session found' });
    }

    // Platform-specific terminal emulator lists
    const terminals = platform() === 'darwin'
      ? [
          // macOS: use osascript to open Terminal.app or iTerm2
          { cmd: 'osascript', args: ['-e', `tell application "iTerm2" to create window with default profile command "${attachCmd}"`] },
          { cmd: 'osascript', args: ['-e', `tell application "Terminal" to do script "${attachCmd}"`] },
        ]
      : [
          // Linux: try common terminal emulators
          { cmd: 'tilix', args: ['-e', attachCmd] },
          { cmd: 'gnome-terminal', args: ['--', 'bash', '-c', attachCmd] },
          { cmd: 'konsole', args: ['-e', attachCmd] },
          { cmd: 'xfce4-terminal', args: ['-e', attachCmd] },
          { cmd: 'alacritty', args: ['-e', 'bash', '-c', attachCmd] },
          { cmd: 'xterm', args: ['-e', attachCmd] },
        ];

    // Try each terminal until one launches successfully
    return new Promise((resolve) => {
      let resolved = false;
      let idx = 0;
      function tryNext(): void {
        if (idx >= terminals.length) {
          resolved = true;
          resolve({ ok: false, error: 'No terminal emulator found' });
          return;
        }
        const t = terminals[idx++];
        const child = spawn(t.cmd, t.args, {
          detached: true,
          stdio: 'ignore',
        });
        child.unref();

        let failed = false;
        child.on('error', (err: NodeJS.ErrnoException) => {
          failed = true;
          if (err.code === 'ENOENT') {
            tryNext(); // not installed, try next
          } else if (!resolved) {
            resolved = true;
            resolve({ ok: false, error: err.message });
          }
        });

        // If no error within 300ms, assume it launched — release AgentManager's hold
        setTimeout(() => {
          if (failed || resolved) return;
          resolved = true;
          sessionManager.releaseSession(sessionId);
          resolve({ ok: true, terminal: t.cmd, socketPath: socketPath || tmuxSession });
        }, 300);
      }
      tryNext();
    });
  });
};
