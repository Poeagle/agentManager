import { createHash } from 'crypto';
import { WSClient, type WSClientOptions, type WsFrame } from '@wecom/aibot-node-sdk';
import { getDb } from '../../db/index.js';
import { findUserById } from '../../auth.js';
import { userHasPermission } from '../rbac.js';
import { ChannelError, compactText, getChannel, type Channel } from './channels.js';
import { acceptChannelMessage } from './ingress.js';
import { subscribeConversation } from './live.js';
import { getBotTransport, setBotTransport, subscribeChannelChanges, type BotTransport, type ChannelConnection } from './channel-runtime.js';

const silentLogger = {debug() {}, info() {}, warn() {}, error() {}};
export type BotClient = Pick<WSClient, 'on' | 'connect' | 'disconnect' | 'replyStream' | 'sendMessage' | 'removeAllListeners'>;
export type BotClientFactory = (options: WSClientOptions) => BotClient;
interface Stream {
  messageId: string; userId: string; externalUserId: string; frame: WsFrame; id: string;
  text: string; sent: string; sending: Promise<void> | null; timer?: ReturnType<typeof setTimeout>;
  expires: ReturnType<typeof setTimeout>; unsubscribe: () => void;
}
interface Connection extends BotTransport {
  fingerprint: string; client: BotClient; streams: Map<string, Stream>; stopped: boolean;
  rateStart: number; rateCount: number;
}

/** A single authenticated socket per bot; SDK owns heartbeats/backoff/ACKs. */
export class WecomBotManager {
  private connections = new Map<string, Connection>();
  private unsubscribe?: () => void;
  private stopped = false;
  constructor(private factory: BotClientFactory = options => new WSClient(options)) {}

  start(): void {
    if (this.unsubscribe) return;
    this.stopped = false;
    this.unsubscribe = subscribeChannelChanges(() => this.reconcile());
    this.reconcile();
  }

  reconcile(): void {
    if (this.stopped) return;
    const enabled = getDb().prepare("SELECT id FROM platform_ai_channels WHERE kind='wecom_bot' AND enabled=1").all() as Array<{id: string}>;
    const ids = new Set(enabled.map(row => row.id));
    for (const id of this.connections.keys()) if (!ids.has(id)) this.close(id);
    for (const {id} of enabled) {
      const channel = getChannel(id)!;
      const fingerprint = createHash('sha256').update(JSON.stringify([channel.config.bot_id, channel.secrets.bot_secret])).digest('hex');
      if (this.connections.get(id)?.fingerprint === fingerprint) continue;
      this.close(id);
      this.open(channel, fingerprint);
    }
  }

  private state(connection: Connection, state: ChannelConnection['state'], message: string): void {
    if (!connection.stopped) connection.status = {state, message, updated_at: new Date().toISOString()};
  }

  private open(channel: Channel, fingerprint: string): void {
    const client = this.factory({botId: channel.config.bot_id, secret: channel.secrets.bot_secret,
      maxReconnectAttempts: -1, maxAuthFailureAttempts: 3, maxReplyQueueSize: 8, requestTimeout: 10000, logger: silentLogger});
    const connection: Connection = {
      fingerprint, client, streams: new Map(), stopped: false, rateStart: 0, rateCount: 0,
      status: {state: 'connecting', message: '正在连接企业微信', updated_at: new Date().toISOString()},
      deliver: (chatId, content, context, deliveryId) => this.deliver(channel.id, connection, chatId, content, context, deliveryId),
    };
    this.connections.set(channel.id, connection); setBotTransport(channel.id, connection);
    client.on('connected', () => this.state(connection, 'authenticating', '连接已建立，正在认证'));
    client.on('authenticated', () => this.state(connection, 'connected', '已连接并通过认证'));
    client.on('reconnecting', () => this.state(connection, 'reconnecting', '连接中断，正在自动重连'));
    client.on('disconnected', () => {
      if (connection.status.state !== 'displaced' && connection.status.state !== 'error') this.state(connection, 'disconnected', '连接已断开');
      for (const stream of [...connection.streams.values()]) this.clearStream(connection, stream);
    });
    client.on('event.disconnected_event', () => this.state(connection, 'displaced', '同一机器人被其他连接占用；请停止另一实例后重连'));
    client.on('error', error => {
      // Never surface SDK error text: remote bodies may echo credentials.
      const code = (error as Error & {code?: string}).code;
      this.state(connection, 'error', code === 'WS_AUTH_FAILURE_EXHAUSTED' ? '认证失败，请检查 Bot ID 与 Secret 后重连' : '连接或认证失败，正在按策略重试');
    });
    client.on('message.text', frame => this.receive(channel.id, connection, frame));
    client.on('message', frame => {
      if (!['text', 'event'].includes(frame.body?.msgtype || '')) this.reject(connection, frame, '当前支持文本指令，请将需求作为文字发送。');
    });
    try { client.connect(); } catch { this.state(connection, 'error', '无法建立连接，请检查网络和机器人配置'); }
  }

