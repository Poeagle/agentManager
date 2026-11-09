import {getDb} from '../db/index.js';
import {broadcastEphemeral} from './event-store.js';
export interface SavedSessionTab {sessionId:string;userId:string;projectId:string;name:string}
export function savedSessionTabs():SavedSessionTab[] {
 const rows=getDb().prepare("SELECT user_id,key,value FROM user_ui_state WHERE key LIKE 'project:%'").all() as Array<{user_id:string;key:string;value:string}>;
 return rows.flatMap(row=>{try{const state=JSON.parse(row.value);return (Array.isArray(state.terminalInstances)?state.terminalInstances:[]).filter((tab:any)=>typeof tab?.id==='string').map((tab:any)=>({sessionId:tab.id,userId:row.user_id,projectId:row.key.slice(8),name:tab.customLabel||state.terminalLabels?.[tab.id]||tab.label||tab.id}));}catch{return [];}});
}
/** Remove saved browser tabs after the runtime has stopped; keep conversation data. */
export function removeSessionTabs(sessionId:string,scope?:{userId:string;projectId:string}):void {
 const rows=getDb().prepare("SELECT user_id,key,value FROM user_ui_state WHERE key LIKE 'project:%'").all() as Array<{user_id:string;key:string;value:string}>;
 for(const row of rows){const projectId=row.key.slice(8);if(scope&&(scope.userId!==row.user_id||scope.projectId!==projectId))continue;let state:any;try{state=JSON.parse(row.value);}catch{continue;}
  if(!Array.isArray(state.terminalInstances)||!state.terminalInstances.some((tab:any)=>tab?.id===sessionId))continue;
  state.terminalInstances=state.terminalInstances.filter((tab:any)=>tab?.id!==sessionId);if(state.terminalLabels)delete state.terminalLabels[sessionId];
  if(state.activeTerminalId===sessionId)state.activeTerminalId=state.terminalInstances[0]?.id||null;
  state.hiddenSessionIds=[...new Set([...(Array.isArray(state.hiddenSessionIds)?state.hiddenSessionIds:[]),sessionId])];
  getDb().prepare("UPDATE user_ui_state SET value=?,updated_at=datetime('now') WHERE user_id=? AND key=?").run(JSON.stringify(state),row.user_id,row.key);
  broadcastEphemeral({session_id:sessionId,project_id:projectId,type:'user.tab_state',data:{targetUserId:row.user_id,projectId,sessionId,action:'delete'}});
 }
}
