import type { FastifyPluginAsync } from 'fastify';
import { insertEvent, getEvents } from '../services/event-store.js';
import { getDb } from '../db/index.js';
import {
  eventHookSecretMatches,
  isAdmin,
  userProjectIds,
  userCanUseSessionTool,
  userOwnsSession,
} from '../auth.js';
import { config } from '../config.js';

const HOOK_SECRET_HEADER = 'x-agentmanager-hook-secret';
const MAX_EVENT_DATA_BYTES = 64 * 1024;
const ALLOWED_HOOK_EVENT_TYPES = new Set(['tool_use', 'tool_result', 'edit', 'command', 'task', 'error']);

interface HookEventBody {
  type?: unknown;
  session_id?: unknown;
  project_path?: unknown;
  tool_name?: unknown;
  data?: unknown;
}

interface RateWindow {
  startedAt: number;
  count: number;
}

const eventRateWindows = new Map<string, RateWindow>();

function isLoopbackAddress(address: string): boolean {
  return address === '127.0.0.1'
    || address === '::1'
    || address === 'localhost'
    || /^::ffff:127\./i.test(address);
}

function consumeEventRateLimit(address: string, now = Date.now()): boolean {
  const windowMs = 60_000;
  const current = eventRateWindows.get(address);
  const window = !current || now - current.startedAt >= windowMs
    ? { startedAt: now, count: 0 }
    : current;
  window.count += 1;
  eventRateWindows.set(address, window);
  if (eventRateWindows.size > 10_000) {
    for (const [key, entry] of eventRateWindows) {
      if (now - entry.startedAt >= windowMs) eventRateWindows.delete(key);
    }
  }
  return window.count <= config.eventRateLimitPerMinute;
}

function normalizeMode(mode: string | null | undefined): 'session' | 'terminal' | 'agent' {
  if (mode === 'terminal' || mode === 'agent') return mode;
  return 'session';
}

function normalizeCliType(cliType: string | null | undefined): 'claude' | 'codex' {
  return cliType === 'codex' ? 'codex' : 'claude';
}

/**
 * Check if a session_id exists in the sessions table.
 * External hooks (Claude Code) send their own session IDs that don't match
 * AgentManager sessions, so we null them out to avoid FK constraint failures.
 */
function resolveSession(sessionId?: string): { id: string; project_id: string | null } | undefined {
  if (!sessionId) return undefined;
  const db = getDb();
  return db.prepare('SELECT id, project_id FROM sessions WHERE id = ?').get(sessionId) as
    | { id: string; project_id: string | null }
    | undefined;
}

/**
 * Resolve a project path to a project_id.
 */
function resolveProject(projectPath?: string): { id: string; path: string } | undefined {
  if (!projectPath) return undefined;
  const db = getDb();
  return db.prepare('SELECT id, path FROM projects WHERE path = ?').get(projectPath) as
    | { id: string; path: string }
    | undefined;
}

function resolveProjectId(projectPath?: string): string | undefined {
  return resolveProject(projectPath)?.id;
}

function enforceEventRetention(): void {
  const db = getDb();
  db.prepare("DELETE FROM events WHERE timestamp < datetime('now', ?)")
    .run(`-${config.eventRetentionDays} days`);
  const cutoff = db.prepare('SELECT id FROM events ORDER BY id DESC LIMIT 1 OFFSET ?')
    .get(config.eventRetentionMax) as { id: number } | undefined;
  if (cutoff) db.prepare('DELETE FROM events WHERE id <= ?').run(cutoff.id);
}

/**
 * Event routes — REST endpoints for Claude Code hooks
 * These need to be simple POST endpoints that hooks can curl to
 */
