import {getDb} from '../../db/index.js';
import {readAgentManagement} from './management-store.js';

export interface EnvironmentRecord {id:string;agent_id:string;name:string;kind:string;enabled:number;config:string;allowed_user_ids:string|null}
export function environmentRecord(id:string):EnvironmentRecord|undefined {
  return getDb().prepare('SELECT * FROM agent_environments WHERE id=?').get(id) as EnvironmentRecord|undefined;
}
export function isRetiredEnvironment(id:string|null|undefined):boolean {
 if(!id)return false;const row=environmentRecord(id);if(!row)return false;try{return JSON.parse(row.config).retired===true;}catch{return false;}
}
/** Administrators can see and use every configured environment. Allow lists
 * restrict regular platform users; runtime availability is checked by the engine. */
export function canUseEnvironment(agentId:string,id:string|null|undefined,userId:string):boolean {
  if(!id)return true;
  if(isRetiredEnvironment(id))return false;
  const row=environmentRecord(id);
  if(row && row.agent_id!==agentId)return false;
  const admin=(getDb().prepare('SELECT role FROM users WHERE id=? AND disabled=0').get(userId) as {role:string}|undefined)?.role==='admin';
  if(!row && id!=='native' && !id.startsWith('provider:'))return false;
  if(id.startsWith('provider:')) {
    const provider=readAgentManagement(agentId).providers.find(p=>p.id===id.slice(9));
    if(!provider||!provider.enabled&&!admin)return false;
  }
  if(admin)return true;
  if(row&&!row.enabled)return false;
  if(row?.allowed_user_ids!==null&&row?.allowed_user_ids!==undefined) {
    try {const users:unknown=JSON.parse(row.allowed_user_ids);return Array.isArray(users)&&users.includes(userId);}catch{return false;}
  }
  return row?.kind!=='account';
}
export function assertEnvironmentUse(agentId:string,id:string,userId:string):void {
  if(!canUseEnvironment(agentId,id,userId))throw Object.assign(Error('无权使用该 Codex 环境，或环境已停用'),{statusCode:403});
}
export function canUseSessionEnvironment(session:{agent_id?:string|null;cli_type?:string|null;agent_environment_id?:string|null},userId:string):boolean {
  if(session.agent_environment_id&&isRetiredEnvironment(session.agent_environment_id)){const row=environmentRecord(session.agent_environment_id)!;const admin=(getDb().prepare('SELECT role FROM users WHERE id=? AND disabled=0').get(userId) as {role:string}|undefined)?.role==='admin';try{return admin||(JSON.parse(row.allowed_user_ids||'[]') as string[]).includes(userId);}catch{return admin;}}
  const agent=session.agent_id||session.cli_type||'claude';
  return canUseEnvironment(agent,session.agent_environment_id||(agent==='codex'?'native':null),userId);
}
export function validateEnvironmentUsers(value:unknown):string[]|null {
  if(value===null)return null;
  if(!Array.isArray(value)||value.length>200||value.some(id=>typeof id!=='string'||id.length>100))throw Object.assign(Error('使用者必须是平台用户 ID 列表'),{statusCode:400});
  const ids=[...new Set(value)] as string[];
  for(const id of ids)if(!getDb().prepare('SELECT 1 FROM users WHERE id=? AND disabled=0').get(id))throw Object.assign(Error('授权名单包含不存在或已停用的平台用户'),{statusCode:400});
  return ids;
}

export function canControlEnvironment(id:string,userId:string):boolean {
 if(!canUseEnvironment('codex',id,userId))return false;
 const row=environmentRecord(id);
 if(row?.allowed_user_ids!==null&&row?.allowed_user_ids!==undefined)return true;
 return (getDb().prepare('SELECT role FROM users WHERE id=?').get(userId) as {role:string}|undefined)?.role==='admin';
}

const environmentListeners=new Set<()=>void>();
export function environmentAccessChanged():void {for(const listener of [...environmentListeners])listener();}
export function watchSessionEnvironment(sessionId:string,userId:string,onChanged:()=>void):()=>void {
 const read=()=>getDb().prepare('SELECT agent_id,cli_type,agent_environment_id,native_session_id FROM sessions WHERE id=?').get(sessionId) as {agent_id:string|null;cli_type:string|null;agent_environment_id:string|null;native_session_id:string|null}|undefined;
 const original=read();
 const check=()=>{const next=read();if(!next||isRetiredEnvironment(next.agent_environment_id)||!canUseSessionEnvironment(next,userId)||next.agent_environment_id!==original?.agent_environment_id||next.native_session_id!==original?.native_session_id)onChanged();};
 environmentListeners.add(check);return ()=>{environmentListeners.delete(check);};
}
