import { createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, sign, timingSafeEqual, verify } from 'crypto';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { openSecret, sealSecret, validateHttpUrl } from './config.js';
import { channelsChanged, getBotTransport } from './channel-runtime.js';
import type { ImageSource } from './attachments.js';

export const channelKinds = ['webhook', 'wecom', 'wecom_bot', 'wecom_webhook', 'wechat', 'qq'] as const;
export interface Channel {
  id: string; name: string; kind: typeof channelKinds[number]; enabled: number;
  config: Record<string, string>; secrets: Record<string, string>;
}
interface ChannelRow extends Omit<Channel, 'config' | 'secrets'> { config: string; secrets: string }
export interface InboundMessage {
  externalUserId: string; chatId: string; messageId: string; content: string;
  replyContext: Record<string, unknown>;
  images?: ImageSource[];
}
export class ChannelError extends Error {
  constructor(message: string, public statusCode = 400, public permanent = false) { super(message); }
}

const fields: Record<Channel['kind'], { config: string[]; secrets: string[] }> = {
  webhook: { config: ['outbound_url'], secrets: ['signing_secret'] },
  wecom: { config: ['corp_id', 'agent_id'], secrets: ['app_secret', 'token', 'aes_key'] },
  wecom_bot: { config: ['bot_id'], secrets: ['bot_secret'] },
  wecom_webhook: { config: [], secrets: ['webhook_url'] },
  wechat: { config: ['app_id'], secrets: ['app_secret', 'token', 'aes_key'] },
  qq: { config: ['app_id'], secrets: ['app_secret'] },
};

export function getChannel(id: string): Channel | undefined {
  const row = getDb().prepare('SELECT * FROM platform_ai_channels WHERE id=?').get(id) as ChannelRow | undefined;
  return row ? { ...row, config: JSON.parse(row.config), secrets: JSON.parse(openSecret(row.secrets, `channel:${id}`) || '{}') } : undefined;
}

export function safeChannel(channel: Channel) {
  const { secrets, ...safe } = channel;
  const callback = !['wecom_bot', 'wecom_webhook'].includes(channel.kind);
  return { ...safe, secret_fields_configured: Object.keys(secrets).filter(key => !!secrets[key]),
    callback_path: callback ? `/api/platform-ai/callbacks/${channel.id}` : null,
    connection: channel.kind === 'wecom_bot' ? getBotTransport(channel.id)?.status || {state: 'disconnected', message: channel.enabled ? '等待连接' : '渠道已停用', updated_at: ''} : undefined };
}

export function listChannels() {
  const rows = getDb().prepare('SELECT id FROM platform_ai_channels ORDER BY created_at,id').all() as Array<{id: string}>;
  return rows.map(row => safeChannel(getChannel(row.id)!));
}

