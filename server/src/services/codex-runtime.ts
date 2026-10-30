import { open } from 'fs/promises';
import { findCodexRollout } from './prompt-context.js';

export type CodexState = 'running' | 'idle' | 'waiting_for_input' | 'interrupted' | 'failed' | 'unknown';
export interface CodexRuntime {
  source: 'codex_rollout'; session_id: string | null; state: CodexState;
  last_activity_at: string | null; observed_at: string; reason: string;
}
interface RuntimeCursor {
  offset: number; inode: number; mtime: number; partial: Buffer;
  last: string | null; state: CodexState; activeTurns: Set<string>; waitingCall: string | null;
}
const MAX_READ = 4 * 1024 * 1024;
const cursors = new Map<string, RuntimeCursor>();
const inFlight = new Map<string, Promise<CodexRuntime>>();
const freshCursor = (): RuntimeCursor => ({offset:0,inode:0,mtime:0,partial:Buffer.alloc(0),last:null,state:'unknown',activeTurns:new Set(),waitingCall:null});

/** Only native execution records affect this clock. Reading/repainting a PTY cannot update it. */
function applyRecord(cursor: RuntimeCursor, entry: any, sessionId: string): void {
  const p = entry?.payload;
  if (!p || typeof p !== 'object' || (p.thread_id && p.thread_id !== sessionId)) return;
  const event = entry.type === 'event_msg' ? p.type : '';
  const response = entry.type === 'response_item' ? p.type : '';
  if (response === 'message' && !['user','assistant'].includes(p.role)) return;
  if (response === 'message' && p.role === 'user' && Array.isArray(p.content)
    && p.content.some((item: any) => typeof item.text === 'string' && /^<(?:environment_context|codex_internal_context)\b/.test(item.text))) return;
  const activity = ['task_started','task_complete','turn_aborted','user_message','agent_message','agent_reasoning','exec_command_begin','exec_command_end','item_started','item_completed','request_user_input','exec_approval_request','apply_patch_approval_request','error'].includes(event)
    || ['message','reasoning','function_call','function_call_output','custom_tool_call','custom_tool_call_output','web_search_call','local_shell_call'].includes(response);
  const stamp = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
  if (!activity || !Number.isFinite(stamp)) return;
  if (!cursor.last || stamp > Date.parse(cursor.last)) cursor.last = new Date(stamp).toISOString();
  const turn = typeof p.turn_id === 'string' ? p.turn_id : 'current';
  if (event === 'task_started') { cursor.activeTurns.add(turn); cursor.state='running'; cursor.waitingCall=null; }
  if (event === 'task_complete' || event === 'turn_aborted') {
    cursor.activeTurns.delete(turn);
    cursor.state = cursor.activeTurns.size ? 'running' : event === 'task_complete' ? 'idle' : 'interrupted';
    cursor.waitingCall = null;
  }
  if (['request_user_input','exec_approval_request','apply_patch_approval_request'].includes(event)) cursor.state='waiting_for_input';
  if (response === 'function_call' || response === 'custom_tool_call') {
    if (/(?:^|[._])request_user_input$/.test(p.name || '')) {
      cursor.state='waiting_for_input'; cursor.waitingCall=p.call_id || null;
    } else { cursor.state='running'; }
  }
  if ((response === 'function_call_output' || response === 'custom_tool_call_output') && p.call_id === cursor.waitingCall) {
    cursor.waitingCall=null; cursor.state='running';
  }
  // A commentary/final message or token accounting is not a turn completion signal.
}

export async function readCodexRuntime(sessionId: string | null | undefined): Promise<CodexRuntime> {
  const unavailable = (reason: string): CodexRuntime => ({source:'codex_rollout',session_id:sessionId || null,state:'unknown',last_activity_at:null,observed_at:new Date().toISOString(),reason});
  if (!sessionId) return unavailable('尚未绑定 Codex 原生会话');
  const filePath = await findCodexRollout(sessionId);
  if (!filePath) return unavailable('未找到绑定的 Codex 原生记录');
  const pending = inFlight.get(filePath);
  if (pending) return pending;
  const work = (async () => {
    const file = await open(filePath,'r');
    try {
      const stats = await file.stat();
      let cursor = cursors.get(filePath);
      if (!cursor || cursor.inode !== stats.ino || stats.size < cursor.offset || (stats.size === cursor.offset && stats.mtimeMs !== cursor.mtime)) cursor=freshCursor();
      if (stats.size !== cursor.offset) {
        const start = Math.max(cursor.offset,stats.size-MAX_READ);
        const buffer = Buffer.alloc(stats.size-start);
        const {bytesRead} = await file.read(buffer,0,buffer.length,start);
        let bytes = start === cursor.offset ? Buffer.concat([cursor.partial,buffer.subarray(0,bytesRead)]) : buffer.subarray(0,bytesRead);
        if (start > cursor.offset) { cursor=freshCursor(); bytes=bytes.subarray(bytes.indexOf(10)+1); }
        const end = bytes.lastIndexOf(10);
        const lines = end < 0 ? [] : bytes.subarray(0,end).toString('utf8').split('\n');
        cursor.partial = Buffer.from(bytes.subarray(end+1));
        for (const line of lines) {
          try { applyRecord(cursor,JSON.parse(line),sessionId); } catch { /* Concurrent writes/partial records are retried on append. */ }
        }
        if (cursor.partial.length > 256 * 1024) cursor.partial=Buffer.alloc(0);
        cursor.offset=start+bytesRead; cursor.inode=stats.ino; cursor.mtime=stats.mtimeMs;
        if (cursors.size >= 256 && !cursors.has(filePath)) cursors.delete(cursors.keys().next().value!);
        cursors.set(filePath,cursor);
      }
      return {source:'codex_rollout' as const,session_id:sessionId,state:cursor.state,last_activity_at:cursor.last,observed_at:new Date().toISOString(),
        reason:cursor.last ? '依据 Codex 原生执行事件；本轮结束不代表业务任务验收完成' : '原生记录尚无可识别的执行事件'};
    } finally {await file.close();}
  })().catch(()=>unavailable('Codex 原生记录暂时无法读取')).finally(()=>inFlight.delete(filePath));
  inFlight.set(filePath,work);
  return work;
}
