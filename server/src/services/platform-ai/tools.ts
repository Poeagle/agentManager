import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHash } from 'crypto';
import { createSession as createAuthSession, destroySession, findUserById, sessionCookieName } from '../../auth.js';
import { getDb } from '../../db/index.js';
import { getAgentApiContract } from '../../routes/agent.js';
import * as sessionManager from '../session-manager.js';
import { getTracker } from '../session-state.js';
import { userHasPermission } from '../rbac.js';
import { trackTask, type Conversation } from './store.js';
import type { ModelMessage, ModelTool } from './model.js';
import {compactProgressMessages, conversationProcessState, hasProgressObservation, progressExcerpt, progressObservationKey} from './tab-progress.js';
import { detectWorkAgent, detectWorkAgents } from './agents.js';
import { MAX_IMAGES, messageAttachments, ownedImage } from './attachments.js';
import { sessionPresenter } from '../session-labels.js';

const objectParams = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const stringParam = { type: 'string' };
const attachmentParam = {type: 'array', items: stringParam, maxItems: MAX_IMAGES, description: 'Image attachment IDs from this conversation to give to the work agent.'};
const sourceMessagesParam = {type: 'array', items: stringParam, maxItems: 4, description: 'Optional original user message IDs needed for a multi-turn request. Their text is forwarded verbatim in chronological order, always including the current message. Never write or expand the requirement yourself.'};
const REPORT_TIME_ZONE = 'Asia/Shanghai';

