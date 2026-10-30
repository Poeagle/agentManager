import {createHash} from 'crypto';
import type {ConversationMessage} from '../conversation-reader.js';
import type {ModelMessage} from './model.js';

export function progressExcerpt(text: string, limit: number): string {
  if (limit <= 0) return '';
  if (text.length <= limit) return text;
  const marker = '\n…[已省略，必要时读取详情]…\n';
  if (limit <= marker.length) return text.slice(-limit);
  const head = Math.floor((limit - marker.length) / 2);
  return text.slice(0, head) + marker + text.slice(-(limit - marker.length - head));
}

/** Same public conversation items as the dashboard, with a much smaller model
 * budget. A fresh user input must never inherit an earlier turn's final reply. */
export function compactProgressMessages(messages: ConversationMessage[], detail = false) {
  const publicMessages = messages.filter(message => ['user', 'assistant'].includes(message.role));
  const lastUser = publicMessages.map(message => message.role).lastIndexOf('user');
  const current = publicMessages.slice(Math.max(0, lastUser));
  const latestUser = current.find(message => message.role === 'user');
  const latestAgent = [...current].reverse().find(message => message.role === 'assistant');
  const selected = detail ? publicMessages : [latestUser, latestAgent].filter((message): message is ConversationMessage => !!message);
  let budget = detail ? 6000 : 1240;
  const result = [];
  for (const message of selected.slice().reverse()) {
    if (budget <= 0) break;
    const limit = Math.min(budget, detail ? 2000 : message.role === 'user' ? 240 : 1000);
    const text = progressExcerpt(message.text, limit);
    budget -= text.length;
    result.push({id: message.id, role: message.role, text, timestamp: message.timestamp,
      ...(message.phase ? {phase: message.phase} : {}), ...(message.turn_id ? {turn_id: message.turn_id} : {}),
      ...(text !== message.text ? {text_truncated: true} : {})});
  }
  return {messages: result.reverse(), messages_omitted: publicMessages.length > result.length || result.some(message => message.text_truncated)};
}

export function progressObservationKey(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
}

/** Only reuse text that is STILL in this conversation's model context. An
 * operations table cache alone could reference a body removed by compaction. */
export function hasProgressObservation(history: ModelMessage[], sessionId: string, key: string): boolean {
  for (const message of history) {
    if (message.role !== 'tool' || !message.content) continue;
    let result: any;
    try {result = JSON.parse(message.content);} catch {continue;}
    for (const item of [result, ...(Array.isArray(result?.tabs) ? result.tabs : [])]) {
      if (item?.session_id === sessionId && item?.observation_key === key
        && (item.messages?.length || item.latest_agent_message?.text)) return true;
    }
  }
  return false;
}

export function conversationProcessState(page: any, fallback = 'unknown'): string {
  const native = page.runtime?.state;
  if (native && native !== 'unknown') return native === 'running' ? 'busy' : native;
  return page.interaction?.processState || fallback;
}
