import { findUserById } from '../../auth.js';
import { getDb } from '../../db/index.js';
import { userHasPermission } from '../rbac.js';
import { ChannelError, type Channel, type InboundMessage } from './channels.js';
import { readAiConfig } from './config.js';
import { receiveMessage } from './store.js';

/** Shared admission for signed HTTP callbacks and authenticated bot sockets. */
export function acceptChannelMessage(channel: Channel, message: InboundMessage) {
  if (!channel.enabled) throw new ChannelError('渠道已停用', 403, true);
  // Record only the identity, never unauthorized message contents. Administrators
  // can bind the exact (possibly encrypted) userid received from WeCom.
  getDb().prepare(`INSERT INTO platform_ai_channel_senders (channel_id,external_user_id,last_chat_id) VALUES (?,?,?)
    ON CONFLICT(channel_id,external_user_id) DO UPDATE SET last_chat_id=excluded.last_chat_id,last_seen_at=datetime('now')`)
    .run(channel.id, message.externalUserId, message.chatId);
  // Bound retention for unauthenticated/unbound sender identities.
  getDb().prepare(`DELETE FROM platform_ai_channel_senders WHERE channel_id=? AND external_user_id NOT IN
    (SELECT external_user_id FROM platform_ai_channel_senders WHERE channel_id=? ORDER BY last_seen_at DESC,rowid DESC LIMIT 200)`)
    .run(channel.id, channel.id);
  if (!readAiConfig().enabled) throw new ChannelError('平台 AI 尚未启用，请联系管理员配置模型', 503);
  const binding = getDb().prepare('SELECT user_id FROM platform_ai_bindings WHERE channel_id=? AND external_user_id=?')
    .get(channel.id, message.externalUserId) as {user_id: string} | undefined;
  const user = binding && findUserById(binding.user_id);
  if (!user || user.disabled) throw new ChannelError('外部用户尚未绑定有效的平台用户，请联系管理员绑定', 403, true);
  if (!userHasPermission(user.id, 'agent_api', 'write')) throw new ChannelError('平台用户尚无发送 AI 指令的权限', 403, true);
  return receiveMessage({userId: user.id, channelId: channel.id, ...message});
}