/** Format once on the server: UTC native timestamps must not look like local time. */
function tabUpdateTime(activity: unknown, messages: Array<{timestamp?: unknown}>) {
  const parseTimes = (values: unknown[]) => values.flatMap(value => {
    if (typeof value !== 'string') return [];
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? value.replace(' ', 'T') + 'Z' : value;
    const timestamp = Date.parse(normalized);
    return Number.isFinite(timestamp) ? [timestamp] : [];
  });
  // PTY trackers can be recreated on reconnect/restart. Prefer the actual
  // conversation timestamp so old replies do not suddenly appear newly updated.
  const messageTimes = parseTimes(messages.map(message => message.timestamp));
  const times = messageTimes.length ? messageTimes : parseTimes([activity]);
  const date = times.length ? new Date(Math.max(...times)) : null;
  return {latest_update_at: date?.toISOString() || null,
    latest_update_local: date ? new Intl.DateTimeFormat('sv-SE', {timeZone: REPORT_TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(date) : null,
    time_zone: REPORT_TIME_ZONE, utc_offset: '+08:00'};
}
export const PLATFORM_TOOLS: ModelTool[] = [
  {type: 'function', function: {name: 'list_project_tabs', description: 'Read tab names, live state and a short latest public conversation message. Usually sufficient for project progress; do not read every tab again. No tools or reasoning. Unchanged text is reused from this conversation history.', parameters: objectParams({project_id: stringParam, project_name: stringParam, include_ended: {type: 'boolean'}})}},
  {type: 'function', function: {name: 'read_tab', description: 'READ ONLY: read the same public conversation as the dashboard. Default: latest progress (1000 characters), brief user request, state and update time; unchanged text is omitted when already in this conversation. Set detail=true ONLY when the user asks for detail or the short excerpt is insufficient. No tools/reasoning or terminal output. Works without tracking.', parameters: objectParams({session_id: stringParam, detail: {type: 'boolean'}}, ['session_id'])}},
  { type: 'function', function: { name: 'platform_capabilities', description: 'Read the platform API catalog. Optional endpoint_id returns its full request and response definition.', parameters: objectParams({ endpoint_id: stringParam, offset: {type: 'integer', minimum: 0}, limit: {type: 'integer', minimum: 1, maximum: 50} }) } },
  { type: 'function', function: { name: 'platform_request', description: 'Call a catalog endpoint as the current platform user. Read endpoint parameters first. New work and sending input use start_work/send_to_session.', parameters: objectParams({ endpoint_id: stringParam, path_params: { type: 'object', additionalProperties: { type: 'string' } }, query: { type: 'object', additionalProperties: { type: 'string' } }, body: { type: 'object', additionalProperties: true } }, ['endpoint_id']) } },
  { type: 'function', function: { name: 'start_work', description: 'Forward the original user request verbatim into a new Codex/Claude project tab and register observation. Uses the same permissions and tab limits as manual tab creation; other busy tabs in the project do not block creation.', parameters: objectParams({ project_id: stringParam, requirement: stringParam, cli_type: { type: 'string', enum: ['codex', 'claude'] }, attachment_ids: attachmentParam, source_message_ids: sourceMessagesParam }, ['project_id', 'requirement', 'cli_type']) } },
  { type: 'function', function: { name: 'send_to_session', description: 'Forward original user text verbatim IMMEDIATELY to the selected running agent tab, even while busy or an execute call is pending. Supports terminal tabs with a live Codex/Claude. Does not interrupt the agent; the CLI handles additional input. Track the updated request.', parameters: objectParams({ session_id: stringParam, instruction: stringParam, attachment_ids: attachmentParam, source_message_ids: sourceMessagesParam }, ['session_id', 'instruction']) } },
  { type: 'function', function: { name: 'track_session', description: 'Subscribe to results/questions from the current agent request in an accessible tab, INCLUDING terminal tabs with bound Codex/Claude. Read-only observation: never sends prompts, creates tabs or schedules, or restarts work. Use when the user asks to be notified on completion.', parameters: objectParams({ session_id: stringParam, requirement: stringParam }, ['session_id', 'requirement']) } },
  { type: 'function', function: { name: 'list_tracked_tasks', description: 'Read current user task progress, summaries and completion evidence.', parameters: objectParams({}) } },
];

export function platformCatalog(app?: FastifyInstance) {
  const excluded = new Set(['/api/auth/login', '/api/sessions', '/api/sessions/:id/execute', '/api/sessions/:id/input', '/api/sessions/:id/agent']);
  const endpoints = getAgentApiContract().endpoints.filter(endpoint => endpoint.method !== 'WS' && !('public' in endpoint && endpoint.public) && !(excluded.has(endpoint.path) && endpoint.method !== 'GET'));
  const documented = [
    ...endpoints.map(endpoint => ({ ...endpoint, path: endpoint.path.split('?')[0], endpoint_id: `${endpoint.method} ${endpoint.path.split('?')[0]}` })),
    ...[
      { method: 'GET', path: '/api/settings', description: 'Read public platform settings; secrets are excluded.' },
      { method: 'PUT', path: '/api/settings', description: 'Update supported platform settings; settings write permission required. Body: {settings: {key: string value}}.' },
      { method: 'GET', path: '/api/admin/server-resources', description: 'Read server resource snapshot; monitor permission required.' },
      { method: 'GET', path: '/api/health', description: 'Read platform health and uptime.' },
      { method: 'GET', path: '/api/rbac/me', description: 'Read the current user permissions and roles.' },
      { method: 'GET', path: '/api/users', description: 'List platform users; users read permission required.' },
      { method: 'GET', path: '/api/rbac/roles', description: 'List platform roles; roles read permission required.' },
    ].map(endpoint => ({ ...endpoint, path: endpoint.path.split('?')[0], endpoint_id: `${endpoint.method} ${endpoint.path.split('?')[0]}` })),
  ].map(endpoint => ({...endpoint, callable: true, restriction: ''}));
  const combined = new Map<string, {endpoint_id: string; method: string; path: string; description: string; callable: boolean; restriction?: string}>(
    [...(app?.platformAiApiRegistry?.values() || [])].map(endpoint => [endpoint.endpoint_id, endpoint]));
  for (const endpoint of documented) combined.set(endpoint.endpoint_id, endpoint);
  return [...combined.values()];
}

/** Reuse real route authorization. The one-call cookie never reaches an LLM or network. */
export class PlatformApiError extends Error {
  constructor(message: string, public statusCode: number) { super(message); }
}

export async function platformApi(app: FastifyInstance, userId: string, method: string, url: string, body?: Record<string, unknown>): Promise<any> {
  const user = findUserById(userId);
  if (!user || user.disabled || !userHasPermission(userId, 'agent_api', method === 'GET' ? 'read' : 'write')) throw new PlatformApiError('用户不可用或没有平台 AI 工具权限', 403);
  const cookie = createAuthSession(userId);
  try {
    const response = await app.inject({ method: method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url,
      headers: { cookie: `${sessionCookieName()}=${cookie}` }, ...(body ? { payload: body } : {}) });
    if (response.statusCode >= 400) {
      let detail = '';
      try { detail = response.json().error || ''; } catch { /* avoid logging raw HTML/bodies */ }
      throw new PlatformApiError(`平台接口失败 (${response.statusCode})${detail ? ': ' + String(detail).slice(0, 300) : ''}`, response.statusCode);
    }
    return response.json();
  } finally { destroySession(cookie); }
}

export async function executePlatformTool(app: FastifyInstance, conversation: Conversation, name: string, rawArguments: string, operationId: string, messageId?: string): Promise<any> {
  const args = JSON.parse(rawArguments);
  const userId = conversation.user_id;
  const retainedHistory = (): ModelMessage[] => {
    const checkpoint = messageId ? getDb().prepare('SELECT checkpoint FROM platform_ai_messages WHERE id=? AND conversation_id=?').get(messageId, conversation.id) as {checkpoint: string} | undefined : undefined;
    const current = checkpoint ? JSON.parse(checkpoint.checkpoint) as ModelMessage[] : [];
    return current.length ? current : JSON.parse(conversation.context) as ModelMessage[];
  };
  const originalRequest = (fallback: string, sourceIds?: string[]) => {
    // Production tool calls always carry the current inbox ID. Resolve trusted
    // user rows here instead of accepting an LLM's rewritten business brief.
    if (!messageId) return fallback;
    const ids = [...new Set([...(sourceIds || []), messageId])];
    const rows = getDb().prepare(`SELECT id,content FROM platform_ai_messages WHERE conversation_id=? AND role='user'
      AND id IN (${ids.map(() => '?').join(',')}) ORDER BY rowid`).all(conversation.id, ...ids) as Array<{id: string; content: string}>;
    if (rows.length !== ids.length) throw new Error('原始需求消息不属于当前对话或已不存在');
    const text = rows.map(row => row.content).join('\n\n');
    if (text.length > 24000) throw new Error('选中的原始需求超过长度限制，请减少关联消息');
    return text;
  };
  const imagesForWork = (ids?: string[]) => {
    const selected = ids || (messageId ? messageAttachments(messageId).filter(image => image.status === 'ready').map(image => image.id) : []);
    return [...new Set(selected)].map(id => {
      const image = ownedImage(id, userId, conversation.id);
      if (!image) throw new Error('图片附件不存在、尚未接收成功或不属于当前对话');
      return image;
    });
  };
  const copyImages = async (sessionId: string, images: ReturnType<typeof imagesForWork>) => {
    const paths: string[] = [];
    for (const image of images) {
      const result = await platformApi(app, userId, 'POST', `/api/sessions/${encodeURIComponent(sessionId)}/paste-image`, {dataUrl: `data:${image.mime};base64,${image.data.toString('base64')}`});
      paths.push(result.path);
    }
    return paths.length ? '\n\n用户提供的参考图片（请打开原图查看，不要仅根据文字猜测）：\n' + paths.map((path, index) => `图片 ${index + 1}：${path}`).join('\n') : '';
  };
  if (name === 'list_project_tabs') {
    const input = z.object({project_id: z.string().min(1).optional(), project_name: z.string().trim().min(1).optional(), include_ended: z.boolean().default(false)}).strict().parse(args);
    let projectId = input.project_id;
    if (!projectId && input.project_name) {
      const {projects} = await platformApi(app, userId, 'GET', '/api/projects');
      const matches = projects.filter((project: {name: string}) => project.name.toLowerCase() === input.project_name!.toLowerCase());
      if (matches.length !== 1) return {error: matches.length ? '项目名称不唯一，请按项目 ID 选择' : '没有找到可访问的同名项目', projects: projects.map((project: {id: string; name: string}) => ({id: project.id, name: project.name}))};
      projectId = matches[0].id;
    }
    const {sessions} = await platformApi(app, userId, 'GET', '/api/sessions' + (projectId ? '?project_id=' + encodeURIComponent(projectId) : ''));
    const present = sessionPresenter(userId);
    const tabs = sessions.filter((session: {status: string}) => input.include_ended || ['running','detached','pending','launching','released'].includes(session.status))
      .slice(0,50).map((session: any) => ({session_id: session.id, ...present(session), mode: session.mode, status: session.status,
        process_state: session.processState || 'unknown', prompt_type: session.promptType || null, last_activity_at: session.last_activity_at,
        started_at: session.started_at}));
    const history = retainedHistory();
    for (let offset = 0; offset < tabs.length; offset += 4) {
      const batch = tabs.slice(offset, offset + 4);
      const results = await Promise.allSettled(batch.map((tab: {session_id: string}) => platformApi(app, userId, 'GET', `/api/sessions/${encodeURIComponent(tab.session_id)}/conversation?limit=1`)));
      results.forEach((result, index) => {
        const tab = batch[index];
        if (result.status === 'fulfilled') {
          const page = result.value;
          const messages = page.messages || [];
          const latest = messages.at(-1);
          const agent = latest?.role === 'assistant' ? latest : null;
          const excerpt = agent ? {text: progressExcerpt(String(agent.text), 240), text_truncated: String(agent.text).length > 240, phase: agent.phase, timestamp: agent.timestamp} : null;
          const state = conversationProcessState(page, tab.process_state);
          const key = progressObservationKey([page.generation, state, page.interaction?.promptType, latest?.id, latest?.text, latest?.timestamp]);
          const unchanged = hasProgressObservation(history, tab.session_id, key);
          Object.assign(tab, {...tabUpdateTime(tab.last_activity_at, messages), process_state: state,
            agent_messages_available: page.available, observation_key: key,
            ...(unchanged ? {unchanged: true} : {latest_agent_message: excerpt})});
        } else Object.assign(tab, {...tabUpdateTime(tab.last_activity_at, []), agent_messages_available: null, message_read_error: '对话消息读取暂不可用'});
      });
    }
    return {tabs};
  }
  if (name === 'read_tab') {
    // lines remains accepted for older checkpoints; it no longer reads PTY output.
    const input = z.object({session_id: z.string().min(1).max(256), detail: z.boolean().default(false), lines: z.number().int().min(20).max(1000).optional()}).strict().parse(args);
    const {session} = await platformApi(app, userId, 'GET', `/api/sessions/${encodeURIComponent(input.session_id)}`);
    const page = await platformApi(app, userId, 'GET', `/api/sessions/${encodeURIComponent(input.session_id)}/conversation?limit=${input.detail ? 12 : 4}`);
    const rawMessages = page.messages || [];
    const compact = compactProgressMessages(rawMessages, input.detail);
    const processState = conversationProcessState(page);
    const choices = (page.interaction?.choices || []).slice(0, 8).map((choice: unknown) => progressExcerpt(String(choice), 120));
    const key = progressObservationKey([page.generation, session.status, processState, page.interaction?.promptType, choices, input.detail, compact]);
    const metadata = {session_id: session.id, ...sessionPresenter(userId)(session), mode: session.mode, session_status: session.status,
      process_state: processState, prompt_type: page.interaction?.promptType || null, ...(choices.length ? {choices} : {}),
      ...tabUpdateTime(page.runtime?.last_activity_at, rawMessages),
      messages_available: page.available, output_source: 'conversation', observation_key: key};
    if (!input.detail && hasProgressObservation(retainedHistory(), session.id, key)) return {...metadata, unchanged: true};
    return {...metadata, ...compact, messages_omitted: compact.messages_omitted || !!page.has_more};
  }
  if (name === 'platform_capabilities') {
    const input = z.object({ endpoint_id: z.string().optional(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(50).default(50) }).strict().parse(args);
    const catalog = platformCatalog(app);
    if (input.endpoint_id) return catalog.find(item => item.endpoint_id === input.endpoint_id) || { error: 'Unknown endpoint' };
    return { agents: await detectWorkAgents(), total: catalog.length, next_offset: input.offset + input.limit < catalog.length ? input.offset + input.limit : null, endpoints: catalog.slice(input.offset, input.offset + input.limit).map(({ endpoint_id, description, callable }) => ({ endpoint_id, description, callable })),
      guidance: 'Known tab: read_tab directly. Project overview: list_project_tabs; only read details if insufficient. No tracking required. start_work creates work, send_to_session forwards input. APIs remain permission scoped.' };
  }
  if (name === 'platform_request') {
    const input = z.object({ endpoint_id: z.string(), path_params: z.record(z.string().max(256)).default({}), query: z.record(z.string().max(1024)).default({}), body: z.record(z.unknown()).optional() }).strict().parse(args);
    const endpoint = platformCatalog(app).find(item => item.endpoint_id === input.endpoint_id);
    if (!endpoint) throw new Error('接口不在平台 AI 能力目录中');
    const cleanDisplayAlias = endpoint.method === 'GET' && /^\/api\/sessions\/:id\/(?:output|rendered-output)$/.test(endpoint.path);
    if (!endpoint.callable && !cleanDisplayAlias) throw new Error(endpoint.restriction || '此接口需要使用专用工具或在平台中操作');
    if (endpoint.method === 'GET' && /^\/api\/sessions\/:id\/(?:output|rendered-output|display|agent-messages|conversation)$/.test(endpoint.path)) {
      return executePlatformTool(app, conversation, 'read_tab', JSON.stringify({session_id: input.path_params.id, detail: input.query.detail === 'true'}), operationId, messageId);
    }
    let path = (cleanDisplayAlias ? '/api/sessions/:id/display' : endpoint.path).replace(/:([A-Za-z_]+)/g, (_, key: string) => {
      if (!input.path_params[key] || !/^[A-Za-z0-9_-]+$/.test(input.path_params[key])) throw new Error('缺少或无效的接口路径参数');
      return encodeURIComponent(input.path_params[key]);
    });
    const query = new URLSearchParams(input.query).toString();
    if (query) path += '?' + query;
    const result = await platformApi(app, userId, endpoint.method, path, input.body);
    if (endpoint.method === 'POST' && endpoint.path === '/api/scheduled-tasks' && result.task?.id) {
      getDb().prepare(`INSERT INTO platform_ai_schedule_links (schedule_id,conversation_id) VALUES (?,?)
        ON CONFLICT(schedule_id) DO UPDATE SET conversation_id=excluded.conversation_id,linked_at=datetime('now')`)
        .run(result.task.id, conversation.id);
    }
    return result;
  }
  if (name === 'list_tracked_tasks') {
    z.object({}).strict().parse(args);
    const tasks = getDb().prepare(`SELECT id,session_id,requirement,status,summary,evidence,updated_at FROM platform_ai_tasks WHERE user_id=? ORDER BY rowid DESC LIMIT 30`).all(userId) as Array<{session_id: string}>;
    const present = sessionPresenter(userId);
    return {tasks: tasks.map(task => {const session = sessionManager.getSession(task.session_id); return {...task, ...(session ? present(session) : {})};}),
      guidance: 'These are explicitly registered tasks only. An empty list does not mean no work is running; use list_project_tabs and read_tab to inspect existing terminal/session tabs.'};
  }
  if (name === 'start_work') {
    const input = z.object({ project_id: z.string().min(1), requirement: z.string().trim().min(1).max(24000), cli_type: z.enum(['codex', 'claude']), attachment_ids: z.array(z.string().min(1).max(64)).max(MAX_IMAGES).optional(), source_message_ids: z.array(z.string().min(1).max(64)).max(4).optional() }).strict().parse(args);
    const requirement = originalRequest(input.requirement, input.source_message_ids);
    const images = imagesForWork(input.attachment_ids);
    const { project } = await platformApi(app, userId, 'GET', `/api/projects/${encodeURIComponent(input.project_id)}`);
    const agent = await detectWorkAgent(input.cli_type, project.path, true);
    if (agent.status === 'unavailable') throw new Error(`${agent.label} 当前不可用：${agent.reason}。请从 platform_capabilities 返回的可用 Agent 中选择；用户明确指定了 Agent 时应先说明情况，不得擅自替换。`);
    // Include a stable operation reference in task metadata for crash reconciliation.
    let taskText = `${requirement}\n\n[Platform task reference: ${operationId}]`;
    const { session } = await platformApi(app, userId, 'POST', '/api/sessions', { project_id: input.project_id, project_path: project.path, task: taskText, cli_type: input.cli_type, mode: 'session' });
    const task = trackTask(conversation, session.id, requirement, 0, operationId);
    getDb().prepare("UPDATE platform_ai_operations SET result=? WHERE id=?").run(JSON.stringify({ session_id: session.id, task_id: task.id }), operationId);
    // Existing session creation defers spawn until WebSocket attachment. External users
    // have no browser, so consume the pending spawn and start it explicitly.
    sessionManager.consumePendingSpawn(session.id);
    try {
      taskText += await copyImages(session.id, images);
      if (images.length) getDb().prepare('UPDATE sessions SET task=? WHERE id=?').run(taskText, session.id);
    } catch {
      getDb().prepare("UPDATE platform_ai_tasks SET status='failed',summary='参考图片未能保存到项目，任务尚未启动，请检查后重新派发' WHERE id=?").run(task.id);
      throw new Error('参考图片未能保存到项目，Agent 尚未启动');
    }
    try {
      await sessionManager.spawnSession(session.id, project.path, taskText, 120, 40, input.cli_type);
    } catch {
      getDb().prepare("UPDATE platform_ai_tasks SET status='uncertain',summary='Agent 启动未能确认，请检查会话状态；平台不会重复派发。' WHERE id=?").run(task.id);
      return { task_id: task.id, session_id: session.id, status: 'uncertain', message: 'Agent 启动结果待核对，请读取该会话状态，不要重复创建。', monitoring: true };
    }
    return { task_id: task.id, session_id: session.id, ...sessionPresenter(userId)({...session, task: requirement}), status: 'running', monitoring: true, forwarded_verbatim: !!messageId };
  }
  if (name === 'send_to_session' || name === 'track_session') {
    const input = name === 'send_to_session'
      ? z.object({ session_id: z.string().min(1), instruction: z.string().trim().min(1).max(24000), attachment_ids: z.array(z.string().min(1).max(64)).max(MAX_IMAGES).optional(), source_message_ids: z.array(z.string().min(1).max(64)).max(4).optional() }).strict().parse(args)
      : z.object({ session_id: z.string().min(1), requirement: z.string().trim().min(1).max(24000) }).strict().parse(args);
    const sessionId = input.session_id;
    const { session } = await platformApi(app, userId, 'GET', `/api/sessions/${encodeURIComponent(sessionId)}`);
    const display = await platformApi(app, userId, 'GET', `/api/sessions/${encodeURIComponent(sessionId)}/display?lines=100`);
    const requirement = 'instruction' in input ? originalRequest(input.instruction, input.source_message_ids) : input.requirement;
    if (name === 'track_session') {
      const native = await platformApi(app, userId, 'GET', `/api/sessions/${encodeURIComponent(sessionId)}/agent-messages`);
      const reference = [...(native.messages || [])].reverse().find(message => message.task_reference)?.task_reference;
      if (!reference) throw new Error('尚未读取到该标签当前 Agent 请求的原生记录，暂时无法绑定完成通知；不会向标签发送指令');
      const task = trackTask(conversation, sessionId, requirement, Number(display.cursor) || 0, reference);
      // An older observation without a native binding can be upgraded safely.
      if (!task.source_ref) getDb().prepare('UPDATE platform_ai_tasks SET source_ref=?,next_observe_at=0 WHERE id=?').run(reference,task.id);
      return {task_id:task.id,session_id:sessionId,...sessionPresenter(userId)(session),monitoring:true};
    }
    if (session.mode === 'terminal' && !await sessionManager.getLiveWorkAgent(sessionId)) throw new Error('该标签当前没有运行 Codex/Claude，无法将需求发给工作 Agent');
    const state = getTracker(sessionId);
    if (display.processState === 'waiting_for_input' && (display.promptType === 'confirmation' || display.promptType === 'choice' || state?.state.isPermission)) throw new Error('目标会话正在等待交互确认，请先处理这个提示后发送需求');
    if (!sessionManager.isSessionActive(sessionId)) throw new Error('目标会话当前未运行，请先恢复该会话');
    const imagePrompt = await copyImages(sessionId, imagesForWork('attachment_ids' in input ? input.attachment_ids : undefined));
    const task = getDb().transaction(() => {
      const prior = getDb().prepare("SELECT id,user_id,conversation_id FROM platform_ai_tasks WHERE session_id=? AND status IN ('running','blocked','uncertain')").get(sessionId) as {id: string; user_id: string; conversation_id: string} | undefined;
      if (prior && (prior.user_id !== userId || prior.conversation_id !== conversation.id)) throw new Error('该会话已有其他对话跟踪的任务');
      if (prior) getDb().prepare("UPDATE platform_ai_tasks SET status='superseded',summary='已由用户的后续指令替代',updated_at=datetime('now') WHERE id=?").run(prior.id);
      const combined = prior ? (getDb().prepare('SELECT requirement FROM platform_ai_tasks WHERE id=?').get(prior.id) as {requirement:string}).requirement + '\n\n用户补充：' + requirement : requirement;
      return trackTask(conversation, sessionId, combined.slice(-24000), Number(display.cursor) || 0, operationId);
    })();
    let result: any;
    try { result = await platformApi(app, userId, 'POST', `/api/sessions/${encodeURIComponent(sessionId)}/input`, { input: `${requirement}\n\n[Platform task reference: ${operationId}]${imagePrompt}` }); }
    catch {
      getDb().prepare("UPDATE platform_ai_tasks SET status='uncertain',summary='指令发送结果待核对，请读取会话状态；平台不会自动重发。' WHERE id=?").run(task.id);
      return { task_id: task.id, session_id: sessionId, status: 'uncertain', message: '发送结果待核对，请查询原会话，不要重复发送。' };
    }
    getDb().prepare(`UPDATE platform_ai_tasks SET requirement=?,status='running',cursor=?,output='',last_fingerprint='',
      last_assessed_fingerprint='',summary='',evidence='',next_observe_at=0,updated_at=datetime('now') WHERE id=?`)
      .run(task.requirement, Number(display.cursor) || 0, task.id);
    return { task_id: task.id, session_id: sessionId,...sessionPresenter(userId)(session), dispatch_status: result.status, monitoring: true };
  }
  throw new Error('未知的平台 AI 工具');
}

export function isMutatingTool(name: string, rawArguments: string): boolean {
  if (name === 'platform_request') {
    try { return !String(JSON.parse(rawArguments).endpoint_id).startsWith('GET '); } catch { return false; }
  }
  return ['start_work', 'send_to_session', 'track_session'].includes(name);
}

export function operationKey(messageId: string, callId: string): string {
  return createHash('sha256').update(`${messageId}:${callId}`).digest('hex').slice(0, 32);
}

export function boundedToolResult(result: unknown): string {
  const serialized = JSON.stringify(result);
  return serialized.length <= 18000 ? serialized : JSON.stringify({ truncated: true, result_excerpt: serialized.slice(0, 18000), guidance: 'Narrow the query or use cursor-based reads.' });
}