export function saveChannel(input: unknown, id?: string) {
  const parsed = z.object({ name: z.string().trim().min(1).max(100), kind: z.enum(channelKinds), enabled: z.boolean(),
    config: z.record(z.string().max(2048)).default({}), secrets: z.record(z.string().max(4096)).default({}),
  }).strict().parse(input);
  const previous = id ? getChannel(id) : undefined;
  if (id && !previous) throw new ChannelError('渠道不存在', 404);
  if (previous && previous.kind !== parsed.kind) throw new ChannelError('渠道类型不能修改，请创建新渠道');
  const channelId = id || nanoid(20);
  const allowed = fields[parsed.kind];
  if (Object.keys(parsed.config).some(key => !allowed.config.includes(key)) || Object.keys(parsed.secrets).some(key => !allowed.secrets.includes(key))) {
    throw new ChannelError('包含不支持的渠道配置字段');
  }
  const config = { ...previous?.config, ...parsed.config };
  if (config.bot_id) {
    config.bot_id = config.bot_id.trim();
    if (config.bot_id.length > 256 || /[\s\x00-\x1f]/.test(config.bot_id)) throw new ChannelError('Bot ID 格式无效');
  }
  const secrets = { ...previous?.secrets };
  for (const [key, value] of Object.entries(parsed.secrets)) {
    // Omitted/empty secret inputs preserve existing values. Deleting the channel removes them.
    if (value) secrets[key] = value;
  }
  if (config.outbound_url) config.outbound_url = validateHttpUrl(config.outbound_url);
  if (secrets.webhook_url) {
    let url: URL;
    try { url = new URL(secrets.webhook_url); } catch { throw new ChannelError('请输入有效的企业微信群机器人 Webhook 地址'); }
    if (url.protocol !== 'https:' || url.hostname !== 'qyapi.weixin.qq.com' || url.port || url.username || url.password || url.hash || url.pathname !== '/cgi-bin/webhook/send' || !url.searchParams.get('key') || [...url.searchParams.keys()].some(key => key !== 'key')) {
      throw new ChannelError('群机器人地址必须为 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…');
    }
    secrets.webhook_url = url.toString();
  }
  if (secrets.aes_key && (!/^[A-Za-z0-9+/]{43}$/.test(secrets.aes_key) || Buffer.from(secrets.aes_key + '=', 'base64').length !== 32)) {
    throw new ChannelError('EncodingAESKey 必须为 43 位 Base64 字符');
  }
  if (parsed.enabled) {
    const requiredConfig = allowed.config;
    const requiredSecrets = parsed.kind === 'wechat' ? ['app_secret', 'token'] : allowed.secrets;
    if (requiredConfig.some(key => !config[key]) || requiredSecrets.some(key => !secrets[key])) throw new ChannelError('请先补齐该渠道的连接参数和凭据');
    if (parsed.kind === 'webhook' && secrets.signing_secret.length < 32) throw new ChannelError('Webhook 签名密钥至少需要 32 个字符');
    if (parsed.kind === 'wecom' && !/^\d+$/.test(config.agent_id)) throw new ChannelError('企业微信 Agent ID 必须为数字');
    if (parsed.kind === 'wecom_bot') {
      const duplicate = getDb().prepare("SELECT 1 FROM platform_ai_channels WHERE kind='wecom_bot' AND enabled=1 AND id<>? AND json_extract(config,'$.bot_id')=?").get(channelId, config.bot_id);
      if (duplicate) throw new ChannelError('该 Bot ID 已在另一个启用的渠道中使用');
    }
  }
  const sealed = sealSecret(JSON.stringify(secrets), `channel:${channelId}`);
  getDb().prepare(`INSERT INTO platform_ai_channels (id,name,kind,enabled,config,secrets) VALUES (?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,enabled=excluded.enabled,config=excluded.config,secrets=excluded.secrets`)
    .run(channelId, parsed.name, parsed.kind, Number(parsed.enabled), JSON.stringify(config), sealed);
  tokenCache.delete(channelId);
  channelsChanged();
  return safeChannel(getChannel(channelId)!);
}

function equalText(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function freshTimestamp(value: string) {
  if (!/^\d{10}$/.test(value) || Math.abs(Date.now() - Number(value) * 1000) > 5 * 60_000) throw new ChannelError('消息时间戳无效或已过期', 401);
}

export function hmacSignature(secret: string, timestamp: string, raw: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
}

/** Restricted text-only XML reader; never expands DTDs or external entities. */
export function xmlText(xml: string, field: string): string {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new ChannelError('XML entities are not supported');
  const match = new RegExp(`<${field}(?:\\s[^>]*)?>([\\s\\S]*?)</${field}>`).exec(xml);
  if (!match) return '';
  const value = match[1];
  if (value.startsWith('<![CDATA[') && value.endsWith(']]>')) return value.slice(9, -3);
  return value.replace(/&(?:lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, entity => {
    const named: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&apos;': "'" };
    if (named[entity]) return named[entity];
    const code = entity.startsWith('&#x') ? parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

function verifyWechatSignature(channel: Channel, query: Record<string, string>, encrypted?: string): void {
  const timestamp = query.timestamp || '';
  freshTimestamp(timestamp);
  const parts = [channel.secrets.token, timestamp, query.nonce || ''];
  if (encrypted !== undefined) parts.push(encrypted);
  const expected = createHash('sha1').update(parts.sort().join('')).digest('hex');
  if (!equalText(expected, (encrypted === undefined ? query.signature : query.msg_signature) || '')) throw new ChannelError('消息签名无效', 401);
}

export function decryptWechatMessage(encrypted: string, aesKey: string, receiver: string): string {
  const key = Buffer.from(aesKey + '=', 'base64');
  if (key.length !== 32) throw new ChannelError('渠道加密配置无效');
  const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
  decipher.setAutoPadding(false);
  let plain: Buffer;
  try { plain = Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]); }
  catch { throw new ChannelError('消息解密失败', 401); }
  const padding = plain.at(-1) || 0;
  if (padding < 1 || padding > 32 || plain.length < 20 + padding || !plain.subarray(-padding).every(byte => byte === padding)) throw new ChannelError('消息填充无效', 401);
  plain = plain.subarray(0, -padding);
  const length = plain.readUInt32BE(16);
  if (length > plain.length - 20 || !equalText(plain.subarray(20 + length).toString(), receiver)) throw new ChannelError('消息接收方不匹配', 401);
  return plain.subarray(20, 20 + length).toString('utf8');
}

function qqPrivateKey(secret: string) {
  if (!secret) throw new ChannelError('QQ 凭据未配置', 503);
  const seed = secret.repeat(Math.ceil(32 / secret.length)).slice(0, 32);
  return createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed)]), format: 'der', type: 'pkcs8' });
}

