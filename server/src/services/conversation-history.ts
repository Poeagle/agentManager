import {storeAgentNativeId} from './agents/identity-store.js';
import type {AgentSession} from './agents/types.js';
import {nanoid} from 'nanoid';
import {getDb} from '../db/index.js';

function moveHistoricalLinks(from:string,to:string) {
  const db=getDb();
  for(const table of ['tasks','scheduled_task_runs','platform_ai_tasks']){
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))db.prepare(`UPDATE ${table} SET session_id=? WHERE session_id=?`).run(to,from);
  }
  db.prepare('UPDATE conversation_batches SET session_id=? WHERE session_id=?').run(to,from);
  db.prepare('UPDATE conversation_input_sources SET session_id=? WHERE session_id=?').run(to,from);
}

/** Preserve a recoverable history row before the old runtime is stopped. */
export function snapshotConversation(sessionId:string) {
  const db=getDb(),id=nanoid(12);
  db.transaction(()=>{
    const columns=(db.prepare('PRAGMA table_info(sessions)').all() as {name:string}[]).map(c=>`"${c.name}"`);
    db.prepare(`INSERT INTO sessions (${columns.join(',')}) SELECT ${columns.map(c=>c==='"id"'?'?':c).join(',')} FROM sessions WHERE id=?`).run(id,sessionId);
    db.prepare("UPDATE sessions SET status='cancelled',pid=NULL,external_socket=NULL,completed_at=datetime('now'),updated_at=datetime('now') WHERE id=?").run(id);
    db.prepare('INSERT INTO pty_output(session_id,seq,data,created_at) SELECT ?,seq,data,created_at FROM pty_output WHERE session_id=?').run(id,sessionId);
  })();
  return id;
}

export function activateFreshConversation(sessionId:string,historyId:string,nativeId:string) {
  const db=getDb();db.transaction(()=>{
    const session=db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId) as AgentSession&{id:string};storeAgentNativeId(session,nativeId);
    db.prepare(`INSERT OR IGNORE INTO conversation_input_links(session_id,native_id,client_id,input_hash,after_offset,message_id)
      SELECT ?,l.native_id,l.client_id,l.input_hash,l.after_offset,l.message_id FROM conversation_input_links l
      WHERE l.session_id=? AND (EXISTS (SELECT 1 FROM conversation_input_sources s WHERE s.session_id=l.session_id AND s.client_id=l.client_id) OR EXISTS (SELECT 1 FROM conversation_batches b WHERE b.session_id=l.session_id AND b.client_id=l.client_id))`).run(historyId,sessionId);
    db.prepare('UPDATE conversation_attachments SET session_id=? WHERE session_id=?').run(historyId,sessionId);
    db.prepare('UPDATE events SET session_id=? WHERE session_id=?').run(historyId,sessionId);
    moveHistoricalLinks(sessionId,historyId);
    db.prepare('UPDATE user_ui_state SET key=? WHERE key=?').run(`session-control:${historyId}`,`session-control:${sessionId}`);
    db.prepare("UPDATE sessions SET task='新会话',status='cancelled',pid=NULL,external_socket=NULL,started_at=NULL,completed_at=NULL,exit_code=NULL,created_at=datetime('now'),updated_at=datetime('now') WHERE id=?").run(sessionId);
  })();
}

export function restoreConversationSnapshot(sessionId:string,historyId:string) {
  const db=getDb();db.transaction(()=>{
    db.prepare('DELETE FROM conversation_attachments WHERE session_id=?').run(sessionId);
    db.prepare('DELETE FROM conversation_batches WHERE session_id=?').run(sessionId);
    db.prepare('DELETE FROM conversation_input_sources WHERE session_id=?').run(sessionId);
    db.prepare('UPDATE conversation_attachments SET session_id=? WHERE session_id=?').run(sessionId,historyId);
    db.prepare('UPDATE events SET session_id=? WHERE session_id=?').run(sessionId,historyId);
    moveHistoricalLinks(historyId,sessionId);
    db.prepare('DELETE FROM user_ui_state WHERE key=?').run(`session-control:${sessionId}`);
    db.prepare('UPDATE user_ui_state SET key=? WHERE key=?').run(`session-control:${sessionId}`,`session-control:${historyId}`);
    const columns=['agent_environment_id','task','agent_id','native_session_id','cli_type','codex_session_id','claude_session_id','created_at'];
    db.prepare(`UPDATE sessions SET ${columns.map(column=>`${column}=(SELECT ${column} FROM sessions WHERE id=?)`).join(',')},status='cancelled',pid=NULL WHERE id=?`).run(...columns.map(()=>historyId),sessionId);
    const restored=db.prepare('SELECT native_session_id,codex_session_id,claude_session_id FROM sessions WHERE id=?').get(sessionId) as {native_session_id:string|null;codex_session_id:string|null;claude_session_id:string|null};
    db.prepare('UPDATE conversation_input_links SET native_id=? WHERE session_id=?').run(restored.native_session_id||restored.codex_session_id||restored.claude_session_id,sessionId);
    db.prepare('DELETE FROM pty_output WHERE session_id=?').run(historyId);
    db.prepare('DELETE FROM sessions WHERE id=?').run(historyId);
  })();
}
