import { createHash, randomUUID } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { findUserById, userCanUseToolForProject } from '../auth.js';
import { getDb } from '../db/index.js';
import { agentDocsAllowed, agentDocsTabAccessible, verifyAgentDocsToken, withAgentDocsCreation, withAgentDocsHandoff } from '../services/agent-docs.js';
import { agentDocsBatchLimits, agentDocsBatchScheduler, agentDocsBatchSnapshot, getAgentDocsBatch,
  initAgentDocsBatches, openAgentDocsBatch, reserveAgentDocsBatch, sealAgentDocsBatch, type AgentDocsBatch } from '../services/agent-docs-batches.js';
import { agentForSession, getAgent } from '../services/agents/index.js';
import { nativeConversationId } from '../services/session-identity.js';
import { sessionPresenter } from '../services/session-labels.js';
import { automaticConversationContext } from '../shared/conversation-context.js';
import { broadcastEphemeral } from '../services/event-store.js';
import { getTracker } from '../services/session-state.js';
import { canQueueSessionRecordDeletion, consumePendingSpawn, getSession, killSession, spawnSession, waitForSessionLifecycle, waitForStoppedSessionLifecycle, type Session } from '../services/session-manager.js';
import { platformApi, PlatformApiError } from '../services/platform-ai/tools.js';
import { removeSessionTabs } from '../services/session-tabs.js';
import { sessionRecordDeletionState } from '../services/session-record-deletion.js';

const LIMITS = { page_size: 50, targets: 8, pending_submissions: 20, message_bytes: 48 * 1024,
  operation_retention_seconds: 7 * 24 * 60 * 60, ...agentDocsBatchLimits };
const tabId = z.string().regex(/^[\w-]{1,100}$/);
const message = z.string().trim().min(1).refine(text => Buffer.byteLength(text) <= LIMITS.message_bytes);
const create = z.object({
  request_id: tabId,
  name: z.string().trim().min(1).max(120),
  execution: z.object({
    agent_id: tabId.optional(),
    environment_id: z.string().min(1).max(160).optional(),
    model_id: z.string().min(1).max(160).optional(),
    reasoning_effort: z.string().max(50).optional(),
    service_tier: z.string().max(50).optional(),
  }).strict().optional(),
  initial_message: message.optional(),
  batch_id: tabId.optional(),
}).strict().refine(input => !input.batch_id || !!input.initial_message);
const deleteTab = z.object({
  request_id: tabId,
  delete_history: z.boolean().default(false),
}).strict();
const send = z.object({
  request_id: tabId,
  target_tab_ids: z.array(tabId).min(1).max(LIMITS.targets).refine(items => new Set(items).size === items.length).optional(),
  reply_to: tabId.optional(),
  intent: z.enum(['task', 'progress', 'result', 'note', 'blocker']).optional(),
  batch_id: tabId.optional(),
  text: message,
}).strict().refine(input => !!input.target_tab_ids !== !!input.reply_to &&
  (!input.batch_id || (!!input.target_tab_ids && input.intent === 'task')) &&
  (input.intent !== 'blocker' || !!input.reply_to));
const openBatch = z.object({
  request_id: tabId,
  timeout_seconds: z.number().int().min(1).max(LIMITS.batch_timeout_max).default(LIMITS.batch_timeout_default),
}).strict();
const sealBatch = z.object({ request_id: tabId }).strict();

interface Scope { source: Session; userId: string; projectId: string }
interface Handoff { id: string; target_tab_id: string; source_tab_id: string; source_label: string; request_id: string; reply_to: string | null; batch_id: string | null; status: string; preview: string; intent: string; result_replied: number; created_at: string; cursor: number }
interface Operation { fingerprint: string; state: 'pending' | 'settled'; result: string | null }
type Json = Record<string, unknown>;

function scopeFor(req: FastifyRequest): Scope | undefined {
  const match = /^Bearer ad1\.([\w-]{1,100})\.([\w-]{43})$/.exec(req.headers.authorization || '');
  if (!match) return;
  const source = getSession(match[1]);
  if (!source || !source.created_by_user_id || !source.project_id || !verifyAgentDocsToken(source, match[2])) return;
  return { source, userId: source.created_by_user_id, projectId: source.project_id };
}