export function decodeCallback(channel: Channel, method: string, query: Record<string, string>, headers: Record<string, string | string[] | undefined>, raw = ''):
  { response: unknown; message?: InboundMessage } {
  if (!channel.enabled) throw new ChannelError('渠道未启用', 404);
  if (channel.kind === 'wecom_bot' || channel.kind === 'wecom_webhook') throw new ChannelError('此渠道不接受 HTTP 回调', 405);
  if (channel.kind === 'webhook') {
    if (method !== 'POST') throw new ChannelError('Method not allowed', 405);
    const timestamp = String(headers['x-platform-timestamp'] || '');
    freshTimestamp(timestamp);
    if (!equalText(hmacSignature(channel.secrets.signing_secret, timestamp, raw), String(headers['x-platform-signature'] || ''))) throw new ChannelError('消息签名无效', 401);
    const data = z.object({ message_id: z.string().min(1).max(256), user_id: z.string().min(1).max(256),
      chat_id: z.string().min(1).max(256), content: z.string().trim().min(1).max(24000) }).strict().parse(JSON.parse(raw));
    return { response: { accepted: true }, message: { externalUserId: data.user_id, chatId: data.chat_id, messageId: data.message_id, content: data.content, replyContext: {} } };
  }
  if (channel.kind === 'qq') {
    if (method !== 'POST') throw new ChannelError('Method not allowed', 405);
    const data = JSON.parse(raw);
    const key = qqPrivateKey(channel.secrets.app_secret);
    if (data.op === 13) {
      const challenge = z.object({ plain_token: z.string().min(1).max(512), event_ts: z.string().min(1).max(64) }).parse(data.d);
      return { response: { plain_token: challenge.plain_token, signature: sign(null, Buffer.from(challenge.event_ts + challenge.plain_token), key).toString('hex') } };
    }
    const timestamp = String(headers['x-signature-timestamp'] || '');
    freshTimestamp(timestamp);
    const signature = String(headers['x-signature-ed25519'] || '');
    if (!/^[a-f0-9]{128}$/i.test(signature) || !verify(null, Buffer.from(timestamp + raw), createPublicKey(key), Buffer.from(signature, 'hex'))) throw new ChannelError('消息签名无效', 401);
    const response = { op: 12, d: 0 };
    if (data.op !== 0 || !['C2C_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE'].includes(data.t)) return { response };
    const d = data.d || {};
    const isGroup = data.t === 'GROUP_AT_MESSAGE_CREATE';
    const externalUserId = isGroup ? d.author?.member_openid : d.author?.user_openid;
    const message = { externalUserId, chatId: isGroup ? d.group_openid : externalUserId, messageId: d.id,
      content: typeof d.content === 'string' ? d.content.replace(/<@!?\d+>/g, '').trim() : '',
      replyContext: { kind: isGroup ? 'group' : 'c2c', msg_id: d.id, received_at: Date.now() } };
    if (!message.content) return { response };
    validateInbound(message);
    return { response, message };
  }
  const receiver = channel.kind === 'wecom' ? channel.config.corp_id : channel.config.app_id;
  if (method === 'GET') {
    const encrypted = channel.kind === 'wecom' || !!query.msg_signature;
    verifyWechatSignature(channel, query, encrypted ? query.echostr || '' : undefined);
    return { response: encrypted ? decryptWechatMessage(query.echostr || '', channel.secrets.aes_key, receiver) : query.echostr || '' };
  }
  const encrypted = xmlText(raw, 'Encrypt');
  if (channel.secrets.aes_key && !encrypted) throw new ChannelError('该渠道只接受加密消息', 401);
  verifyWechatSignature(channel, query, encrypted || undefined);
  const xml = encrypted ? decryptWechatMessage(encrypted, channel.secrets.aes_key, receiver) : raw;
  if (xmlText(xml, 'ToUserName') !== receiver && channel.kind === 'wecom') throw new ChannelError('消息接收方不匹配', 401);
  if (channel.kind === 'wecom' && xmlText(xml, 'AgentID') !== channel.config.agent_id) throw new ChannelError('应用 ID 不匹配', 401);
  if (xmlText(xml, 'MsgType') !== 'text') return { response: 'success' };
  const user = xmlText(xml, 'FromUserName');
  const message = { externalUserId: user, chatId: user, messageId: xmlText(xml, 'MsgId'), content: xmlText(xml, 'Content').trim(), replyContext: {} };
  validateInbound(message);
  return { response: 'success', message };
}

