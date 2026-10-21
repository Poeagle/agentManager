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
import type { ModelTool } from './model.js';
import { detectWorkAgent, detectWorkAgents } from './agents.js';
import { MAX_IMAGES, messageAttachments, ownedImage } from './attachments.js';

const workspaceDispatches = new Set<string>();

const objectParams = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const stringParam = { type: 'string' };
const attachmentParam = {type: 'array', items: stringParam, maxItems: MAX_IMAGES, description: 'Image attachment IDs from this conversation to give to the work agent.'};
export const PLATFORM_TOOLS: ModelTool[] = [
  { type: 'function', function: { name: 'platform_capabilities', description: 'Read the platform API catalog. Optional endpoint_id returns its full request and response definition.', parameters: objectParams({ endpoint_id: stringParam, offset: {type: 'integer', minimum: 0}, limit: {type: 'integer', minimum: 1, maximum: 50} }) } },
  { type: 'function', function: { name: 'platform_request', description: 'Call a catalog endpoint as the current platform user. Read endpoint parameters first. New work and sending input use start_work/send_to_session.', parameters: objectParams({ endpoint_id: stringParam, path_params: { type: 'object', additionalProperties: { type: 'string' } }, query: { type: 'object', additionalProperties: { type: 'string' } }, body: { type: 'object', additionalProperties: true } }, ['endpoint_id']) } },
  { type: 'function', function: { name: 'start_work', description: 'Create and start a Codex/Claude project session without a browser, and register background observation. Same workspace active work is serialized.', parameters: objectParams({ project_id: stringParam, requirement: stringParam, cli_type: { type: 'string', enum: ['codex', 'claude'] }, attachment_ids: attachmentParam }, ['project_id', 'requirement', 'cli_type']) } },
  { type: 'function', function: { name: 'send_to_session', description: 'Send an explicit instruction to a ready session and track the resulting task. Busy sessions are rejected. Permission prompts require explicit user authorization.', parameters: objectParams({ session_id: stringParam, instruction: stringParam, attachment_ids: attachmentParam }, ['session_id', 'instruction']) } },
  { type: 'function', function: { name: 'track_session', description: 'Observe an existing accessible session from its current output position. Does not send input or restart the agent.', parameters: objectParams({ session_id: stringParam, requirement: stringParam }, ['session_id', 'requirement']) } },
  { type: 'function', function: { name: 'list_tracked_tasks', description: 'Read current user task progress, summaries and completion evidence.', parameters: objectParams({}) } },
];

