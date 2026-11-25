import { createHash, randomUUID } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { findUserById, userCanUseToolForProject } from '../auth.js';
import { getDb } from '../db/index.js';
import { agentDocsAllowed, verifyAgentDocsToken, withAgentDocsHandoff } from '../services/agent-docs.js';
import { agentDescriptors, agentForSession, getAgent } from '../services/agents/index.js';
import { nativeConversationId } from '../services/session-identity.js';
import { sessionPresenter } from '../services/session-labels.js';
import { automaticConversationContext } from '../shared/conversation-context.js';
import { broadcastEphemeral } from '../services/event-store.js';
import { getTracker } from '../services/session-state.js';
import { consumePendingSpawn, getSession, spawnSession, waitForSessionLifecycle, type Session } from '../services/session-manager.js';
import { platformApi, PlatformApiError } from '../services/platform-ai/tools.js';

const LIMITS = { page_size: 50, targets: 8, pending_submissions: 20, message_bytes: 48 * 1024, operation_retention_seconds: 7 * 24 * 60 * 60 };
const tabId = z.string().regex(/^[\w-]{1,100}$/);
const message = z.string().trim().min(1).refine(text => Buffer.byteLength(text) <= LIMITS.message_bytes);
const create = z.object({
  request_id: tabId,
  name: z.string().trim().min(1).max(120),
  execution: z.object({
    agent_id: tabId,
    environment_id: z.string().min(1).max(160).optional(),
    model_id: z.string().min(1).max(160).optional(),
    reasoning_effort: z.string().max(50).optional(),
    service_tier: z.string().max(50).optional(),
  }).strict(),
  initial_message: message.optional(),
}).strict();
const send = z.object({
  request_id: tabId,
  target_tab_ids: z.array(tabId).min(1).max(LIMITS.targets).refine(items => new Set(items).size === items.length).optional(),
  reply_to: tabId.optional(),
  intent: z.enum(['task', 'progress', 'result', 'note']).optional(),
  text: message,
}).strict().refine(input => !!input.target_tab_ids !== !!input.reply_to);

interface Scope { source: Session; userId: string; projectId: string }
interface Handoff { id: string; target_tab_id: string; source_tab_id: string; source_label: string; request_id: string; reply_to: string | null; status: string; preview: string; intent: string; result_replied: number; created_at: string; cursor: number }
interface Operation { fingerprint: string; state: 'pending' | 'settled'; result: string | null }
type Json = Record<string, unknown>;

function scopeFor(req: FastifyRequest): Scope | undefined {
  const match = /^Bearer ad1\.([\w-]{1,100})\.([\w-]{43})$/.exec(req.headers.authorization || '');
  if (!match) return;
  const source = getSession(match[1]);
  if (!source || !source.created_by_user_id || !source.project_id || !verifyAgentDocsToken(source, match[2])) return;
  return { source, userId: source.created_by_user_id, projectId: source.project_id };
}

function ownedTab(scope: Scope, id: string) {
  const target = getSession(id);
  return target?.created_by_user_id === scope.userId && target.project_id === scope.projectId && agentDocsAllowed(target) ? target : undefined;
}

function operation(scope: Scope, requestId: string): Operation | undefined {
  return getDb().prepare("SELECT fingerprint,state,result FROM agent_docs_operations WHERE tab_id=? AND request_id=? AND created_at>=datetime('now','-7 days')")
    .get(scope.source.id, requestId) as Operation | undefined;
}

function operationView(requestId: string, row: Operation) {
  return { request_id: requestId, state: row.state, result: row.result ? JSON.parse(row.result) : null };
}

function recordResult(scope: Scope, requestId: string, result: Json, settled = false) {
  getDb().prepare('UPDATE agent_docs_operations SET state=?,result=? WHERE tab_id=? AND request_id=?')
    .run(settled ? 'settled' : 'pending', JSON.stringify(result), scope.source.id, requestId);
}

