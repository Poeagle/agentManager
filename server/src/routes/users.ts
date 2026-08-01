import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { execFile } from 'child_process';
import { readFileSync } from 'fs';
import { promisify } from 'util';
import { getDb } from '../db/index.js';
import {
  listUsers, createUserAsync, findUserById, findUserByUsername,
  setUserPasswordAsync, destroyUserSessions, verifyPasswordAsync,
  passwordLengthError, createSession as createAuthSession, setSessionCookie,
} from '../auth.js';
import { getTracker, inferQuiescentSessionState } from '../services/session-state.js';
import { getSessionProcessRootPid, killSession, RESIZE_MARKER } from '../services/session-manager.js';
import { broadcastEphemeral } from '../services/event-store.js';
import { cleanOutput } from '../lib/ansi.js';
import { VirtualTerminal } from '../lib/virtual-terminal.js';
import { revokeUserConnections } from '../services/user-connections.js';

const execFileAsync = promisify(execFile);

async function stopActiveUserSessions(userId: string): Promise<number> {
  const sessions = getDb().prepare(`
    SELECT id FROM sessions
    WHERE created_by_user_id = ?
      AND status IN ('pending', 'launching', 'running', 'detached', 'released')
  `).all(userId) as { id: string }[];
  await Promise.allSettled(sessions.map((session) => killSession(session.id)));
  return sessions.length;
}

interface ProcessSample {
  pid: number;
  parentPid: number;
  rssBytes: number;
}

/** One process-table read per monitor refresh, shared by every live session. */
async function readProcessSnapshot(): Promise<Map<number, ProcessSample>> {
  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,rss='], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });
    const snapshot = new Map<number, ProcessSample>();
    for (const line of stdout.split('\n')) {
      const [pidRaw, parentRaw, rssRaw] = line.trim().split(/\s+/);
      const pid = Number(pidRaw);
      const parentPid = Number(parentRaw);
      const rssKiB = Number(rssRaw);
      if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(parentPid) || !Number.isFinite(rssKiB)) continue;
      snapshot.set(pid, { pid, parentPid, rssBytes: Math.max(0, rssKiB) * 1024 });
    }
    return snapshot;
  } catch {
    return new Map();
  }
}

function measureProcessTree(rootPid: number | null, snapshot: Map<number, ProcessSample>) {
  if (!rootPid || !snapshot.has(rootPid)) return { root_pid: rootPid, process_count: 0, memory_bytes: null as number | null };
  const children = new Map<number, number[]>();
  for (const process of snapshot.values()) {
    const siblings = children.get(process.parentPid) ?? [];
    siblings.push(process.pid);
    children.set(process.parentPid, siblings);
  }
  const queue = [rootPid];
  const seen = new Set<number>();
  let memoryBytes = 0;
  while (queue.length > 0 && seen.size < 512) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    memoryBytes += snapshot.get(pid)?.rssBytes ?? 0;
    queue.push(...(children.get(pid) ?? []));
  }
  return { root_pid: rootPid, process_count: seen.size, memory_bytes: memoryBytes };
}

/** systemd-run sessions live in a sibling cgroup, not below the tmux pane PID. */
function measureSandboxCgroup(sessionId: string) {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function') return null;
  const uid = process.getuid();
  const safeId = sessionId.replace(/[^A-Za-z0-9_.-]/g, '-');
  const unit = `agentmanager-sandbox-${safeId}.service`;
  const userRoot = `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service`;
  for (const slice of ['app.slice', 'session.slice', 'background.slice']) {
    const root = `${userRoot}/${slice}/${unit}`;
    try {
      const memoryBytes = Number(readFileSync(`${root}/memory.current`, 'utf8').trim());
      const processCount = Number(readFileSync(`${root}/pids.current`, 'utf8').trim());
      const rootPid = Number(readFileSync(`${root}/cgroup.procs`, 'utf8').trim().split(/\s+/)[0]);
      if (Number.isFinite(memoryBytes) && memoryBytes >= 0) {
        return {
          root_pid: Number.isInteger(rootPid) && rootPid > 0 ? rootPid : null,
          process_count: Number.isFinite(processCount) ? processCount : 0,
          memory_bytes: memoryBytes,
        };
      }
    } catch { /* this session is not running in this systemd slice */ }
  }
  return null;
}

const monitorScreenCache = new Map<string, { seq: number; screen: string }>();