  private allowed(channelId: string, stream: Stream): boolean {
    const user = findUserById(stream.userId);
    const binding = getDb().prepare('SELECT user_id FROM platform_ai_bindings WHERE channel_id=? AND external_user_id=?').get(channelId, stream.externalUserId) as {user_id: string} | undefined;
    return !!user && !user.disabled && userHasPermission(user.id, 'agent_api', 'write') && !!getChannel(channelId)?.enabled && binding?.user_id === user.id;
  }

  private reject(connection: Connection, frame: WsFrame, text: string): void {
    if (connection.stopped || !frame.headers?.req_id) return;
    void connection.client.replyStream(frame, createHash('sha256').update(frame.headers.req_id).digest('hex').slice(0, 32), text, true).catch(() => {});
  }

  private receive(channelId: string, connection: Connection, frame: WsFrame): void {
    if (connection.stopped || connection.status.state !== 'connected') return;
    const now = Date.now();
    if (now - connection.rateStart > 60000) { connection.rateStart = now; connection.rateCount = 0; }
    if (++connection.rateCount > 120) return;
    const body = frame.body;
    const channel = getChannel(channelId);
    if (!channel?.enabled || body?.aibotid !== channel.config.bot_id || !frame.headers?.req_id || frame.headers.req_id.length > 256) return;
    const userId = body.from?.userid, messageId = body.msgid;
    const chatId = body.chattype === 'single' ? userId : body.chattype === 'group' ? body.chatid : null;
    const content = typeof body.text?.content === 'string' ? body.text.content.trim() : '';
    if (![userId, messageId, chatId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 256) || !content || content.length > 24000) {
      this.reject(connection, frame, '消息格式无效，或文字超过 24000 字符。'); return;
    }
    try {
      const result = acceptChannelMessage(channel, {externalUserId: userId, chatId, messageId, content, replyContext: {bot_message_id: messageId}});
      if (result.duplicate) return;
      if (connection.streams.size >= 100) { this.reject(connection, frame, '指令已接收，将通过后续消息返回结果。'); return; }
      const owner = getDb().prepare('SELECT user_id FROM platform_ai_conversations WHERE id=?').get(result.conversation_id) as {user_id: string};
      const stream: Stream = {messageId, userId: owner.user_id, externalUserId: userId, frame: {headers: {req_id: frame.headers.req_id}},
        id: createHash('sha256').update(`${channelId}:${messageId}`).digest('hex').slice(0, 32), text: '已收到，正在处理…', sent: '', sending: null,
        unsubscribe: () => {}, expires: setTimeout(() => {
          // Close the temporary reply before its lifetime ends. The durable
          // outbox can still send the final answer proactively afterwards.
          void this.finishStream(channelId, connection, stream, '任务仍在处理中，后续结果将另行通知。').catch(() => {});
        }, 4 * 60 * 1000)};
      stream.expires.unref();
      connection.streams.set(messageId, stream);
      stream.unsubscribe = subscribeConversation(result.conversation_id, event => {
        if (event.type !== 'message' || event.message.id !== result.message_id) return;
        if (!this.allowed(channelId, stream)) { this.clearStream(connection, stream); return; }
        if (event.message.status === 'failed') {
          void this.finishStream(channelId, connection, stream, '本轮处理未能完成，请查看后续通知。').catch(() => {}); return;
        }
        if (event.message.status === 'done') return; // The outbox owns final ACK/retry.
        stream.text = String(event.message.partial_content || event.message.progress || '正在处理…');
        if (!stream.timer) {
          stream.timer = setTimeout(() => {stream.timer = undefined; void this.flush(channelId, connection, stream).catch(() => {});}, 1200);
          stream.timer.unref();
        }
      });
      void this.flush(channelId, connection, stream).catch(() => {});
    } catch (error) {
      this.reject(connection, frame, error instanceof ChannelError ? error.message : '接收消息失败，请稍后重试。');
    }
  }

