import { open } from 'fs/promises';
import { conversationAsyncQuestions, conversationQuestionReply, type ConversationAsyncQuestion } from './conversation-interactions.js';

export interface PendingQuestionGroup { id: string; questions: ConversationAsyncQuestion[]; timestamp: string | null; turn_id?: string }
interface Cursor { inode: number; offset: number; mtime: number; partial: Buffer; skipping: boolean; latestCall: string | null; groups: Map<string, PendingQuestionGroup>; answered: Set<string> }
const cursors = new Map<string, Cursor>(), pending = new Map<string, Promise<PendingQuestionGroup[]>>();
const CHUNK = 256 * 1024, MAX_RECORD = 512 * 1024;
let readers = 0;
const waiters: Array<() => void> = [];
async function acquire() { if (readers < 2) readers++; else await new Promise<void>(resolve => waiters.push(resolve)); }
function release() { const next = waiters.shift(); if (next) next(); else readers--; }

function apply(cursor: Cursor, bytes: Buffer, sessionId: string) {
  if (bytes.length > MAX_RECORD || !/"type"\s*:\s*"(?:message|agent_message|user_message|item_completed|function_call)"/.test(bytes.subarray(0,1600).toString('utf8'))) return;
  try {
    const entry = JSON.parse(bytes.toString('utf8')), p = entry.payload;
    if (!p || typeof p !== 'object' || p.thread_id && p.thread_id !== sessionId) return;
    const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : null;
    const turn = p.turn_id || p.internal_chat_message_metadata_passthrough?.turn_id;
    function add(item: any) {
      const id = typeof item?.id === 'string' ? item.id : cursor.latestCall;
      if (!id) return;
      const questions = conversationAsyncQuestions({ ...item, id });
      if (!questions) return;
      const remaining = questions.filter(question => question.id && !cursor.answered.has(question.id));
      if (remaining.length) cursor.groups.set(id, { id, questions: remaining, timestamp, ...(typeof turn === 'string' ? { turn_id: turn } : {}) });
    }
    if (entry.type === 'response_item' && p.type === 'function_call' && /(?:^|[._])request_user_input_async$/.test(p.name || '') && typeof p.call_id === 'string') {
      cursor.latestCall = p.call_id;
    }
    if (entry.type === 'event_msg' && p.type === 'item_completed' && p.item?.type === 'AgentMessage') add(p.item);
    if (entry.type === 'event_msg' && p.type === 'agent_message' && p.delivery === 'async') add(p);
    if (entry.type === 'response_item' && p.type === 'message' && p.role === 'assistant' && p.delivery === 'async') add(p);
    const human = entry.type === 'response_item' && p.type === 'message' && p.role === 'user'
      ? (p.content || []).filter((part: any) => part.type === 'input_text' && typeof part.text === 'string').map((part: any) => part.text).join('\n')
      : entry.type === 'event_msg' && p.type === 'user_message' && typeof p.message === 'string' ? p.message : null;
    if (human) for (const answer of conversationQuestionReply(human,Array.isArray(p.content)&&p.content.some((part:any)=>part?.type==='input_image'))?.answers || []) cursor.answered.add(answer.question_id);
    for (const [id, group] of cursor.groups) {
      group.questions = group.questions.filter(question => !cursor.answered.has(question.id!));
      if (!group.questions.length) cursor.groups.delete(id);
    }
  } catch { /* malformed/incomplete native records cannot create attention */ }
}

/** Independently index unanswered questions, including questions older than
 * the current chat page or runtime tail. Memory and concurrent reads are bounded. */
export function readPendingQuestions(path: string, sessionId: string): Promise<PendingQuestionGroup[]> {
  const running = pending.get(path); if (running) return running;
  const work = (async () => {
    await acquire();
    try {
      const file = await open(path, 'r');
      try {
        const stat = await file.stat(); let cursor = cursors.get(path);
        if (!cursor || cursor.inode !== stat.ino || stat.size < cursor.offset || stat.size === cursor.offset && stat.mtimeMs !== cursor.mtime) {
          cursor = { inode: stat.ino, offset: 0, mtime: stat.mtimeMs, partial: Buffer.alloc(0), skipping: false, latestCall: null, groups: new Map(), answered: new Set() };
        }
        const buffer = Buffer.alloc(Math.min(CHUNK, Math.max(1, stat.size - cursor.offset)));
        while (cursor.offset < stat.size) {
          const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, stat.size - cursor.offset), cursor.offset);
          if (!bytesRead) break;
          let bytes = buffer.subarray(0, bytesRead); cursor.offset += bytesRead;
          if (cursor.skipping) { const end = bytes.indexOf(10); if (end < 0) continue; bytes = bytes.subarray(end + 1); cursor.skipping = false; }
          const combined = cursor.partial.length ? Buffer.concat([cursor.partial, bytes]) : bytes;
          let start = 0, end: number;
          while ((end = combined.indexOf(10, start)) >= 0) { apply(cursor, combined.subarray(start, end), sessionId); start = end + 1; }
          cursor.partial = Buffer.from(combined.subarray(start));
          if (cursor.partial.length > MAX_RECORD) { cursor.partial = Buffer.alloc(0); cursor.skipping = true; }
        }
        cursor.mtime = stat.mtimeMs; cursors.delete(path); cursors.set(path, cursor);
        if (cursors.size > 64) cursors.delete(cursors.keys().next().value!);
        return [...cursor.groups.values()].map(group=>({...group,questions:[...group.questions]}));
      } finally { await file.close(); }
    } finally { release(); }
  })().finally(() => pending.delete(path));
  pending.set(path, work); return work;
}