function validateInbound(message: InboundMessage): void {
  z.object({ externalUserId: z.string().min(1).max(256), chatId: z.string().min(1).max(256), messageId: z.string().min(1).max(256),
    content: z.string().min(1).max(24000), replyContext: z.record(z.unknown()) }).parse(message);
}

const tokenCache = new Map<string, { token: string; expires: number; fingerprint: string }>();

async function requestJson(url: string, init?: RequestInit): Promise<any> {
  let response: Response;
  try { response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(15000), ...(init?.signal ? [init.signal] : [])]) }); }
  catch { throw new ChannelError('无法连接渠道接口，请检查网络与 TLS 配置', 502); }
  if (!response.ok) throw new ChannelError(`渠道请求失败 (HTTP ${response.status})`, 502, response.status === 403);
  let result: any;
  try { result = await response.json(); } catch { throw new ChannelError('渠道返回了无效响应', 502); }
  if (!result || typeof result !== 'object') throw new ChannelError('渠道返回了无效响应', 502);
  if (result.errcode || (result.code && result.code !== 0)) {
    const code = String(result.errcode || result.code);
    throw new ChannelError(`渠道接口错误 (${ /^-?\d{1,10}$/.test(code) ? code : '未知错误码'})`, 502);
  }
  return result;
}

async function accessToken(channel: Channel, signal?: AbortSignal): Promise<string> {
  const fingerprint = createHash('sha256').update(JSON.stringify([channel.config, channel.secrets])).digest('hex');
  const cached = tokenCache.get(channel.id);
  if (cached && cached.expires > Date.now() && cached.fingerprint === fingerprint) return cached.token;
  let result: any;
  if (channel.kind === 'qq') {
    result = await requestJson('https://bots.qq.com/app/getAppAccessToken', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: channel.config.app_id, clientSecret: channel.secrets.app_secret }) });
  } else {
    const url = new URL(channel.kind === 'wecom' ? 'https://qyapi.weixin.qq.com/cgi-bin/gettoken' : 'https://api.weixin.qq.com/cgi-bin/token');
    url.searchParams.set(channel.kind === 'wecom' ? 'corpid' : 'appid', channel.config.corp_id || channel.config.app_id);
    url.searchParams.set(channel.kind === 'wecom' ? 'corpsecret' : 'secret', channel.secrets.app_secret);
    if (channel.kind === 'wechat') url.searchParams.set('grant_type', 'client_credential');
    result = await requestJson(url.toString(), {signal});
  }
  if (typeof result.access_token !== 'string') throw new ChannelError('渠道未返回有效访问令牌', 502);
  tokenCache.set(channel.id, { token: result.access_token, fingerprint, expires: Date.now() + Math.max(30, Number(result.expires_in || 7200) - 120) * 1000 });
  return result.access_token;
}