async function mutate(scope: Scope, kind: string, input: { request_id: string }, work: () => Promise<Json>) {
  const db = getDb();
  const requestId = input.request_id;
  const fingerprint = createHash('sha256').update(JSON.stringify([kind, input])).digest('hex');
  db.prepare("DELETE FROM agent_docs_operations WHERE created_at < datetime('now', '-7 days')").run();
  db.prepare("DELETE FROM agent_docs_handoffs WHERE created_at < datetime('now', '-7 days')").run();
  const previous = operation(scope, requestId);
  if (previous) {
    if (previous.fingerprint !== fingerprint) throw Object.assign(Error('同一 request_id 对应了不同请求'), { statusCode: 409 });
    return operationView(requestId, previous);
  }
  db.prepare("INSERT INTO agent_docs_operations(tab_id,request_id,fingerprint,state) VALUES(?,?,?,'pending')")
    .run(scope.source.id, requestId, fingerprint);
  let result: Json;
  try { result = await work(); }
  catch {
    const partial = operation(scope, requestId)?.result;
    result = { ...(partial ? JSON.parse(partial) : {}), status: 'unknown', error: '操作结果待确认' };
  }
  recordResult(scope, requestId, result, true);
  return { request_id: requestId, state: 'settled', result };
}

const deliveryTails = new Map<string, { tail: Promise<unknown>; depth: number }>();

async function deliver(app: Parameters<typeof platformApi>[0], scope: Scope, id: string, text: string, requestId: string, replyTo?: string, intent?: string) {
  const queue = deliveryTails.get(id) || { tail: Promise.resolve(), depth: 0 };
  if (queue.depth >= LIMITS.pending_submissions) return { tab_id: id, status: 'rejected', reason: '目标会话当前有太多待投递消息' };
  queue.depth++;
  const next = queue.tail.catch(() => {}).then(() => deliverOrdered(app, scope, id, text, requestId, replyTo, intent));
  queue.tail = next;
  deliveryTails.set(id, queue);
  try { return await next; }
  finally {
    queue.depth--;
    if (queue.depth === 0) deliveryTails.delete(id);
  }
}

async function deliverOrdered(app: Parameters<typeof platformApi>[0], scope: Scope, id: string, text: string, requestId: string, replyTo?: string, intent?: string) {
  const rejected = (reason: string) => ({ tab_id: id, status: 'rejected', reason });
  const source = ownedTab(scope, scope.source.id);
  const target = ownedTab(scope, id);
  const native = target && nativeConversationId(target);
  const tracker = getTracker(id)?.state;
  if (!source || !agentDocsAllowed(source, 'write')) return rejected('来源标签权限已变化');
  if (!target || target.id === source.id || !native || !['running', 'detached', 'released'].includes(target.status)) return rejected('目标标签不可投递');
  if (tracker?.isPermission || tracker?.promptType === 'choice' || tracker?.promptType === 'confirmation') return rejected('目标正在等待用户交互');
  const messageId = randomUUID(), db = getDb();
  const label = sessionPresenter(scope.userId)(source).tab_name;
  db.prepare(`INSERT INTO agent_docs_handoffs(id,target_tab_id,source_tab_id,source_label,request_id,reply_to,status,content,intent)
    VALUES(?,?,?,?,?,?, 'unknown', ?,?)`).run(messageId, id, source.id, label, requestId, replyTo || null, text, intent || 'note');
  let status = 'unknown';
  let reason;
  try {
    const forwarded = `[Agent Manager handoff · source_tab_id=${source.id} · message_id=${messageId}${replyTo ? ` · reply_to=${replyTo}` : ''}]\n${text}`;
    const response = await withAgentDocsHandoff({ targetId: id, userId: scope.userId, clientId: messageId, label }, () =>
      platformApi(app, scope.userId, 'POST', `/api/sessions/${encodeURIComponent(id)}/input`, {
        input: forwarded, source: 'conversation', client_id: messageId, expected_native_id: native,
        expected_environment_id: target.agent_environment_id || 'native',
      }));
    status = response.status === 'queued' ? 'queued' : 'submitted';
  } catch (error) {
    if (error instanceof PlatformApiError && error.statusCode < 500 && error.submission !== 'unknown') {
      status = 'rejected';
      reason = error.message;
    }
  }
  db.prepare('UPDATE agent_docs_handoffs SET status=? WHERE id=?').run(status, messageId);
  return { tab_id: id, message_id: messageId, status, reason };
}