async function renderCurrentScreen(sessionId: string, rows: Array<{ seq: number; data: string }>, initialCols: number): Promise<string> {
  const latestSeq = rows[0]?.seq ?? -1;
  const cached = monitorScreenCache.get(sessionId);
  if (cached?.seq === latestSeq) return cached.screen;
  const terminal = new VirtualTerminal(Math.max(40, initialCols || 120), 60, true);
  try {
    for (const row of rows.slice().reverse()) {
      if (row.data.startsWith(RESIZE_MARKER)) {
        await terminal.flush();
        const [colsRaw, rowsRaw] = row.data.slice(RESIZE_MARKER.length).split(',');
        const cols = Number(colsRaw);
        const screenRows = Number(rowsRaw);
        if (Number.isInteger(cols) && cols >= 40 && Number.isInteger(screenRows) && screenRows >= 10) terminal.resize(cols, screenRows);
      } else {
        terminal.write(row.data);
      }
    }
    await terminal.flush();
    const screen = terminal.getScreen();
    monitorScreenCache.set(sessionId, { seq: latestSeq, screen });
    if (monitorScreenCache.size > 500) monitorScreenCache.delete(monitorScreenCache.keys().next().value!);
    return screen;
  } finally {
    terminal.dispose();
  }
}

function isTerminalUiNoise(line: string): boolean {
  return !line
    || /background terminals? running.*\/(?:ps|stop)/i.test(line)
    || /(?:gpt-[\w.-]+|claude[\w.-]*).*(?:Context|Full Access|No changes|weekly|window)/i.test(line)
    || /(?:Context \d+% used|Full Access|No changes|weekly \d+% left|\d+[KM] window|\d+(?:\.\d+)?M used)/i.test(line)
    || /^[>›] ?\s*Implement \{feature\}\s*$/i.test(line)
    || /^(?:\?|esc)\s+(?:for shortcuts|to interrupt)/i.test(line)
    || /^[─-╿▀-▟\s]+$/.test(line);
}

function meaningfulOutput(screen: string, waitingForInput: boolean): string | null {
  const lines = cleanOutput(screen).split('\n').map((line) => line.trim()).filter((line) => !isTerminalUiNoise(line));
  if (lines.length === 0) return null;
  if (waitingForInput) {
    let promptIndex = -1;
    for (let index = lines.length - 1; index >= 0; index--) {
      if (/\?|do you want|allow|approve|permission|proceed|continue|confirm/i.test(lines[index])) {
        promptIndex = index;
        break;
      }
    }
    const promptLines = promptIndex >= 0 ? lines.slice(promptIndex, promptIndex + 3) : lines.slice(-3);
    return promptLines.join(' · ').slice(0, 320);
  }
  let assistantIndex = -1;
  for (let index = lines.length - 1; index >= 0; index--) {
    if (/^[•●⏺✻]\s*/.test(lines[index])) {
      assistantIndex = index;
      break;
    }
  }
  if (assistantIndex >= 0) {
    const block: string[] = [];
    for (const line of lines.slice(assistantIndex)) {
      if (block.length > 0 && /^[>›]\s*/.test(line)) break;
      block.push(line.replace(/^[•●⏺✻]\s*/, ''));
      if (block.length >= 3) break;
    }
    const text = block.join(' ').trim();
    if (text) return text.slice(0, 320);
  }
  return lines.slice(-2).join(' · ').slice(0, 320) || null;
}

function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.user?.role !== 'admin') {
    reply.code(403).send({ error: 'Admin only' });
    return false;
  }
  return true;
}

interface StoredMonitorTab {
  id?: unknown;
  label?: unknown;
  customLabel?: unknown;
}

interface StoredProjectTabState {
  terminalInstances?: StoredMonitorTab[];
  terminalLabels?: Record<string, unknown>;
  activeTerminalId?: unknown;
  hiddenSessionIds?: unknown[];
  [key: string]: unknown;
}

function readStoredProjectTabState(userId: string, projectId: string): StoredProjectTabState | null {
  const row = getDb().prepare("SELECT value FROM user_ui_state WHERE user_id = ? AND key = ?")
    .get(userId, `project:${projectId}`) as { value: string } | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as StoredProjectTabState;
    return Array.isArray(parsed.terminalInstances) ? parsed : null;
  } catch {
    return null;
  }
}