function sourceExecution(session: Session) {
  const adapter = agentForSession(session);
  return {
    agent_id: adapter.descriptor.id,
    environment_id: adapter.launch.collaborationEnvironmentId?.(session) ?? session.agent_environment_id ?? null,
  };
}

function ownedTab(scope: Scope, id: string, includeEnded = false) {
  const target = getSession(id);
  const accessible = includeEnded ? agentDocsTabAccessible : agentDocsAllowed;
  return target?.created_by_user_id === scope.userId && target.project_id === scope.projectId && accessible(target) ? target : undefined;
}

function operation(scope: Scope, requestId: string): Operation | undefined {
  return getDb().prepare("SELECT fingerprint,state,result FROM agent_docs_operations WHERE tab_id=? AND request_id=? AND created_at>=datetime('now','-7 days')")
    .get(scope.source.id, requestId) as Operation | undefined;
}

function operationView(requestId: string, row: Operation) {
  const result = row.result ? JSON.parse(row.result) : null;
  if (result?.history_status === 'pending') {
    const state = sessionRecordDeletionState(result.tab_id);
    result.history_status = state ?? (getSession(result.tab_id) ? 'unknown' : 'deleted');
  }
  return { request_id: requestId, state: row.state, result };
}

function recordResult(scope: Scope, requestId: string, result: Json, settled = false) {
  getDb().prepare('UPDATE agent_docs_operations SET state=?,result=? WHERE tab_id=? AND request_id=?')
    .run(settled ? 'settled' : 'pending', JSON.stringify(result), scope.source.id, requestId);
}