export async function testChannelConnection(channel: Channel): Promise<{ok: boolean; message: string}> {
  if (!channel.enabled) throw new ChannelError('请先补齐配置并启用渠道');
  if (channel.kind === 'wecom_bot') throw new ChannelError('智能机器人需要通过长连接测试');
  if (channel.kind === 'wecom_webhook' || channel.kind === 'webhook') {
    await deliverMessage(channel, 'connection-test', 'connection-test', '平台 AI 渠道测试通知：消息投递成功。', {}, `test-${nanoid(16)}`);
    return {ok: true, message: '测试通知已获渠道确认，请在目标会话检查接收情况'};
  }
  await accessToken(channel);
  return {ok: true, message: '应用凭据有效；消息回调和真实收发仍需发送文字验证'};
}

export function compactText(content: string, limit = 1850): string {
  if (Buffer.byteLength(content) <= limit) return content;
  let result = '';
  let bytes = 0;
  for (const character of content) {
    bytes += Buffer.byteLength(character);
    if (bytes > limit - 100) break;
    result += character;
  }
  return result + '\n…完整内容请在平台 AI 中查看。';
}

export async function deliverMessage(channel: Channel, chatId: string, externalUserId: string, content: string, replyContext: Record<string, unknown>, deliveryId: string, signal?: AbortSignal): Promise<void> {
  if (!channel.enabled) throw new ChannelError('渠道已停用', 403, true);
  if (channel.kind === 'wecom_bot') {
    const transport = getBotTransport(channel.id);
    if (!transport || transport.status.state !== 'connected') throw new ChannelError('企业微信智能机器人尚未连接，通知将自动重试', 503);
    await transport.deliver(chatId, content, replyContext, deliveryId);
    return;
  }
  if (channel.kind === 'wecom_webhook') {
    try {
      await requestJson(channel.secrets.webhook_url, {method: 'POST', signal, headers: {'Content-Type': 'application/json'}, body: JSON.stringify({msgtype: 'text', text: {content: compactText(content)}})});
    } catch (error) {
      // Fetch errors may contain the URL/key; never expose the raw exception.
      if (error instanceof ChannelError) throw error;
      throw new ChannelError('企业微信群机器人请求失败，请检查网络与 Webhook 配置', 502);
    }
    return;
  }
  if (channel.kind === 'webhook') {
    const body = JSON.stringify({ delivery_id: deliveryId, chat_id: chatId, user_id: externalUserId, content });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await fetch(channel.config.outbound_url, { method: 'POST', redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]),
      headers: { 'Content-Type': 'application/json', 'X-Platform-Timestamp': timestamp, 'X-Platform-Signature': hmacSignature(channel.secrets.signing_secret, timestamp, body), 'Idempotency-Key': deliveryId }, body });
    if (!response.ok) throw new ChannelError(`Webhook 投递失败 (HTTP ${response.status})`, 502);
    await response.body?.cancel();
    return;
  }
  const token = await accessToken(channel, signal);
  let url: string; let payload: Record<string, unknown>;
  const text = compactText(content);
  if (channel.kind === 'wecom') {
    url = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`;
    payload = { touser: externalUserId, agentid: Number(channel.config.agent_id), msgtype: 'text', text: { content: text } };
  } else if (channel.kind === 'wechat') {
    url = `https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${encodeURIComponent(token)}`;
    payload = { touser: externalUserId, msgtype: 'text', text: { content: text } };
  } else {
    const group = replyContext.kind === 'group';
    url = `https://api.sgroup.qq.com/v2/${group ? 'groups' : 'users'}/${encodeURIComponent(chatId)}/messages`;
    const age = Date.now() - Number(replyContext.received_at || 0);
    payload = { content: text, msg_type: 0 };
    if (replyContext.msg_id && age >= 0 && age < (group ? 5 : 60) * 60_000) {
      payload.msg_id = replyContext.msg_id;
      payload.msg_seq = parseInt(createHash('sha256').update(deliveryId).digest('hex').slice(0, 7), 16) + 1;
    }
  }
  try {
    const result = await requestJson(url, { method: 'POST', signal, headers: { 'Content-Type': 'application/json', ...(channel.kind === 'qq' ? { Authorization: `QQBot ${token}`, 'X-Union-Appid': channel.config.app_id } : {}) }, body: JSON.stringify(payload) });
    if (result.invaliduser) throw new ChannelError('接收用户不在应用可见范围内', 403, true);
  } catch (error) { tokenCache.delete(channel.id); throw error; }
}