export const eventRoutes: FastifyPluginAsync = async (app) => {
  // Receive events from Claude Code hooks
  app.post<{ Body: HookEventBody }>('/events', { bodyLimit: 128 * 1024 }, async (req, reply) => {
    const body = req.body || {};
    const projectPath = typeof body.project_path === 'string' ? body.project_path : '';
    if (!projectPath || projectPath.length > 4096) {
      return reply.status(400).send({ error: 'A valid project_path is required' });
    }
    const project = resolveProject(projectPath);
    if (!project) return reply.status(404).send({ error: 'Project not found' });

    const rawSecret = req.headers[HOOK_SECRET_HEADER];
    const candidate = Array.isArray(rawSecret) ? rawSecret[0] : rawSecret;
    if (candidate) {
      if (!eventHookSecretMatches(project.path, candidate)) {
        return reply.status(401).send({ error: 'Invalid event hook credentials' });
      }
    } else if (!(config.allowLegacyLocalHooks && isLoopbackAddress(req.ip))) {
      return reply.status(401).send({ error: 'Event hook credentials required' });
    }

    if (!consumeEventRateLimit(req.ip)) {
      return reply.header('Retry-After', '60').status(429).send({ error: 'Event hook rate limit exceeded' });
    }

    const type = typeof body.type === 'string' ? body.type : '';
    if (!ALLOWED_HOOK_EVENT_TYPES.has(type)) {
      return reply.status(400).send({ error: 'Unsupported event type' });
    }
    const sessionId = body.session_id === undefined ? undefined : body.session_id;
    const toolName = body.tool_name === undefined ? undefined : body.tool_name;
    if (sessionId !== undefined && (typeof sessionId !== 'string' || sessionId.length > 128)) {
      return reply.status(400).send({ error: 'Invalid session_id' });
    }
    if (toolName !== undefined && (typeof toolName !== 'string' || toolName.length > 128)) {
      return reply.status(400).send({ error: 'Invalid tool_name' });
    }
    if (body.data !== undefined && (body.data === null || typeof body.data !== 'object' || Array.isArray(body.data))) {
      return reply.status(400).send({ error: 'data must be an object' });
    }
    const data = body.data as Record<string, unknown> | undefined;
    if (data && Buffer.byteLength(JSON.stringify(data), 'utf8') > MAX_EVENT_DATA_BYTES) {
      return reply.status(413).send({ error: 'Event data is too large' });
    }

    // Store the original session_id in data for reference, use resolved one for FK
    const resolvedSession = resolveSession(sessionId);
    if (resolvedSession?.project_id && resolvedSession.project_id !== project.id) {
      return reply.status(400).send({ error: 'session_id does not belong to project_path' });
    }
    const eventData = sessionId && !resolvedSession
      ? { ...data, claude_session_id: sessionId }
      : data;

    const event = insertEvent({
      type,
      session_id: resolvedSession?.id,
      project_id: project.id,
      tool_name: toolName as string | undefined,
      data: eventData,
    });
    try { enforceEventRetention(); } catch (error) { req.log.warn({ err: error }, 'Failed to enforce event retention'); }
    return { ok: true, event_id: event.id };
  });

  // Get recent events
  app.get<{
    Querystring: {
      session_id?: string;
      project_id?: string;
      project_path?: string;
      type?: string;
      limit?: string;
      since?: string;
    };
  }>('/events', async (req) => {
    const { session_id, project_id, project_path, type, limit, since } = req.query;

    // Allow querying by project_path (resolves to project_id)
    const resolvedProjectId = project_id || resolveProjectId(project_path);

    // Ownership: reject explicit queries for projects/sessions the user doesn't own.
    const owned = userProjectIds(req.user!.id);
    if (resolvedProjectId && !owned.has(resolvedProjectId)) return { events: [] };
    if (session_id) {
      const row = getDb().prepare('SELECT mode, cli_type FROM sessions WHERE id = ?').get(session_id) as
        | { mode: string | null; cli_type: string | null }
        | undefined;
      if (!row || !userCanUseSessionTool(req.user!.id, session_id, normalizeCliType(row.cli_type), normalizeMode(row.mode))) {
        return { events: [] };
      }
    }

    const events = getEvents({
      session_id,
      project_id: resolvedProjectId,
      type,
      limit: Math.max(1, Math.min(limit ? parseInt(limit, 10) || 100 : 100, 500)),
      since,
    });
    // Project membership is not session ownership: members only receive events
    // attached to sessions they created. Admins retain the project-wide view.
    const result = isAdmin(req.user!.id)
      ? events
      : events.filter((e: any) => e.session_id && userOwnsSession(req.user!.id, e.session_id));
    return { events: result };
  });
};
