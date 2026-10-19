import type { FastifyPluginAsync } from 'fastify';
import { nanoid } from 'nanoid';
import { z, ZodError } from 'zod';
import { getDb } from '../db/index.js';
import { findUserById } from '../auth.js';
import { requirePermission } from '../services/rbac.js';
import { readAiConfig, safeAiConfig, updateAiConfig, publicFailure } from '../services/platform-ai/config.js';
import { ChannelError, decodeCallback, getChannel, listChannels, saveChannel } from '../services/platform-ai/channels.js';
import { getConversation, receiveMessage } from '../services/platform-ai/store.js';
import { platformCatalog, PLATFORM_TOOLS } from '../services/platform-ai/tools.js';
import { PlatformAiWorker } from '../services/platform-ai/worker.js';

const idSchema = z.string().min(1).max(256);
const callbackRate = new Map<string, { start: number; count: number }>();

export const platformAiRoutes: FastifyPluginAsync<{ runWorker?: boolean }> = async (app, options) => {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ').slice(0, 1000) });
    if (error instanceof ChannelError) return reply.code(error.statusCode).send({ error: error.message });
    if (error instanceof SyntaxError) return reply.code(400).send({ error: '无效 JSON' });
    const statusCode = (error as {statusCode?: number})?.statusCode;
    reply.code(statusCode && statusCode < 500 ? statusCode : 400).send({ error: publicFailure(error) });
  });

  app.get('/platform-ai/config', async (req, reply) => {
    if (!requirePermission(req, reply, 'settings', 'write')) return;
    return { config: safeAiConfig() };
  });
  app.put('/platform-ai/config', async (req, reply) => {
    if (!requirePermission(req, reply, 'settings', 'write')) return;
    return { config: updateAiConfig(req.body) };
  });
  app.get('/platform-ai/status', async (req, reply) => {
    if (!requirePermission(req, reply, 'agent_api')) return;
    return { enabled: readAiConfig().enabled };
  });
  app.get('/platform-ai/tools', async (req, reply) => {
    if (!requirePermission(req, reply, 'agent_api')) return;
    return { tools: PLATFORM_TOOLS, endpoints: platformCatalog(app) };
  });

  app.get('/platform-ai/channels', async (req, reply) => {
    if (!requirePermission(req, reply, 'settings', 'write') || !requirePermission(req, reply, 'roles', 'write')) return;
    const bindings = getDb().prepare(`SELECT b.*,u.username,u.display_name FROM platform_ai_bindings b JOIN users u ON u.id=b.user_id ORDER BY b.rowid`).all();
    return { channels: listChannels(), bindings };
  });
  app.post('/platform-ai/channels', async (req, reply) => {
    if (!requirePermission(req, reply, 'settings', 'write') || !requirePermission(req, reply, 'roles', 'write')) return;
    return { channel: saveChannel(req.body) };
  });
  app.put<{Params: {id: string}}>('/platform-ai/channels/:id', async (req, reply) => {
    if (!requirePermission(req, reply, 'settings', 'write') || !requirePermission(req, reply, 'roles', 'write')) return;
    return { channel: saveChannel(req.body, req.params.id) };
  });
  app.delete<{Params: {id: string}}>('/platform-ai/channels/:id', async (req, reply) => {
    if (!requirePermission(req, reply, 'settings', 'write') || !requirePermission(req, reply, 'roles', 'write')) return;
    const linked = getDb().prepare('SELECT 1 FROM platform_ai_conversations WHERE channel_id=? LIMIT 1').get(req.params.id);
    if (linked) return reply.code(409).send({ error: '该渠道已有对话记录，请停用渠道以保留任务和历史' });
    getDb().prepare('DELETE FROM platform_ai_channels WHERE id=?').run(req.params.id);
    return { ok: true };
  });
  app.post('/platform-ai/bindings', async (req, reply) => {
    if (!requirePermission(req, reply, 'settings', 'write') || !requirePermission(req, reply, 'roles', 'write')) return;
    const input = z.object({ channel_id: idSchema, external_user_id: idSchema, user_id: idSchema }).strict().parse(req.body);
    if (!getChannel(input.channel_id)) return reply.code(404).send({ error: '渠道不存在' });
    const user = findUserById(input.user_id);
    if (!user || user.disabled) return reply.code(400).send({ error: '请选择有效的平台用户' });
    getDb().prepare(`INSERT INTO platform_ai_bindings (id,channel_id,external_user_id,user_id) VALUES (?,?,?,?)
      ON CONFLICT(channel_id,external_user_id) DO UPDATE SET user_id=excluded.user_id`)
      .run(nanoid(16), input.channel_id, input.external_user_id, input.user_id);
    return { ok: true };
  });
  app.delete<{Params: {id: string}}>('/platform-ai/bindings/:id', async (req, reply) => {
    if (!requirePermission(req, reply, 'settings', 'write') || !requirePermission(req, reply, 'roles', 'write')) return;
    getDb().prepare('DELETE FROM platform_ai_bindings WHERE id=?').run(req.params.id);
    return { ok: true };
  });

  app.get('/platform-ai/conversations', async (req, reply) => {
    if (!requirePermission(req, reply, 'agent_api')) return;
    return { conversations: getDb().prepare(`SELECT c.id,c.title,c.channel_id,c.updated_at,ch.name AS channel_name
      FROM platform_ai_conversations c LEFT JOIN platform_ai_channels ch ON ch.id=c.channel_id WHERE c.user_id=? ORDER BY c.updated_at DESC,c.rowid DESC LIMIT 100`).all(req.user!.id) };
  });
  app.get<{Params: {id: string}}>('/platform-ai/conversations/:id', async (req, reply) => {
    if (!requirePermission(req, reply, 'agent_api')) return;
    const conversation = getConversation(req.params.id);
    if (!conversation || conversation.user_id !== req.user!.id) return reply.code(404).send({ error: '对话不存在' });
    return {
      conversation: { id: conversation.id, title: conversation.title, channel_id: conversation.channel_id },
      messages: getDb().prepare(`SELECT id,role,content,status,error,created_at FROM (
        SELECT rowid AS sequence,id,role,content,status,error,created_at FROM platform_ai_messages WHERE conversation_id=? ORDER BY rowid DESC LIMIT 100) ORDER BY sequence`).all(conversation.id),
    };
  });
  app.post('/platform-ai/messages', async (req, reply) => {
    if (!requirePermission(req, reply, 'agent_api', 'write')) return;
    if (!readAiConfig().enabled) return reply.code(503).send({ error: '平台 AI 尚未启用，请先配置模型' });
    const input = z.object({ content: z.string().trim().min(1).max(24000), request_id: idSchema, conversation_id: idSchema.optional() }).strict().parse(req.body);
    const conversation = input.conversation_id ? getConversation(input.conversation_id) : undefined;
    if (input.conversation_id && (!conversation || conversation.user_id !== req.user!.id)) return reply.code(404).send({ error: '对话不存在' });
    // Web follow-ups to an external conversation are explicit, and remain associated with that channel.
    const result = receiveMessage({ userId: req.user!.id, channelId: conversation?.channel_id || undefined,
      externalUserId: conversation?.external_user_id || req.user!.id, chatId: conversation?.external_chat_id || `web:${input.request_id}`,
      messageId: `web:${input.request_id}`, content: input.content, replyContext: conversation ? JSON.parse(conversation.reply_context) : {} });
    return reply.code(202).send(result);
  });
  app.get('/platform-ai/tasks', async (req, reply) => {
    if (!requirePermission(req, reply, 'agent_api')) return;
    return { tasks: getDb().prepare(`SELECT t.id,t.conversation_id,t.session_id,t.requirement,t.status,t.summary,t.evidence,t.updated_at,s.project_id
      FROM platform_ai_tasks t LEFT JOIN sessions s ON s.id=t.session_id WHERE t.user_id=? ORDER BY t.rowid DESC LIMIT 100`).all(req.user!.id) };
  });
  app.post<{Params: {id: string}}>('/platform-ai/tasks/:id/stop-tracking', async (req, reply) => {
    if (!requirePermission(req, reply, 'agent_api', 'write')) return;
    const result = getDb().prepare("UPDATE platform_ai_tasks SET status='cancelled',summary='用户已停止跟踪；Agent 会话保持原状态',updated_at=datetime('now') WHERE id=? AND user_id=?")
      .run(req.params.id, req.user!.id);
    if (!result.changes) return reply.code(404).send({ error: '任务不存在' });
    return { ok: true };
  });
  app.get('/platform-ai/deliveries', async (req, reply) => {
    if (!requirePermission(req, reply, 'agent_api')) return;
    return { deliveries: getDb().prepare(`SELECT o.id,o.conversation_id,o.status,o.attempts,o.error,o.created_at FROM platform_ai_outbox o
      JOIN platform_ai_conversations c ON c.id=o.conversation_id WHERE c.user_id=? ORDER BY o.rowid DESC LIMIT 100`).all(req.user!.id) };
  });

  await app.register(async callbacks => {
    // Raw bytes are needed for HMAC/Ed25519 verification. Scope parser changes to callbacks.
    callbacks.removeContentTypeParser('application/json');
    callbacks.addContentTypeParser(['application/json', 'application/xml', 'text/xml'], { parseAs: 'string' }, (_request, body, done) => done(null, body));
    callbacks.route<{Params: {id: string}; Querystring: Record<string, string>}>({
      method: ['GET', 'POST'], url: '/platform-ai/callbacks/:id', bodyLimit: 128 * 1024,
      handler: async (req, reply) => {
        const channel = getChannel(req.params.id);
        if (!channel || !channel.enabled) return reply.code(404).send({ error: '渠道不存在或未启用' });
        const now = Date.now();
        if (callbackRate.size > 1000) for (const [key, value] of callbackRate) if (now - value.start > 60000) callbackRate.delete(key);
        const prior = callbackRate.get(channel.id);
        const window = prior && now - prior.start < 60000 ? prior : { start: now, count: 0 };
        callbackRate.set(channel.id, window);
        if (++window.count > 120) return reply.code(429).send({ error: '渠道消息过于频繁' });
        const decoded = decodeCallback(channel, req.method, req.query, req.headers, typeof req.body === 'string' ? req.body : '');
        if (decoded.message) {
          if (!readAiConfig().enabled) return reply.code(503).send({ error: '平台 AI 尚未启用' });
          const binding = getDb().prepare('SELECT user_id FROM platform_ai_bindings WHERE channel_id=? AND external_user_id=?')
            .get(channel.id, decoded.message.externalUserId) as {user_id: string} | undefined;
          if (!binding || !findUserById(binding.user_id) || findUserById(binding.user_id)!.disabled) return reply.code(403).send({ error: '外部用户尚未绑定有效的平台用户' });
          receiveMessage({ userId: binding.user_id, channelId: channel.id, ...decoded.message });
        }
        if (typeof decoded.response === 'string') return reply.type('text/plain; charset=utf-8').send(decoded.response);
        return decoded.response;
      },
    });
  });

  if (options.runWorker !== false) {
    const worker = new PlatformAiWorker(app);
    app.addHook('onReady', async () => worker.start());
    app.addHook('preClose', async () => worker.stop());
  }
};
