import {getDb} from '../db/index.js';
import {broadcastEphemeral} from './event-store.js';
export interface SavedSessionTab {sessionId:string;userId:string;projectId:string;name:string}
export function savedSessionTabs():SavedSessionTab[] {
 const rows=getDb().prepare("SELECT user_id,key,value FROM user_ui_state WHERE key LIKE 'project:%'").all() as Array<{user_id:string;key:string;value:string}>;
 return rows.flatMap(row=>{try{const state=JSON.parse(row.value);return (Array.isArray(state.terminalInstances)?state.terminalInstances:[]).filter((tab:any)=>typeof tab?.id==='string').map((tab:any)=>({sessionId:tab.id,userId:row.user_id,projectId:row.key.slice(8),name:tab.customLabel||state.terminalLabels?.[tab.id]||tab.label||tab.id}));}catch{return [];}});
}
/** Remove saved browser tabs after the runtime has stopped; keep conversation data. */
export function removeSessionTabs(sessionId:string,scope?:{userId:string;projectId:string}):void {
 const db=getDb();
 const rows=(scope
  ?db.prepare("SELECT ? AS user_id, ? AS key, coalesce((SELECT value FROM user_ui_state WHERE user_id=? AND key=?), '{}') AS value")
    .all(scope.userId,`project:${scope.projectId}`,scope.userId,`project:${scope.projectId}`)
  :db.prepare("SELECT user_id,key,value FROM user_ui_state WHERE key LIKE 'project:%'").all()) as Array<{user_id:string;key:string;value:string}>;
 for (const row of rows) {
  const projectId = row.key.slice(8);
  let state: Record<string, unknown> = {};
  try {
   const parsed = JSON.parse(row.value);
   if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) state = parsed;
  } catch { /* Recover invalid UI state. */ }
  const tabs = Array.isArray(state.terminalInstances) ? state.terminalInstances : [];
  const visible = tabs.some(tab => tab?.id === sessionId);
  if (!visible && !scope) continue;
  const hidden = Array.isArray(state.hiddenSessionIds) ? state.hiddenSessionIds : [];
  if (!visible && hidden.includes(sessionId)) continue;
  const remaining = tabs.filter(tab => tab?.id !== sessionId);
  if (Array.isArray(state.terminalInstances)) state.terminalInstances = remaining;
  if (state.terminalLabels && typeof state.terminalLabels === 'object') delete (state.terminalLabels as Record<string, unknown>)[sessionId];
  if (state.activeTerminalId === sessionId) state.activeTerminalId = remaining[0]?.id ?? null;
  state.hiddenSessionIds = [...new Set([...hidden, sessionId])];
  db.prepare("INSERT INTO user_ui_state(user_id,key,value,updated_at) VALUES(?,?,?,datetime('now')) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
   .run(row.user_id, row.key, JSON.stringify(state));
  broadcastEphemeral({session_id:sessionId,project_id:projectId,type:'user.tab_state',data:{targetUserId:row.user_id,projectId,sessionId,action:'delete'}});
 }
}

/** Store platform-created names using the same state that presents browser tabs. */
export function rememberNewTabName(sessionId: string, userId: string, projectId: string, name: string) {
 const db = getDb(), key = `project:${projectId}`;
 const row = db.prepare('SELECT value FROM user_ui_state WHERE user_id=? AND key=?').get(userId, key) as {value:string}|undefined;
 let state: Record<string, unknown> = {};
 try { state = JSON.parse(row?.value || '{}') || {}; } catch { /* Recover invalid UI state. */ }
 state.terminalLabels = {...(state.terminalLabels as Record<string,string> | undefined), [sessionId]: name};
 db.prepare("INSERT INTO user_ui_state(user_id,key,value,updated_at) VALUES(?,?,?,datetime('now')) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
  .run(userId,key,JSON.stringify(state));
 broadcastEphemeral({session_id:sessionId,project_id:projectId,type:'user.tab_state',data:{targetUserId:userId,projectId,sessionId,action:'rename',name}});
}