async function mutate(scope: Scope, kind: string, input: { request_id: string }, work: () => Promise<Json>,
  dispatch?: { batchId: string; size: number }) {
  const db = getDb();
  const requestId = input.request_id;
  const fingerprint = createHash('sha256').update(JSON.stringify([kind, input])).digest('hex');
  db.prepare("DELETE FROM agent_docs_operations WHERE created_at < datetime('now', '-7 days')").run();
  db.prepare("DELETE FROM agent_docs_handoffs WHERE created_at < datetime('now', '-7 days')").run();
  db.prepare("DELETE FROM agent_docs_batches WHERE wake_status<>'waiting' AND deadline < ?").run(Date.now() - LIMITS.operation_retention_seconds * 1000);
  const previous = operation(scope, requestId);
  if (previous) {
    if (previous.fingerprint !== fingerprint) throw Object.assign(Error('同一 request_id 对应了不同请求'), { statusCode: 409 });
    return operationView(requestId, previous);
  }
  db.transaction(() => {
    if (dispatch && !reserveAgentDocsBatch(dispatch.batchId, scope.source.id, dispatch.size))
      throw Object.assign(Error('批次不可登记任务：不存在、已封批、已到期或任务数已达上限'), { statusCode: 409 });
    db.prepare("INSERT INTO agent_docs_operations(tab_id,request_id,fingerprint,state,batch_id,batch_size) VALUES(?,?,?,'pending',?,?)")
      .run(scope.source.id, requestId, fingerprint, dispatch?.batchId ?? null, dispatch?.size ?? null);
  })();
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

async function deliver(app: Parameters<typeof platformApi>[0], scope: Scope, id: string, text: string, requestId: string, replyTo?: string, intent?: string, batchId?: string) {
  const queue = deliveryTails.get(id) || { tail: Promise.resolve(), depth: 0 };
  if (queue.depth >= LIMITS.pending_submissions) return { tab_id: id, status: 'rejected', reason: '目标会话当前有太多待投递消息' };
  queue.depth++;
  const next = queue.tail.catch(() => {}).then(() => deliverOrdered(app, scope, id, text, requestId, replyTo, intent, batchId));
  queue.tail = next;
  deliveryTails.set(id, queue);
  try { return await next; }
  finally {
    queue.depth--;
    if (queue.depth === 0) deliveryTails.delete(id);
  }
}

function deliveryBlocked(target: Session | undefined, id: string) {
  const tracker = getTracker(id)?.state;
  if (!target || !nativeConversationId(target) || !['running', 'detached', 'released'].includes(target.status)) return '目标标签不可投递';
  if (tracker?.isPermission || tracker?.promptType === 'choice' || tracker?.promptType === 'confirmation') return '目标正在等待用户交互';
}

function handoffText(sourceId: string, messageId: string, text: string, replyTo?: string) {
  return `[Agent Manager handoff · source_tab_id=${sourceId} · message_id=${messageId}${replyTo ? ` · reply_to=${replyTo}` : ''}]\n${text}`;
}

async function submitHandoff(app: Parameters<typeof platformApi>[0], input: {
  targetId: string; userId: string; clientId: string; label: string; text: string; native: string; environment: string;
}) {
  try {
    const response = await withAgentDocsHandoff(input, () =>
      platformApi(app, input.userId, 'POST', `/api/sessions/${encodeURIComponent(input.targetId)}/input`, {
        input: input.text, source: 'conversation', client_id: input.clientId, expected_native_id: input.native,
        expected_environment_id: input.environment,
      }));
    return { status: response.status === 'queued' ? 'queued' : 'submitted' };
  } catch (error) {
    if (error instanceof PlatformApiError && error.statusCode < 500 && error.submission !== 'unknown')
      return { status: 'rejected', reason: error.message };
    return { status: 'unknown' };
  }
}

async function deliverOrdered(app: Parameters<typeof platformApi>[0], scope: Scope, id: string, text: string, requestId: string, replyTo?: string, intent?: string, batchId?: string) {
  const rejected = (reason: string) => ({ tab_id: id, status: 'rejected', reason });
  const source = ownedTab(scope, scope.source.id);
  const target = ownedTab(scope, id);
  if (!source || !agentDocsAllowed(source, 'write')) return rejected('来源标签权限已变化');
  const blocked = id === source.id ? '目标标签不可投递' : deliveryBlocked(target, id);
  if (blocked || !target) return rejected(blocked || '目标标签不可投递');
  const messageId = randomUUID(), db = getDb();
  const label = sessionPresenter(scope.userId)(source).tab_name;
  db.prepare(`INSERT INTO agent_docs_handoffs(id,target_tab_id,source_tab_id,source_label,request_id,reply_to,status,content,intent,batch_id)
    VALUES(?,?,?,?,?,?, 'unknown', ?,?,?)`).run(messageId, id, source.id, label, requestId, replyTo || null, text, intent || 'note', batchId ?? null);
  const receipt = await submitHandoff(app, { targetId: id, userId: scope.userId, clientId: messageId, label,
    text: handoffText(source.id, messageId, text, replyTo), native: nativeConversationId(target)!,
    environment: target.agent_environment_id || 'native' });
  db.prepare('UPDATE agent_docs_handoffs SET status=? WHERE id=?').run(receipt.status, messageId);
  return { tab_id: id, message_id: messageId, ...receipt };
}

async function deliverBatchReply(app: Parameters<typeof platformApi>[0], scope: Scope, batch: AgentDocsBatch,
  replyTo: string, input: z.infer<typeof send>) {
  const source = ownedTab(scope, scope.source.id);
  const target = ownedTab(scope, batch.tab_id, true);
  if (!source || !agentDocsAllowed(source, 'write') || !target)
    return { tab_id: batch.tab_id, status: 'rejected', reason: '来源或目标标签权限已变化' };
  const messageId = randomUUID(), label = sessionPresenter(scope.userId)(source).tab_name;
  getDb().prepare(`INSERT INTO agent_docs_handoffs(id,target_tab_id,source_tab_id,source_label,request_id,reply_to,status,content,intent,batch_id)
    VALUES(?,?,?,?,?,?,'stored',?,?,?)`).run(messageId, batch.tab_id, source.id, label, input.request_id,
    replyTo, input.text, input.intent || 'note', batch.id);
  const stored = { tab_id: batch.tab_id, message_id: messageId, status: 'stored', batch_id: batch.id };
  if (input.intent !== 'blocker') return stored;

  const receipt = await wakeBatchParent(app, batch, messageId, label, handoffText(source.id, messageId,
    `本批有需立即协调的阻塞。\n${input.text}`, replyTo));
  return { ...stored, wake_status: receipt.status, wake_error: receipt.reason };
}

async function wakeBatchParent(app: Parameters<typeof platformApi>[0], batch: AgentDocsBatch, clientId: string, label: string, text: string) {
  const target = getSession(batch.tab_id);
  if (!target?.created_by_user_id || !agentDocsAllowed(target, 'write'))
    return { status: 'rejected', reason: '父标签已关闭或权限已变化' };
  const blocked = deliveryBlocked(target, target.id);
  if (blocked) return { status: 'rejected', reason: blocked };
  return submitHandoff(app, { targetId: target.id, userId: target.created_by_user_id, clientId, label, text,
    native: batch.native_id, environment: batch.environment_id });
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
  initAgentDocsBatches();
  const batches = agentDocsBatchScheduler(
    (batch, text) => wakeBatchParent(app, batch, batch.id, '协作结果', text),
    error => app.log.warn({ err: error }, 'Agent Docs batch wake could not be confirmed'),
  );
  app.addHook('onReady', async () => batches.start());
  app.addHook('onClose', async () => batches.close());
  // Recover relationships for earlier creations whose receipts still identify both tabs.
  getDb().exec(`
    WITH creation AS MATERIALIZED (
      SELECT tab_id AS parent_id, json_extract(result, '$.tab_id') AS child_id
      FROM agent_docs_operations
      WHERE CASE WHEN json_valid(result) THEN json_type(result, '$.launch_status') = 'text' ELSE 0 END
        AND created_at >= datetime('now', '-7 days')
    )
    UPDATE sessions AS child SET parent_session_id = parent.id
    FROM creation JOIN sessions AS parent ON parent.id = creation.parent_id
    WHERE child.id = creation.child_id AND child.id <> parent.id AND child.parent_session_id IS NULL
      AND child.project_id = parent.project_id AND child.created_by_user_id = parent.created_by_user_id
      AND child.mode = 'session' AND parent.mode = 'session'
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
      const operations = ['list-tabs', 'read-tab', 'inbox', 'read-message', 'execution-options', 'operation', 'read-batch'];
      if (agentDocsAllowed(scope.source, 'write')) operations.push('create-tab', 'send-message', 'delete-tab', 'open-batch', 'seal-batch');
      return { version: '1.4.0', source_tab_id: scope.source.id, project_id: scope.projectId,
        user: { id: user?.id, display_name: user?.display_name || user?.username }, operations, limits: LIMITS };
    });

    scoped.post('/batches', async (req, reply) => {
      const parsed = openBatch.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: '无效的协作批次请求' });
      const input = parsed.data, scope = readScope(req);
      const result = await mutate(scope, 'open-batch', input, async () => {
        const native = nativeConversationId(scope.source);
        if (!native || !agentForSession(scope.source).input.supportsImmediate)
          return { status: 'rejected', reason: '当前标签不支持协作唤醒' };
        return openAgentDocsBatch(scope.source.id, native, scope.source.agent_environment_id || 'native', input.timeout_seconds)
          ?? { status: 'rejected', reason: '当前标签的协作批次已达上限' };
      });
      batches.schedule();
      return result;
    });

    scoped.get<{ Params: { id: string } }>('/batches/:id', async (req, reply) => {
      const batch = getAgentDocsBatch(req.params.id, readScope(req).source.id);
      return batch ? agentDocsBatchSnapshot(batch) : reply.code(404).send({ error: '找不到协作批次' });
    });

    scoped.post<{ Params: { id: string } }>('/batches/:id/seal', async (req, reply) => {
      const parsed = sealBatch.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: '无效的封批请求' });
      const scope = readScope(req), id = req.params.id;
      if (!getAgentDocsBatch(id, scope.source.id)) return reply.code(404).send({ error: '找不到协作批次' });
      const input = { ...parsed.data, batch_id: id };
      const result = await mutate(scope, 'seal-batch', input, async () => {
        sealAgentDocsBatch(id, scope.source.id);
        return { batch_id: id, sealed: !!getAgentDocsBatch(id, scope.source.id)?.sealed };
      });
      await batches.check(id, scope.source.id);
      return result;
    });

    scoped.get<{ Querystring: { cursor?: string; include_ended?: string } }>('/tabs', async (req, reply) => {
      const scope = readScope(req);
      const cursor = Number(req.query.cursor || 0);
      if (!Number.isSafeInteger(cursor) || cursor < 0) return reply.code(400).send({ error: '分页游标无效' });
      const rows = getDb().prepare("SELECT id,rowid AS cursor FROM sessions WHERE created_by_user_id=? AND project_id=? AND mode='session' AND rowid>? ORDER BY rowid LIMIT ?")
        .all(scope.userId, scope.projectId, cursor, LIMITS.page_size + 1) as Array<{ id: string; cursor: number }>;
      const present = sessionPresenter(scope.userId);
      const includeEnded = req.query.include_ended === 'true';
      const mayDelete = agentDocsAllowed(scope.source, 'write');
      const tabs = rows.slice(0, LIMITS.page_size).flatMap(row => {
        const target = ownedTab(scope, row.id, includeEnded);
        if (!target) return [];
        return [{ tab_id: row.id, parent_tab_id: target.parent_session_id ?? null, name: present(target).tab_name, agent_id: agentForSession(target).descriptor.id,
          state: getTracker(row.id)?.state.processState || target.status,
          can_delete: mayDelete && target.id !== scope.source.id && agentDocsTabAccessible(target, 'write'),
          can_receive: !!nativeConversationId(target) && !!agentForSession(target).input.supportsImmediate && target.id !== scope.source.id && ['running','detached','released'].includes(target.status) }];
      });
      return { tabs, next_cursor: rows.length > LIMITS.page_size ? String(rows[LIMITS.page_size - 1].cursor) : null };
    });

    scoped.get<{ Params: { id: string } }>('/tabs/:id', async (req, reply) => {
      const scope = readScope(req);
      const target = ownedTab(scope, req.params.id, true);
      if (!target) return reply.code(404).send({ error: '找不到标签页' });
      const page = await platformApi(app, scope.userId, 'GET', `/api/sessions/${encodeURIComponent(target.id)}/conversation?limit=4`);
      const messages = Array.isArray(page.messages) ? page.messages.filter((item: { role: unknown; text: string; presentation?: string }) =>
        (item.role === 'user' || item.role === 'assistant') && typeof item.text === 'string' && !item.presentation && !automaticConversationContext(item.text))
        .map((item: { role: string; text: string }) => ({ role: item.role, text: item.text.slice(0, 2400) })) : [];
      return { tab_id: target.id, parent_tab_id: target.parent_session_id ?? null, state: getTracker(target.id)?.state.processState || target.status, messages };
    });

    scoped.get<{ Querystring: { cursor?: string } }>('/inbox', async (req, reply) => {
      const cursor = Number(req.query.cursor || 0);
      if (!Number.isSafeInteger(cursor) || cursor < 0) return reply.code(400).send({ error: '分页游标无效' });
      const scope = readScope(req);
      const rows = getDb().prepare(`SELECT h.id,h.target_tab_id,h.source_tab_id,h.source_label,h.request_id,h.reply_to,h.batch_id,h.status,
        substr(h.content,1,400) AS preview,h.intent,h.created_at,h.rowid AS cursor,
        EXISTS(SELECT 1 FROM agent_docs_handoffs r WHERE r.reply_to=h.id AND r.source_tab_id=h.target_tab_id
          AND r.intent='result' AND r.status IN ('queued','submitted','stored')) AS result_replied
        FROM agent_docs_handoffs h WHERE h.target_tab_id=? AND h.rowid>?
        AND h.status<>'rejected' AND h.created_at>=datetime('now','-7 days') ORDER BY h.rowid LIMIT ?`)
        .all(scope.source.id, cursor, LIMITS.page_size + 1) as Handoff[];
      return { messages: rows.slice(0, LIMITS.page_size).map(({ id, target_tab_id, cursor, result_replied, ...row }) => ({
        message_id: id, ...row, result_replied: !!result_replied,
      })), next_cursor: rows.length > LIMITS.page_size ? String(rows[LIMITS.page_size - 1].cursor) : null };
    });

    scoped.get<{ Params: { id: string } }>('/inbox/:id', async (req, reply) => {
      const scope = readScope(req);
      const row = getDb().prepare(`SELECT id AS message_id,source_tab_id,source_label,reply_to,batch_id,status,intent,content,created_at
        FROM agent_docs_handoffs WHERE id=? AND target_tab_id=? AND status IN ('queued','submitted','stored')
        AND created_at>=datetime('now','-7 days')`).get(req.params.id, scope.source.id);
      return row ? { message: row } : reply.code(404).send({ error: '找不到已接收的消息' });
    });

    scoped.get<{ Querystring: { agent_id?: string; include_quota?: string } }>('/execution-options', async req => {
      const scope = readScope(req);
      const source_execution = sourceExecution(scope.source);
      const { agent_id, environment_id } = source_execution;
      const agent = getAgent(agent_id);
      const allowed = environment_id && agent.descriptor.capabilities.launch &&
        (!req.query.agent_id || req.query.agent_id === agent_id) &&
        userCanUseToolForProject(scope.userId, scope.projectId, 'session', agent_id);
      const environments = allowed && environment_id ? await agent.launch.collaborationOptions?.(
        scope.userId, scope.projectId, req.query.include_quota === 'true', environment_id,
      ) ?? [] : [];
      return { source_execution, environments };
    });

    scoped.get<{ Params: { id: string } }>('/operations/:id', async (req, reply) => {
      const row = operation(readScope(req), req.params.id);
      return row ? operationView(req.params.id, row) : reply.code(404).send({ error: '找不到操作记录' });
    });

    scoped.post('/messages', async (req, reply) => {
      const parsed = send.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: '无效的消息请求' });
      const input = parsed.data, scope = readScope(req);
      let receivedBatch: AgentDocsBatch | undefined;
      const dispatch = input.batch_id && input.target_tab_ids ? { batchId: input.batch_id, size: input.target_tab_ids.length } : undefined;
      const action = await mutate(scope, 'send', input, async () => {
        // Persist per-target progress so a process restart never replays an uncertain delivery.
        let targets = input.target_tab_ids || [];
        if (input.reply_to) {
          const original = getDb().prepare(`SELECT source_tab_id, CASE WHEN intent='task' AND reply_to IS NULL THEN batch_id END AS batch_id
            FROM agent_docs_handoffs WHERE id=? AND target_tab_id=? AND status<>'rejected'
            AND created_at>=datetime('now','-7 days')`).get(input.reply_to, scope.source.id) as
            { source_tab_id: string; batch_id: string | null } | undefined;
          if (!original) return { results: [], status: 'rejected', reason: '找不到可回传的原消息' };
          if (original.batch_id) {
            receivedBatch = getAgentDocsBatch(original.batch_id, original.source_tab_id);
            if (!receivedBatch) return { results: [], status: 'rejected', reason: '找不到原任务的协作批次' };
            return { results: [await deliverBatchReply(app, scope, receivedBatch, input.reply_to, input)] };
          }
          targets = [original.source_tab_id];
        }
        const results: Array<{ tab_id: string; status: string; message_id?: string; reason?: string }> = targets.map(id => ({ tab_id: id, status: 'unknown' }));
        recordResult(scope, input.request_id, { results });
        await Promise.allSettled(targets.map(async (id, index) => {
          results[index] = await deliver(app, scope, id, input.text, input.request_id, input.reply_to, input.intent, input.batch_id);
          recordResult(scope, input.request_id, { results });
        }));
        return { results };
      }, dispatch);
      if (receivedBatch) await batches.check(receivedBatch.id, receivedBatch.tab_id);
      if (dispatch) await batches.check(dispatch.batchId, scope.source.id);
      return action;
    });

    scoped.post<{ Params: { id: string } }>('/tabs/:id/delete', async (req, reply) => {
      const parsed = deleteTab.safeParse(req.body);
      if (!parsed.success || !tabId.safeParse(req.params.id).success) {
        return reply.code(400).send({ error: '无效的标签页删除请求' });
      }
      const scope = readScope(req), id = req.params.id;
      const input = { ...parsed.data, tab_id: id };
      return mutate(scope, 'delete', input, async () => {
        const result = { tab_id: id, status: 'rejected' };
        const target = ownedTab(scope, id, true);
        if (!target || target.id === scope.source.id || !agentDocsTabAccessible(target, 'write')) {
          return { ...result, reason: '目标标签不可删除' };
        }
        if (input.delete_history) {
          try {
            await platformApi(app, scope.userId, 'DELETE', `/api/sessions/${encodeURIComponent(id)}/record?stop=true&background=true`);
          } catch (error) {
            if (error instanceof PlatformApiError && error.statusCode < 500) return { ...result, reason: error.message };
            throw error;
          }
          return { tab_id: id, status: 'closed', history_status: 'pending' };
        }
        await killSession(id);
        await waitForStoppedSessionLifecycle(id);
        const historyState = sessionRecordDeletionState(id);
        if (!getSession(id)) return { tab_id: id, status: 'closed', history_status: 'deleted' };
        if (historyState === 'pending') return { tab_id: id, status: 'closed', history_status: historyState };
        if (!canQueueSessionRecordDeletion(id)) throw Error('标签页关闭状态待确认');
        removeSessionTabs(id, { userId: scope.userId, projectId: scope.projectId });
        return { tab_id: id, status: 'closed', history_status: 'retained' };
      });
    });

    scoped.post('/tabs', async (req, reply) => {
      const parsed = create.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: '无效的标签页创建请求' });
      const input = parsed.data, scope = readScope(req);
      const action = await mutate(scope, 'create', input, async () => {
        const rejected = (reason: string) => ({ launch_status: 'rejected', initial_message_status: input.initial_message ? 'rejected' : null, reason });
        const { agent_id, environment_id } = sourceExecution(scope.source);
        const agent = getAgent(agent_id);
        const { agent_id: requestedAgent, environment_id: requestedEnvironment, model_id, reasoning_effort, service_tier } = input.execution ?? {};
        if (requestedAgent && requestedAgent !== agent_id) return rejected('子标签页必须使用创建者的 Agent');
        if (requestedEnvironment && (agent.environment?.storageId?.(requestedEnvironment) ?? requestedEnvironment) !== environment_id)
          return rejected('子标签页必须使用创建者绑定的 Provider 或账号');
        if (!agent.descriptor.capabilities.launch || !userCanUseToolForProject(scope.userId, scope.projectId, 'session', agent_id))
          return rejected('项目未授权此 Agent');
        const launchPreference = model_id || reasoning_effort || service_tier ? { model_id, reasoning_effort, service_tier } : undefined;
        const project = getDb().prepare('SELECT path FROM projects WHERE id=?').get(scope.projectId) as { path: string } | undefined;
        if (!project) return rejected('项目不可用');
        let existing;
        try {
          const source = { id: scope.source.id, userId: scope.userId, projectId: scope.projectId };
          existing = await withAgentDocsCreation(source, () => platformApi(app, scope.userId, 'POST', '/api/sessions', {
            project_id: scope.projectId, project_path: project.path, mode: 'session', cli_type: agent_id,
            environment_id: scope.source.agent_environment_id || undefined,
            launch_preference: launchPreference, tab_name: input.name,
          }));
        } catch (error) {
          if (error instanceof PlatformApiError && error.statusCode < 500) return rejected(error.message);
          throw error;
        }
        const id = existing.session.id as string;
        const state = { tab_id: id, parent_tab_id: scope.source.id, launch_status: 'starting', applied_execution: null as Json | null,
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
        state.applied_execution = { ...sourceExecution(current), model_id: runtime?.model ?? null,
          reasoning_effort: runtime?.effort ?? null, service_tier: runtime?.service_tier ?? null };
        if (launchPreference && (!runtime || runtime.model !== model_id ||
            reasoning_effort && runtime.effort !== reasoning_effort ||
            service_tier && (runtime.service_tier || 'default') !== service_tier)) {
          return { ...state, initial_message_status: input.initial_message ? 'rejected' : null, reason: '启动配置尚未确认' };
        }
        if (input.initial_message) {
          const result = await deliver(app, scope, id, input.initial_message, input.request_id, undefined, 'task', input.batch_id);
          state.initial_message_status = result.status;
          return { ...state, initial_message_id: 'message_id' in result ? result.message_id : undefined, initial_message_reason: 'reason' in result ? result.reason : undefined };
        }
        return state;
      }, input.batch_id ? { batchId: input.batch_id, size: 1 } : undefined);
      if (input.batch_id) await batches.check(input.batch_id, scope.source.id);
      return action;
    });
  }, { prefix: '/agent-docs' });
};
