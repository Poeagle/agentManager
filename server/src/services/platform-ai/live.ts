import { EventEmitter } from 'events';
import { getDb } from '../../db/index.js';

export const publicMessageColumns = 'id,role,content,status,error,progress,partial_content,created_at';
const bus = new EventEmitter();
bus.setMaxListeners(0);
export type LiveEvent = {type: 'message'; message: Record<string, unknown>} | {type: 'refresh'};
export function subscribeConversation(id: string, listener: (event: LiveEvent) => void): () => void {
  bus.on(id, listener);
  return () => bus.off(id, listener);
}
export function publishMessage(id: string): void {
  const row = getDb().prepare(`SELECT conversation_id,${publicMessageColumns} FROM platform_ai_messages WHERE id=?`).get(id) as {conversation_id: string} | undefined;
  if (!row) return;
  const {conversation_id, ...message} = row;
  bus.emit(conversation_id, {type: 'message', message});
}
export function refreshConversation(id: string): void { bus.emit(id, {type: 'refresh'}); }