export const agentDocsRoutes: FastifyPluginAsync = async app => {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS agent_docs_operations (
      tab_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL,
      result TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(tab_id,request_id)
    );
    CREATE INDEX IF NOT EXISTS agent_docs_operation_expiry ON agent_docs_operations(created_at);
    CREATE TABLE IF NOT EXISTS agent_docs_handoffs (
      id TEXT PRIMARY KEY, target_tab_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      source_tab_id TEXT NOT NULL, source_label TEXT NOT NULL, request_id TEXT NOT NULL,
      reply_to TEXT, status TEXT NOT NULL, content TEXT NOT NULL, intent TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS agent_docs_inbox_target ON agent_docs_handoffs(target_tab_id,created_at);
    CREATE INDEX IF NOT EXISTS agent_docs_inbox_expiry ON agent_docs_handoffs(created_at);
    CREATE INDEX IF NOT EXISTS agent_docs_inbox_reply ON agent_docs_handoffs(reply_to);
  `);
  app.register(async scoped => {
    scoped.addHook('onRequest', async (req, reply) => {
      const scope = scopeFor(req);
      if (!scope) return reply.code(401).send({ error: 'Agent 协作凭据无效' });
      if (req.method === 'POST' && !agentDocsAllowed(scope.source, 'write')) return reply.code(403).send({ error: 'Agent 协作写权限不足' });
      reply.header('Cache-Control', 'private, no-store');
      scopes.set(req, scope);
    });
    const scopes = new WeakMap<FastifyRequest, Scope>();
    const readScope = (req: FastifyRequest) => scopes.get(req)!;

    scoped.get('/capabilities', async req => {
      const scope = readScope(req);
      const user = findUserById(scope.userId);
      const operations = ['list-tabs', 'read-tab', 'inbox', 'read-message', 'execution-options', 'operation'];
      if (agentDocsAllowed(scope.source, 'write')) operations.push('create-tab', 'send-message');
      return { version: '1.1.0', source_tab_id: scope.source.id, project_id: scope.projectId,
        user: { id: user?.id, display_name: user?.display_name || user?.username }, operations, limits: LIMITS };
    });

    scoped.get<{ Querystring: { cursor?: string } }>('/tabs', async (req, reply) => {
      const scope = readScope(req);
      const cursor = Number(req.query.cursor || 0);
      if (!Number.isSafeInteger(cursor) || cursor < 0) return reply.code(400).send({ error: '分页游标无效' });
      const rows = getDb().prepare("SELECT id,rowid AS cursor FROM sessions WHERE created_by_user_id=? AND project_id=? AND mode='session' AND rowid>? ORDER BY rowid LIMIT ?")
        .all(scope.userId, scope.projectId, cursor, LIMITS.page_size + 1) as Array<{ id: string; cursor: number }>;
      const present = sessionPresenter(scope.userId);
      const tabs = rows.slice(0, LIMITS.page_size).flatMap(row => {
        const target = ownedTab(scope, row.id);
        if (!target) return [];
        return [{ tab_id: row.id, name: present(target).tab_name, agent_id: agentForSession(target).descriptor.id,
          state: getTracker(row.id)?.state.processState || target.status,
          can_receive: !!nativeConversationId(target) && !!agentForSession(target).input.supportsImmediate && target.id !== scope.source.id && ['running','detached','released'].includes(target.status) }];
      });
      return { tabs, next_cursor: rows.length > LIMITS.page_size ? String(rows[LIMITS.page_size - 1].cursor) : null };
    });

    scoped.get<{ Params: { id: string } }>('/tabs/:id', async (req, reply) => {
      const scope = readScope(req);
      const target = ownedTab(scope, req.params.id);
      if (!target) return reply.code(404).send({ error: '找不到标签页' });
      const page = await platformApi(app, scope.userId, 'GET', `/api/sessions/${encodeURIComponent(target.id)}/conversation?limit=4`);
      const messages = Array.isArray(page.messages) ? page.messages.filter((item: { role: unknown; text: string; presentation?: string }) =>
        (item.role === 'user' || item.role === 'assistant') && typeof item.text === 'string' && !item.presentation && !automaticConversationContext(item.text))
        .map((item: { role: string; text: string }) => ({ role: item.role, text: item.text.slice(0, 2400) })) : [];
      return { tab_id: target.id, state: getTracker(target.id)?.state.processState || target.status, messages };
    });

    scoped.get<{ Querystring: { cursor?: string } }>('/inbox', async (req, reply) => {
      const cursor = Number(req.query.cursor || 0);
      if (!Number.isSafeInteger(cursor) || cursor < 0) return reply.code(400).send({ error: '分页游标无效' });
      const scope = readScope(req);
      const rows = getDb().prepare(`SELECT h.id,h.target_tab_id,h.source_tab_id,h.source_label,h.request_id,h.reply_to,h.status,
        substr(h.content,1,400) AS preview,h.intent,h.created_at,h.rowid AS cursor,
        EXISTS(SELECT 1 FROM agent_docs_handoffs r WHERE r.reply_to=h.id AND r.source_tab_id=h.target_tab_id
          AND r.intent='result' AND r.status IN ('queued','submitted')) AS result_replied
        FROM agent_docs_handoffs h WHERE h.target_tab_id=? AND h.rowid>?
        AND h.status<>'rejected' AND h.created_at>=datetime('now','-7 days') ORDER BY h.rowid LIMIT ?`)
        .all(scope.source.id, cursor, LIMITS.page_size + 1) as Handoff[];
      return { messages: rows.slice(0, LIMITS.page_size).map(({ id, target_tab_id, cursor, result_replied, ...row }) => ({
        message_id: id, ...row, result_replied: !!result_replied,
      })), next_cursor: rows.length > LIMITS.page_size ? String(rows[LIMITS.page_size - 1].cursor) : null };
    });

    scoped.get<{ Params: { id: string } }>('/inbox/:id', async (req, reply) => {
      const scope = readScope(req);
      const row = getDb().prepare(`SELECT id AS message_id,source_tab_id,source_label,reply_to,status,intent,content,created_at
        FROM agent_docs_handoffs WHERE id=? AND target_tab_id=? AND status IN ('queued','submitted')
        AND created_at>=datetime('now','-7 days')`).get(req.params.id, scope.source.id);
      return row ? { message: row } : reply.code(404).send({ error: '找不到已接收的消息' });
    });

    scoped.get<{ Querystring: { agent_id?: string; include_quota?: string } }>('/execution-options', async req => {
      const scope = readScope(req);
      const agents = agentDescriptors().filter(agent => agent.capabilities.launch && agent.id === (req.query.agent_id || agent.id) &&
        userCanUseToolForProject(scope.userId, scope.projectId, 'session', agent.id));
      return { environments: (await Promise.all(agents.map(agent => getAgent(agent.id).launch.collaborationOptions?.(
        scope.userId, scope.projectId, req.query.include_quota === 'true',
      ) ?? []))).flat() };
    });

    scoped.get<{ Params: { id: string } }>('/operations/:id', async (req, reply) => {
      const row = operation(readScope(req), req.params.id);
      return row ? operationView(req.params.id, row) : reply.code(404).send({ error: '找不到操作记录' });
    });

    scoped.post('/messages', async (req, reply) => {
      const parsed = send.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: '无效的消息请求' });
      const input = parsed.data, scope = readScope(req);
      return mutate(scope, 'send', input, async () => {
        // Persist per-target progress so a process restart never replays an uncertain delivery.
        let targets = input.target_tab_ids || [];
        if (input.reply_to) {
          const original = getDb().prepare(`SELECT source_tab_id FROM agent_docs_handoffs WHERE id=? AND target_tab_id=?
            AND status<>'rejected' AND created_at>=datetime('now','-7 days')`).get(input.reply_to, scope.source.id) as { source_tab_id: string } | undefined;
          if (!original) return { results: [], status: 'rejected', reason: '找不到可回传的原消息' };
          targets = [original.source_tab_id];
        }
        const results: Array<{ tab_id: string; status: string; message_id?: string; reason?: string }> = targets.map(id => ({ tab_id: id, status: 'unknown' }));
        recordResult(scope, input.request_id, { results });
        await Promise.allSettled(targets.map(async (id, index) => {
          results[index] = await deliver(app, scope, id, input.text, input.request_id, input.reply_to, input.intent);
          recordResult(scope, input.request_id, { results });
        }));
        return { results };
      });
    });

    scoped.post('/tabs', async (req, reply) => {
      const parsed = create.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: '无效的标签页创建请求' });
      const input = parsed.data, scope = readScope(req);
      return mutate(scope, 'create', input, async () => {
        const rejected = (reason: string) => ({ launch_status: 'rejected', initial_message_status: input.initial_message ? 'rejected' : null, reason });
        const { agent_id, environment_id, model_id, reasoning_effort, service_tier } = input.execution;
        if (!agentDescriptors().some(agent => agent.id === agent_id && agent.capabilities.launch) ||
            !userCanUseToolForProject(scope.userId, scope.projectId, 'session', agent_id)) return rejected('项目未授权此 Agent');
        const launchPreference = model_id || reasoning_effort || service_tier ? { model_id, reasoning_effort, service_tier } : undefined;
        const project = getDb().prepare('SELECT path FROM projects WHERE id=?').get(scope.projectId) as { path: string } | undefined;
        if (!project) return rejected('项目不可用');
        let existing;
        try {
          existing = await platformApi(app, scope.userId, 'POST', '/api/sessions', {
            project_id: scope.projectId, project_path: project.path, mode: 'session', cli_type: agent_id,
            environment_id, launch_preference: launchPreference, tab_name: input.name,
          });
        } catch (error) {
          if (error instanceof PlatformApiError && error.statusCode < 500) return rejected(error.message);
          throw error;
        }
        const id = existing.session.id as string;
        const state = { tab_id: id, launch_status: 'starting', applied_execution: null as Json | null,
          initial_message_status: input.initial_message ? 'unknown' : null };
        recordResult(scope, input.request_id, state);
        const pending = consumePendingSpawn(id);
        if (pending) await spawnSession(id, project.path, '', 120, 40, agent_id);
        else await waitForSessionLifecycle(id);
        const current = getSession(id);
        if (!current || current.status !== 'running') return state;
        state.launch_status = 'ready';
        broadcastEphemeral({ type: 'session.started', session_id: id, project_id: scope.projectId });
        const runtime = await platformApi(app, scope.userId, 'GET', `/api/sessions/${encodeURIComponent(id)}/controls`).catch(() => null);
        state.applied_execution = { agent_id, environment_id: current.agent_environment_id, model_id: runtime?.model ?? null,
          reasoning_effort: runtime?.effort ?? null, service_tier: runtime?.service_tier ?? null };
        if (launchPreference && (!runtime || runtime.model !== model_id ||
            reasoning_effort && runtime.effort !== reasoning_effort ||
            service_tier && (runtime.service_tier || 'default') !== service_tier)) {
          return { ...state, initial_message_status: input.initial_message ? 'rejected' : null, reason: '启动配置尚未确认' };
        }
        if (input.initial_message) {
          const result = await deliver(app, scope, id, input.initial_message, input.request_id, undefined, 'task');
          state.initial_message_status = result.status;
          return { ...state, initial_message_id: 'message_id' in result ? result.message_id : undefined, initial_message_reason: 'reason' in result ? result.reason : undefined };
        }
        return state;
      });
    });
  }, { prefix: '/agent-docs' });
};
