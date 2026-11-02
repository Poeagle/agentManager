import {nanoid} from 'nanoid';
import {getDb} from '../db/index.js';

function moveHistoricalLinks(from:string,to:string) {
  const db=getDb();
  for(const table of ['tasks','scheduled_task_runs','platform_ai_tasks']){
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))db.prepare(`UPDATE ${table} SET session_id=? WHERE session_id=?`).run(to,from);
  }
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
    db.prepare('UPDATE conversation_attachments SET session_id=? WHERE session_id=?').run(historyId,sessionId);
    db.prepare('UPDATE events SET session_id=? WHERE session_id=?').run(historyId,sessionId);
    moveHistoricalLinks(sessionId,historyId);
    db.prepare("UPDATE sessions SET task='新会话',codex_session_id=?,claude_session_id=NULL,status='cancelled',pid=NULL,external_socket=NULL,started_at=NULL,completed_at=NULL,exit_code=NULL,created_at=datetime('now'),updated_at=datetime('now') WHERE id=?").run(nativeId,sessionId);
  })();
}

export function restoreConversationSnapshot(sessionId:string,historyId:string) {
  const db=getDb();db.transaction(()=>{
    db.prepare('DELETE FROM conversation_attachments WHERE session_id=?').run(sessionId);
    db.prepare('UPDATE conversation_attachments SET session_id=? WHERE session_id=?').run(sessionId,historyId);
    db.prepare('UPDATE events SET session_id=? WHERE session_id=?').run(sessionId,historyId);
    moveHistoricalLinks(historyId,sessionId);
    db.prepare('UPDATE sessions SET task=(SELECT task FROM sessions WHERE id=?),codex_session_id=(SELECT codex_session_id FROM sessions WHERE id=?),created_at=(SELECT created_at FROM sessions WHERE id=?),status=\'cancelled\',pid=NULL WHERE id=?').run(historyId,historyId,historyId,sessionId);
    db.prepare('DELETE FROM pty_output WHERE session_id=?').run(historyId);
    db.prepare('DELETE FROM sessions WHERE id=?').run(historyId);
  })();
}