  private async flush(channelId: string, connection: Connection, stream: Stream): Promise<void> {
    if (stream.sending || connection.streams.get(stream.messageId) !== stream || stream.sent === stream.text) return stream.sending || undefined;
    if (!this.allowed(channelId, stream)) { this.clearStream(connection, stream); return; }
    const content = compactText(stream.text, 20000);
    stream.sending = connection.client.replyStream(stream.frame, stream.id, content, false).then(() => { stream.sent = content; }).catch(() => {
      this.clearStream(connection, stream);
    }).finally(() => { stream.sending = null; });
    await stream.sending;
  }

  private async finishStream(channelId: string, connection: Connection, stream: Stream, content: string): Promise<void> {
    if (connection.streams.get(stream.messageId) !== stream) throw new ChannelError('临时回复流已结束', 409);
    // Claim finalization before awaiting an in-flight partial update. A timeout
    // and an outbox delivery must never both finish the same stream.
    connection.streams.delete(stream.messageId);
    clearTimeout(stream.timer); clearTimeout(stream.expires); stream.unsubscribe();
    await stream.sending;
    if (!this.allowed(channelId, stream)) { this.clearStream(connection, stream); throw new ChannelError('渠道或用户绑定已失效', 403, true); }
    try { await connection.client.replyStream(stream.frame, stream.id, compactText(content, 20000), true); }
    finally { this.clearStream(connection, stream); }
  }

  private async deliver(channelId: string, connection: Connection, chatId: string, content: string, context: Record<string, unknown>, _deliveryId: string): Promise<void> {
    const stream = typeof context.bot_message_id === 'string' ? connection.streams.get(context.bot_message_id) : undefined;
    if (stream) {
      try { await this.finishStream(channelId, connection, stream, content); return; }
      catch (error) { if (error instanceof ChannelError && error.permanent) throw error; }
      // A temporary reply may have expired. Fall back to an active message.
    }
    try { await connection.client.sendMessage(chatId, {msgtype: 'markdown', markdown: {content: compactText(content, 4000)}}); }
    catch { throw new ChannelError('智能机器人消息未获确认，平台将自动重试', 502); }
  }

  private clearStream(connection: Connection, stream: Stream): void {
    clearTimeout(stream.timer); clearTimeout(stream.expires); stream.unsubscribe();
    if (connection.streams.get(stream.messageId) === stream) connection.streams.delete(stream.messageId);
  }

  private close(id: string): void {
    const connection = this.connections.get(id);
    if (!connection) return;
    connection.stopped = true;
    for (const stream of [...connection.streams.values()]) this.clearStream(connection, stream);
    connection.client.disconnect(); connection.client.removeAllListeners();
    this.connections.delete(id); setBotTransport(id);
  }

  reconnect(id: string): void { this.close(id); this.reconcile(); }

  async test(id: string, timeout = 8000): Promise<{ok: boolean; message: string}> {
    // Reuse the existing socket; a second test socket would displace it.
    if (getBotTransport(id)?.status.state !== 'connected') this.reconnect(id);
    const started = Date.now();
    while (!this.stopped && Date.now() - started < timeout) {
      const status = getBotTransport(id)?.status;
      if (status?.state === 'connected') return {ok: true, message: '长连接已建立并通过企业微信认证'};
      if (status?.state === 'displaced') return {ok: false, message: status.message};
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return {ok: false, message: getBotTransport(id)?.status.message || '连接尚未建立，请检查网络、Bot ID 与 Secret'};
  }

  stop(): void {
    this.stopped = true; this.unsubscribe?.(); this.unsubscribe = undefined;
    for (const id of this.connections.keys()) this.close(id);
  }
}
