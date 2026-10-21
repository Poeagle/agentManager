import { nanoid } from 'nanoid';
import { getDb } from '../../db/index.js';
import { findUserById } from '../../auth.js';
import { storeImageSources, type ImageSource } from './attachments.js';

export interface Conversation {
  id: string; user_id: string; channel_id: string | null; external_chat_id: string;
  external_user_id: string; title: string; context: string; reply_context: string;
}
export interface InboxMessage {
  id: string; conversation_id: string; external_id: string; content: string;
  status: string; attempts: number; lease_until: number; checkpoint: string; reply_context: string;
}
export interface TrackedTask {
  id: string; conversation_id: string; user_id: string; session_id: string;
  requirement: string; source_ref: string; status: string; cursor: number; output: string;
  last_fingerprint: string; last_assessed_fingerprint: string; last_assessed_output: string; summary: string; evidence: string;
  next_observe_at: number; last_assessed_at: number; last_notified_at: number; observation_failures: number;
  created_at: string;
}

export function getConversation(id: string): Conversation | undefined {
  return getDb().prepare('SELECT * FROM platform_ai_conversations WHERE id=?').get(id) as Conversation | undefined;
}

export function assertLiveUser(userId: string): void {
  const user = findUserById(userId);
  if (!user || user.disabled) throw new Error('平台用户不存在或已停用');
}

export function receiveMessage(input: {
  userId: string; channelId?: string; externalUserId: string; chatId: string;
  messageId: string; content: string; replyContext?: Record<string, unknown>; images?: ImageSource[];
}) {
  assertLiveUser(input.userId);
  return getDb().transaction(() => {
    let conversation = getDb().prepare(`SELECT * FROM platform_ai_conversations
      WHERE COALESCE(channel_id,'')=? AND external_chat_id=? AND external_user_id=? AND user_id=?`)
      .get(input.channelId || '', input.chatId, input.externalUserId, input.userId) as Conversation | undefined;
    if (!conversation) {
      const id = nanoid(16);
      getDb().prepare(`INSERT INTO platform_ai_conversations
        (id,user_id,channel_id,external_chat_id,external_user_id,title) VALUES (?,?,?,?,?,?)`)
        .run(id, input.userId, input.channelId || null, input.chatId, input.externalUserId, input.content.slice(0, 60));
      conversation = getConversation(id)!;
    }
    const id = nanoid(16);
    const inserted = getDb().prepare(`INSERT OR IGNORE INTO platform_ai_messages
      (id,conversation_id,external_id,role,content,reply_context) VALUES (?,?,?,'user',?,?)`)
      .run(id, conversation.id, input.messageId, input.content, JSON.stringify(input.replyContext || {}));
    if (inserted.changes) {
      if (input.images?.length) storeImageSources(id, input.images);
      getDb().prepare(`UPDATE platform_ai_conversations SET reply_context=?,updated_at=datetime('now') WHERE id=?`)
        .run(JSON.stringify(input.replyContext || {}), conversation.id);
    }
    const message = getDb().prepare("SELECT id,status FROM platform_ai_messages WHERE conversation_id=? AND external_id=? AND role='user'")
      .get(conversation.id, input.messageId) as { id: string; status: string };
    return { conversation_id: conversation.id, message_id: message.id, status: message.status, duplicate: !inserted.changes };
  })();
}

export function enqueueNotice(conversationId: string, dedupeKey: string, content: string): void {
  const conversation = getConversation(conversationId);
  if (!conversation) return;
  getDb().prepare(`INSERT OR IGNORE INTO platform_ai_messages
    (id,conversation_id,external_id,role,content,status) VALUES (?,?,?,'notice',?,'done')`)
    .run(nanoid(16), conversationId, dedupeKey, content);
  getDb().prepare(`INSERT OR IGNORE INTO platform_ai_outbox
    (id,conversation_id,dedupe_key,content,reply_context) VALUES (?,?,?,?,?)`)
    .run(nanoid(16), conversationId, dedupeKey, content, conversation.reply_context);
  if (dedupeKey.startsWith('task:') || dedupeKey.startsWith('observation-error:') || dedupeKey.startsWith('schedule:')) {
    const targets = getDb().prepare(`SELECT n.channel_id FROM platform_ai_notification_targets n JOIN platform_ai_channels ch ON ch.id=n.channel_id
      WHERE n.user_id=? AND ch.kind='wecom_webhook' AND ch.enabled=1`).all(conversation.user_id) as Array<{channel_id: string}>;
    for (const target of targets) {
      getDb().prepare(`INSERT OR IGNORE INTO platform_ai_outbox
        (id,conversation_id,dedupe_key,content,destination_channel_id) VALUES (?,?,?,?,?)`)
        .run(nanoid(16), conversationId, `${dedupeKey}:target:${target.channel_id}`, content, target.channel_id);
    }
  }
}

export function trackTask(conversation: Conversation, sessionId: string, requirement: string, cursor = 0, sourceRef = ''): TrackedTask {
  const existing = getDb().prepare("SELECT * FROM platform_ai_tasks WHERE session_id=? AND status IN ('running','blocked','uncertain')")
    .get(sessionId) as TrackedTask | undefined;
  if (existing) {
    if (existing.user_id !== conversation.user_id || existing.conversation_id !== conversation.id) {
      throw new Error('该标签页已有其他对话正在跟踪的任务，请创建新标签页');
    }
    return existing;
  }
  const id = nanoid(16);
  getDb().prepare(`INSERT INTO platform_ai_tasks (id,conversation_id,user_id,session_id,requirement,cursor,source_ref)
    VALUES (?,?,?,?,?,?,?)`).run(id, conversation.id, conversation.user_id, sessionId, requirement, cursor, sourceRef);
  return getDb().prepare('SELECT * FROM platform_ai_tasks WHERE id=?').get(id) as TrackedTask;
}

/** Claim one message, with strict FIFO processing within each conversation. */
export function claimMessage(now: number, leaseMs: number): InboxMessage | undefined {
  return getDb().transaction(() => {
    const row = getDb().prepare(`SELECT m.* FROM platform_ai_messages m
      WHERE m.role='user' AND m.status='queued' AND m.available_at<=?
      AND NOT EXISTS (SELECT 1 FROM platform_ai_messages prior WHERE prior.conversation_id=m.conversation_id
        AND prior.role='user' AND (prior.status='processing' OR (prior.status='queued' AND prior.rowid<m.rowid)))
      ORDER BY m.rowid LIMIT 1`).get(now) as InboxMessage | undefined;
    if (!row) return undefined;
    getDb().prepare("UPDATE platform_ai_messages SET status='processing',attempts=attempts+1,lease_until=? WHERE id=?")
      .run(now + leaseMs, row.id);
    return { ...row, status: 'processing', attempts: row.attempts + 1, lease_until: now + leaseMs };
  })();
}