export function platformCatalog(app?: FastifyInstance) {
  const excluded = new Set(['/api/auth/login', '/api/sessions', '/api/sessions/:id/execute', '/api/sessions/:id/agent']);
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

function noOtherWorkspaceTask(projectId: string, exceptSessionId?: string): void {
  const task = getDb().prepare(`SELECT t.id FROM platform_ai_tasks t JOIN sessions s ON s.id=t.session_id
    WHERE s.project_id=? AND t.status IN ('running','blocked','uncertain') AND t.session_id!=? LIMIT 1`)
    .get(projectId, exceptSessionId || '') as {id: string} | undefined;
  if (task) throw new Error('该项目已有跟踪中的任务，请先完成当前工作，或在独立工作区执行并行任务');
  const sessions = getDb().prepare("SELECT id FROM sessions WHERE project_id=? AND id!=? AND status IN ('pending','launching','running','detached','released')").all(projectId, exceptSessionId || '') as Array<{id: string}>;
  if (sessions.some(session => {
    const tracker = getTracker(session.id);
    return sessionManager.isSessionActive(session.id) && (!tracker || tracker.hasPendingExecute || tracker.state.processState === 'busy');
  })) throw new Error('该工作目录有其他活跃会话尚未空闲，请先完成当前工作或使用独立工作区');
}

export async function executePlatformTool(app: FastifyInstance, conversation: Conversation, name: string, rawArguments: string, operationId: string, messageId?: string): Promise<any> {
  const args = JSON.parse(rawArguments);
  const userId = conversation.user_id;
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
  if (name === 'platform_capabilities') {
    const input = z.object({ endpoint_id: z.string().optional(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(50).default(50) }).strict().parse(args);
    const catalog = platformCatalog(app);
    if (input.endpoint_id) return catalog.find(item => item.endpoint_id === input.endpoint_id) || { error: 'Unknown endpoint' };
    return { agents: await detectWorkAgents(), total: catalog.length, next_offset: input.offset + input.limit < catalog.length ? input.offset + input.limit : null, endpoints: catalog.slice(input.offset, input.offset + input.limit).map(({ endpoint_id, description, callable }) => ({ endpoint_id, description, callable })),
      guidance: 'Use start_work for new sessions, send_to_session for input, list_tracked_tasks for task progress. APIs remain permission scoped.' };
  }
  if (name === 'platform_request') {
    const input = z.object({ endpoint_id: z.string(), path_params: z.record(z.string().max(256)).default({}), query: z.record(z.string().max(1024)).default({}), body: z.record(z.unknown()).optional() }).strict().parse(args);
    const endpoint = platformCatalog(app).find(item => item.endpoint_id === input.endpoint_id);
    if (!endpoint) throw new Error('接口不在平台 AI 能力目录中');
    if (!endpoint.callable) throw new Error(endpoint.restriction || '此接口需要使用专用工具或在平台中操作');
    let path = endpoint.path.replace(/:([A-Za-z_]+)/g, (_, key: string) => {
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
    return { tasks: getDb().prepare(`SELECT id,session_id,requirement,status,summary,evidence,updated_at FROM platform_ai_tasks WHERE user_id=? ORDER BY rowid DESC LIMIT 30`).all(userId) };
  }
  if (name === 'start_work') {
    const input = z.object({ project_id: z.string().min(1), requirement: z.string().trim().min(1).max(24000), cli_type: z.enum(['codex', 'claude']), attachment_ids: z.array(z.string().min(1).max(64)).max(MAX_IMAGES).optional() }).strict().parse(args);
    const images = imagesForWork(input.attachment_ids);
    const { project } = await platformApi(app, userId, 'GET', `/api/projects/${encodeURIComponent(input.project_id)}`);
    const agent = await detectWorkAgent(input.cli_type, project.path, true);
    if (agent.status === 'unavailable') throw new Error(`${agent.label} 当前不可用：${agent.reason}。请从 platform_capabilities 返回的可用 Agent 中选择；用户明确指定了 Agent 时应先说明情况，不得擅自替换。`);
    noOtherWorkspaceTask(input.project_id);
    if (workspaceDispatches.has(input.project_id)) throw new Error('该项目已有派发操作正在进行');
    workspaceDispatches.add(input.project_id);
    try {
    // Include a stable operation reference in task metadata for crash reconciliation.
    let taskText = `${input.requirement}\n\n[Platform task reference: ${operationId}]`;
    const { session } = await platformApi(app, userId, 'POST', '/api/sessions', { project_id: input.project_id, project_path: project.path, task: taskText, cli_type: input.cli_type, mode: 'session' });
    const task = trackTask(conversation, session.id, input.requirement, 0, operationId);
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
    return { task_id: task.id, session_id: session.id, status: 'running', monitoring: true };
    } finally { workspaceDispatches.delete(input.project_id); }
  }
  if (name === 'send_to_session' || name === 'track_session') {
    const input = name === 'send_to_session'
      ? z.object({ session_id: z.string().min(1), instruction: z.string().trim().min(1).max(24000), attachment_ids: z.array(z.string().min(1).max(64)).max(MAX_IMAGES).optional() }).strict().parse(args)
      : z.object({ session_id: z.string().min(1), requirement: z.string().trim().min(1).max(24000) }).strict().parse(args);
    const sessionId = input.session_id;
    const { session } = await platformApi(app, userId, 'GET', `/api/sessions/${encodeURIComponent(sessionId)}`);
    if (session.mode === 'terminal') throw new Error('平台 AI 开发任务需要选择 Codex/Claude Session');
    const display = await platformApi(app, userId, 'GET', `/api/sessions/${encodeURIComponent(sessionId)}/display?lines=100`);
    const requirement = 'instruction' in input ? input.instruction : input.requirement;
    if (name === 'track_session') return trackTask(conversation, sessionId, requirement, Number(display.cursor) || 0);
    noOtherWorkspaceTask(session.project_id, sessionId);
    const state = getTracker(sessionId);
    if (display.processState === 'busy' || state?.hasPendingExecute) throw new Error('目标会话正在执行，请稍后再发送');
    if (display.promptType === 'confirmation' || display.promptType === 'choice' || state?.state.isPermission) throw new Error('目标会话等待交互确认，请用户在平台查看并处理后继续');
    if (!sessionManager.isSessionActive(sessionId)) throw new Error('目标会话当前未运行，请先恢复该会话');
    const imagePrompt = await copyImages(sessionId, imagesForWork('attachment_ids' in input ? input.attachment_ids : undefined));
    const task = getDb().transaction(() => {
      const prior = getDb().prepare("SELECT id,user_id,conversation_id FROM platform_ai_tasks WHERE session_id=? AND status IN ('running','blocked','uncertain')").get(sessionId) as {id: string; user_id: string; conversation_id: string} | undefined;
      if (prior && (prior.user_id !== userId || prior.conversation_id !== conversation.id)) throw new Error('该会话已有其他对话跟踪的任务');
      if (prior) getDb().prepare("UPDATE platform_ai_tasks SET status='superseded',summary='已由用户的后续指令替代',updated_at=datetime('now') WHERE id=?").run(prior.id);
      return trackTask(conversation, sessionId, requirement, Number(display.cursor) || 0, operationId);
    })();
    let result: any;
    try { result = await platformApi(app, userId, 'POST', `/api/sessions/${encodeURIComponent(sessionId)}/execute`, { input: `${requirement}\n\n[Platform task reference: ${operationId}]${imagePrompt}`, timeout: 1000, quiescenceMs: 1000 }); }
    catch {
      getDb().prepare("UPDATE platform_ai_tasks SET status='uncertain',summary='指令发送结果待核对，请读取会话状态；平台不会自动重发。' WHERE id=?").run(task.id);
      return { task_id: task.id, session_id: sessionId, status: 'uncertain', message: '发送结果待核对，请查询原会话，不要重复发送。' };
    }
    getDb().prepare(`UPDATE platform_ai_tasks SET requirement=?,status='running',cursor=?,output='',last_fingerprint='',
      last_assessed_fingerprint='',summary='',evidence='',next_observe_at=0,updated_at=datetime('now') WHERE id=?`)
      .run(requirement, Number(display.cursor) || 0, task.id);
    return { task_id: task.id, session_id: sessionId, dispatch_status: result.status, monitoring: true };
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