function writeStoredProjectTabState(userId: string, projectId: string, state: StoredProjectTabState) {
  getDb().prepare(`
    UPDATE user_ui_state SET value = ?, updated_at = datetime('now')
    WHERE user_id = ? AND key = ?
  `).run(JSON.stringify(state), userId, `project:${projectId}`);
}

export const userRoutes: FastifyPluginAsync = async (app) => {
  // Administrator monitoring view: user -> open/active projects -> sessions.
  // Active sessions are never truncated; for ended sessions we keep the most
  // recent 20 per user/project so the page remains useful on long-lived installs.
  app.get('/admin/monitor', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const db = getDb();
    const users = db.prepare(`
      SELECT u.id, u.username, u.display_name, u.role, u.disabled, u.max_tabs,
             MAX(a.last_seen_at) AS last_seen_at,
             CASE WHEN MAX(a.last_seen_at) >= datetime('now', '-2 minutes') THEN 1 ELSE 0 END AS online
      FROM users u
      LEFT JOIN auth_sessions a ON a.user_id = u.id AND a.expires_at > datetime('now')
      GROUP BY u.id
      ORDER BY u.disabled, u.display_name, u.username
    `).all() as Array<{
      id: string;
      username: string;
      display_name: string;
      role: 'admin' | 'member';
      disabled: number;
      max_tabs: number;
      last_seen_at: string | null;
      online: number;
    }>;
    const projects = db.prepare('SELECT id, name, path FROM projects').all() as Array<{
      id: string;
      name: string;
      path: string;
    }>;
    const projectById = new Map(projects.map((project) => [project.id, project]));
    const stateRows = db.prepare("SELECT user_id, key, value, updated_at FROM user_ui_state WHERE key = 'app' OR key LIKE 'project:%'").all() as Array<{
      user_id: string;
      key: string;
      value: string;
      updated_at: string;
    }>;
    type MonitorTab = {
      id: string;
      name: string;
      kind: 'session';
      is_active: boolean;
    };
    const openProjects = new Map<string, Map<string, {
      custom_name: string | null;
      state_updated_at: string;
      is_active: boolean;
    }>>();
    const projectTabs = new Map<string, Map<string, MonitorTab[]>>();
    const sessionTabOwners = new Map<string, Set<string>>();
    for (const row of stateRows) {
      try {
        const parsed = JSON.parse(row.value) as Record<string, unknown>;
        if (row.key === 'app') {
          if (!Array.isArray(parsed.projectTabs)) continue;
          const tabs = new Map<string, {
            custom_name: string | null;
            state_updated_at: string;
            is_active: boolean;
          }>();
          for (const value of parsed.projectTabs) {
            if (!value || typeof value !== 'object') continue;
            const tab = value as { projectId?: unknown; customName?: unknown };
            if (typeof tab.projectId !== 'string' || !projectById.has(tab.projectId)) continue;
            tabs.set(tab.projectId, {
              custom_name: typeof tab.customName === 'string' && tab.customName.trim() ? tab.customName.trim() : null,
              state_updated_at: row.updated_at,
              is_active: parsed.activeTab === `project-${tab.projectId}`,
            });
          }
          openProjects.set(row.user_id, tabs);
          continue;
        }

        const projectId = row.key.slice('project:'.length);
        if (!projectId || !projectById.has(projectId)) continue;
        const labels = parsed.terminalLabels && typeof parsed.terminalLabels === 'object'
          ? parsed.terminalLabels as Record<string, unknown>
          : {};
        const tabs: MonitorTab[] = [];
        const addSessionTabs = (values: unknown, activeId: unknown) => {
          if (!Array.isArray(values)) return;
          for (const value of values) {
            if (!value || typeof value !== 'object') continue;
            const tab = value as { id?: unknown; label?: unknown; customLabel?: unknown };
            if (typeof tab.id !== 'string') continue;
            const customLabel = typeof tab.customLabel === 'string' ? tab.customLabel.trim() : '';
            const syncedLabel = typeof labels[tab.id] === 'string' ? String(labels[tab.id]).trim() : '';
            const defaultLabel = typeof tab.label === 'string' && tab.label.trim() ? tab.label.trim() : '未命名标签';
            tabs.push({
              id: tab.id,
              name: customLabel || syncedLabel || defaultLabel,
              kind: 'session',
              is_active: activeId === tab.id,
            });
            const owners = sessionTabOwners.get(tab.id) ?? new Set<string>();
            owners.add(row.user_id);
            sessionTabOwners.set(tab.id, owners);
          }
        };
        addSessionTabs(parsed.terminalInstances, parsed.activeTerminalId);
        const byProject = projectTabs.get(row.user_id) ?? new Map<string, MonitorTab[]>();
        byProject.set(projectId, tabs);
        projectTabs.set(row.user_id, byProject);
      } catch { /* ignore malformed UI state */ }
    }

    const tabSessionIds = [...sessionTabOwners.keys()];
    const tabSessionPlaceholders = tabSessionIds.length > 0 ? tabSessionIds.map(() => '?').join(', ') : 'NULL';
    const sessionRows = db.prepare(`
      WITH ranked AS (
        SELECT s.*,
               ROW_NUMBER() OVER (
                 PARTITION BY s.created_by_user_id, COALESCE(s.project_id, '')
                 ORDER BY COALESCE(s.started_at, s.created_at) DESC
               ) AS recent_rank
        FROM sessions s
        WHERE s.created_by_user_id IS NOT NULL OR s.id IN (${tabSessionPlaceholders})
      )
      SELECT id, project_id, task, status, mode, agent_type, cli_type, pid, terminal_cols,
             created_by_user_id, started_at, completed_at, created_at, updated_at
      FROM ranked
      WHERE status IN ('pending', 'launching', 'running', 'detached', 'released')
         OR recent_rank <= 20
         OR id IN (${tabSessionPlaceholders})
      ORDER BY COALESCE(started_at, created_at) DESC
    `).all(...tabSessionIds, ...tabSessionIds) as Array<{
      id: string;
      project_id: string | null;
      task: string;
      status: string;
      mode: string | null;
      agent_type: string | null;
      cli_type: string | null;
      pid: number | null;
      terminal_cols: number | null;
      created_by_user_id: string | null;
      started_at: string | null;
      completed_at: string | null;
      created_at: string;
      updated_at: string;
    }>;
    const activeStatuses = new Set(['pending', 'launching', 'running', 'detached', 'released']);
    const rootPids = new Map<string, number | null>();
    await Promise.all(sessionRows.map(async (session) => {
      if (!activeStatuses.has(session.status) || !session.pid) return;
      rootPids.set(session.id, await getSessionProcessRootPid(session.id));
    }));
    const processSnapshot = await readProcessSnapshot();
    const recentOutput = db.prepare('SELECT seq, created_at, data FROM pty_output WHERE session_id = ? ORDER BY seq DESC LIMIT 160');

    const sessions = await Promise.all(sessionRows.map(async (session) => {
      const live = getTracker(session.id)?.state;
      const outputRows = recentOutput.all(session.id) as Array<{ seq: number; created_at: string; data: string }>;
      const outputTail = outputRows.slice().reverse().map((row) => row.data).join('');
      const inferred = !live && activeStatuses.has(session.status) && outputTail
        ? inferQuiescentSessionState(outputTail)
        : null;
      const inferredOwners = session.created_by_user_id ? undefined : sessionTabOwners.get(session.id);
      const inferredUserId = inferredOwners?.size === 1 ? inferredOwners.values().next().value as string : null;
      const resources = activeStatuses.has(session.status)
        ? measureSandboxCgroup(session.id) ?? measureProcessTree(rootPids.get(session.id) ?? session.pid, processSnapshot)
        : { root_pid: null, process_count: 0, memory_bytes: null as number | null };
      const processState = live?.processState ?? inferred?.processState ?? null;
      const screen = outputRows.length > 0 ? await renderCurrentScreen(session.id, outputRows, session.terminal_cols ?? 120) : '';
      return {
        ...session,
        created_by_user_id: session.created_by_user_id ?? inferredUserId,
        ...resources,
        last_activity_at: live?.lastActivity
          ? new Date(live.lastActivity).toISOString()
          : outputRows[0]?.created_at ?? session.updated_at,
        last_output: meaningfulOutput(screen, processState === 'waiting_for_input'),
        process_state: processState,
        prompt_type: live?.promptType ?? inferred?.promptType ?? null,
        choices: live?.choices ?? inferred?.choices ?? null,
        is_permission: live?.isPermission ?? inferred?.isPermission ?? false,
      };
    }));

    const sessionsByUser = new Map<string, typeof sessions>();
    for (const session of sessions) {
      if (!session.created_by_user_id) continue;
      const rows = sessionsByUser.get(session.created_by_user_id) ?? [];
      rows.push(session);
      sessionsByUser.set(session.created_by_user_id, rows);
    }
    const monitorUsers = users.map((user) => {
      const userSessions = sessionsByUser.get(user.id) ?? [];
      const userOpenProjects = openProjects.get(user.id) ?? new Map();
      const userProjectTabs = projectTabs.get(user.id) ?? new Map();
      const grouped = new Map<string, {
        id: string | null;
        name: string;
        path: string | null;
        is_open: boolean;
        is_active: boolean;
        custom_name: string | null;
        state_updated_at: string | null;
        tabs: MonitorTab[];
        sessions: typeof sessions;
      }>();
      for (const [projectId, tab] of userOpenProjects) {
        const project = projectById.get(projectId);
        if (!project) continue;
        grouped.set(projectId, {
          ...project,
          is_open: true,
          is_active: tab.is_active,
          custom_name: tab.custom_name,
          state_updated_at: tab.state_updated_at,
          tabs: userProjectTabs.get(projectId) ?? [],
          sessions: [],
        });
      }
      for (const session of userSessions) {
        const key = session.project_id ?? '__unassigned__';
        let group = grouped.get(key);
        if (!group) {
          const project = session.project_id ? projectById.get(session.project_id) : undefined;
          group = {
            id: project?.id ?? session.project_id,
            name: project?.name ?? '未关联项目',
            path: project?.path ?? null,
            is_open: false,
            is_active: false,
            custom_name: null,
            state_updated_at: null,
            tabs: [],
            sessions: [],
          };
          grouped.set(key, group);
        }
        group.sessions.push(session);
      }
      const monitorProjects = [...grouped.values()].sort((a, b) => {
        if (a.is_open !== b.is_open) return a.is_open ? -1 : 1;
        const aActive = a.sessions.some((session) => activeStatuses.has(session.status));
        const bActive = b.sessions.some((session) => activeStatuses.has(session.status));
        if (aActive !== bActive) return aActive ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return {
        ...user,
        online: Boolean(user.online),
        active_sessions: userSessions.filter((session) => activeStatuses.has(session.status)).length,
        open_projects: monitorProjects.filter((project) => project.is_open).length,
        memory_bytes: userSessions.reduce((total, session) => total + (session.memory_bytes ?? 0), 0),
        projects: monitorProjects,
      };
    });

    return {
      generated_at: new Date().toISOString(),
      active_users: monitorUsers.filter((user) => user.active_sessions > 0).length,
      active_sessions: monitorUsers.reduce((total, user) => total + user.active_sessions, 0),
      total_memory_bytes: monitorUsers.reduce((total, user) => total + user.memory_bytes, 0),
      users: monitorUsers,
    };
  });

  // Rename a user's saved session tab. This changes presentation state only;
  // the underlying session and process are untouched.
  app.patch<{
    Params: { userId: string; projectId: string; sessionId: string };
    Body: { name?: unknown };
  }>('/admin/monitor/users/:userId/projects/:projectId/tabs/:sessionId', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { userId, projectId, sessionId } = req.params;
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > 120) return reply.code(400).send({ error: '标签名称必须为 1–120 个字符' });
    if (!findUserById(userId)) return reply.code(404).send({ error: '用户不存在' });
    const state = readStoredProjectTabState(userId, projectId);
    if (!state) return reply.code(404).send({ error: '项目标签状态不存在' });
    const tab = state.terminalInstances!.find((value) => value?.id === sessionId);
    if (!tab) return reply.code(404).send({ error: '会话标签不存在' });
    tab.customLabel = name;
    state.terminalLabels = state.terminalLabels && typeof state.terminalLabels === 'object' ? state.terminalLabels : {};
    state.terminalLabels[sessionId] = name;
    writeStoredProjectTabState(userId, projectId, state);
    broadcastEphemeral({
      session_id: sessionId,
      project_id: projectId,
      type: 'user.tab_state',
      data: { targetUserId: userId, projectId, sessionId, action: 'rename', name },
    });
    return { ok: true, tab: { id: sessionId, name } };
  });

  // Remove only the saved tab. A live session keeps running and becomes a
  // background session, matching the dashboard's existing "Hide Tab" action.
  app.delete<{
    Params: { userId: string; projectId: string; sessionId: string };
  }>('/admin/monitor/users/:userId/projects/:projectId/tabs/:sessionId', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { userId, projectId, sessionId } = req.params;
    if (!findUserById(userId)) return reply.code(404).send({ error: '用户不存在' });
    const state = readStoredProjectTabState(userId, projectId);
    if (!state) return reply.code(404).send({ error: '项目标签状态不存在' });
    const current = state.terminalInstances!;
    if (!current.some((value) => value?.id === sessionId)) return reply.code(404).send({ error: '会话标签不存在' });
    const remaining = current.filter((value) => value?.id !== sessionId);
    state.terminalInstances = remaining;
    if (state.terminalLabels && typeof state.terminalLabels === 'object') delete state.terminalLabels[sessionId];
    if (state.activeTerminalId === sessionId) state.activeTerminalId = remaining.find((value) => typeof value?.id === 'string')?.id ?? null;
    const hidden = new Set(Array.isArray(state.hiddenSessionIds) ? state.hiddenSessionIds.filter((id): id is string => typeof id === 'string') : []);
    hidden.add(sessionId);
    state.hiddenSessionIds = [...hidden];
    writeStoredProjectTabState(userId, projectId, state);
    const session = getDb().prepare('SELECT status FROM sessions WHERE id = ?').get(sessionId) as { status: string } | undefined;
    const sessionContinues = !!session && ['pending', 'launching', 'running', 'detached', 'released'].includes(session.status);
    broadcastEphemeral({
      session_id: sessionId,
      project_id: projectId,
      type: 'user.tab_state',
      data: { targetUserId: userId, projectId, sessionId, action: 'delete' },
    });
    return { ok: true, session_continues: sessionContinues };
  });

  // List users (admin).
  app.get('/users', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return { users: listUsers() };
  });

  // Create user (admin).
  app.post('/users', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { username, password, display_name, role, max_tabs } = (req.body ?? {}) as Record<string, unknown>;
    if (!username || !password) return reply.code(400).send({ error: 'username and password required' });
    if (typeof username !== 'string' || !username.trim() || username.length > 64) {
      return reply.code(400).send({ error: 'username must be between 1 and 64 characters' });
    }
    const passwordError = passwordLengthError(password);
    if (passwordError) return reply.code(400).send({ error: passwordError });
    if (findUserByUsername(String(username).trim())) return reply.code(409).send({ error: 'Username already exists' });
    const maxTabsValue = max_tabs === undefined ? 10 : Number(max_tabs);
    if (!Number.isInteger(maxTabsValue) || maxTabsValue < 0 || maxTabsValue > 100) {
      return reply.code(400).send({ error: 'max_tabs must be an integer between 0 and 100' });
    }
    try {
      const user = await createUserAsync({
        username: username.trim(),
        password: password as string,
        display_name: display_name ? String(display_name) : undefined,
        role: role === 'admin' ? 'admin' : 'member',
        max_tabs: maxTabsValue,
      });
      return { user };
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed: users\.username/.test(error.message)) {
        return reply.code(409).send({ error: 'Username already exists' });
      }
      throw error;
    }
  });

  // Update a user: role / disabled / reset password (admin).
  app.patch<{ Params: { id: string } }>('/users/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params;
    const target = findUserById(id);
    if (!target) return reply.code(404).send({ error: 'User not found' });
    const { role, disabled, password, max_tabs } = (req.body ?? {}) as Record<string, unknown>;
    const db = getDb();

    if (role !== undefined && role !== 'admin' && role !== 'member') {
      return reply.code(400).send({ error: 'role must be admin or member' });
    }
    if (disabled !== undefined && typeof disabled !== 'boolean') {
      return reply.code(400).send({ error: 'disabled must be a boolean' });
    }
    if (password !== undefined) {
      const passwordError = passwordLengthError(password);
      if (passwordError) return reply.code(400).send({ error: passwordError });
    }
    let maxTabsValue: number | undefined;
    if (max_tabs !== undefined) {
      maxTabsValue = Number(max_tabs);
      if (!Number.isInteger(maxTabsValue) || maxTabsValue < 0 || maxTabsValue > 100) {
        return reply.code(400).send({ error: 'max_tabs must be an integer between 0 and 100' });
      }
    }

    // Don't let the last active admin be demoted/disabled into a lockout.
    const losingAdmin = target.role === 'admin' && (role === 'member' || disabled === true);
    if (losingAdmin) {
      const admins = (db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get() as { n: number }).n;
      if (admins <= 1) return reply.code(400).send({ error: 'Cannot remove the last active admin' });
    }

    if (role === 'admin' || role === 'member') {
      db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
    }
    if (disabled !== undefined) {
      db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, id);
    }
    if (password !== undefined) {
      await setUserPasswordAsync(id, password as string);
    }
    if (maxTabsValue !== undefined) {
      db.prepare('UPDATE users SET max_tabs = ? WHERE id = ?').run(maxTabsValue, id);
    }

    // Credential revocation must also terminate already-upgraded WebSockets and
    // PTYs. Demoting an admin restarts their unsandboxed sessions under member
    // policy the next time they log in.
    if (disabled === true || password !== undefined || (target.role === 'admin' && role === 'member')) {
      destroyUserSessions(id);
      revokeUserConnections(id);
      await stopActiveUserSessions(id);
    }
    return { user: findUserById(id) };
  });

  // Delete an account while preserving completed session records for audit.
  // All active sessions are stopped first so no process survives its owner.
  app.delete<{ Params: { id: string } }>('/users/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params;
    if (id === req.user!.id) return reply.code(400).send({ error: '不能删除当前登录的管理员账户' });
    const target = findUserById(id);
    if (!target) return reply.code(404).send({ error: 'User not found' });
    const db = getDb();
    if (target.role === 'admin') {
      const admins = (db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get() as { n: number }).n;
      if (admins <= 1) return reply.code(400).send({ error: '不能删除最后一个有效管理员' });
    }
    const activeSessions = db.prepare(`
      SELECT id FROM sessions
      WHERE created_by_user_id = ?
        AND status IN ('pending', 'launching', 'running', 'detached', 'released')
    `).all(id) as { id: string }[];

    // Revoke access before the asynchronous process shutdown begins.
    db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(id);
    destroyUserSessions(id);
    revokeUserConnections(id);
    await Promise.all(activeSessions.map(async (session) => {
      try { await killSession(session.id); } catch { /* force DB state below */ }
    }));
    if (activeSessions.length > 0) {
      const placeholders = activeSessions.map(() => '?').join(',');
      db.prepare(`
        UPDATE sessions
        SET status = 'cancelled', completed_at = datetime('now'), updated_at = datetime('now')
        WHERE id IN (${placeholders})
      `).run(...activeSessions.map((session) => session.id));
    }

    const remove = db.transaction(() => {
      db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM user_ui_state WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM project_user_access WHERE user_id = ?').run(id);
      db.prepare('UPDATE project_user_access SET granted_by = NULL WHERE granted_by = ?').run(id);
      db.prepare('UPDATE projects SET owner_id = NULL WHERE owner_id = ?').run(id);
      db.prepare('UPDATE sessions SET created_by_user_id = NULL WHERE created_by_user_id = ?').run(id);
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
    });
    remove();
    return { ok: true, closed_sessions: activeSessions.length };
  });

  // Change your own password (any logged-in user).
  app.post('/auth/change-password', async (req, reply) => {
    const { current_password, new_password } = (req.body ?? {}) as Record<string, unknown>;
    if (!current_password || !new_password) return reply.code(400).send({ error: 'current and new password required' });
    const currentPasswordError = passwordLengthError(current_password);
    if (currentPasswordError) return reply.code(400).send({ error: currentPasswordError });
    const newPasswordError = passwordLengthError(new_password);
    if (newPasswordError) return reply.code(400).send({ error: newPasswordError });
    const row = findUserByUsername(req.user!.username);
    if (!row || !await verifyPasswordAsync(current_password as string, row.password_hash)) {
      return reply.code(403).send({ error: 'Current password is incorrect' });
    }
    await setUserPasswordAsync(req.user!.id, new_password as string);
    // Rotate the current login token and revoke all existing WebSockets. The
    // underlying PTYs remain detached and reconnect under the fresh cookie.
    destroyUserSessions(req.user!.id);
    revokeUserConnections(req.user!.id);
    setSessionCookie(reply, createAuthSession(req.user!.id));
    return { ok: true };
  });
};
