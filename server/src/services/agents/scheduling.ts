import {getDb} from '../../db/index.js';
import {agentForSession,getAgent} from './index.js';
import type {AgentSession} from './types.js';
export interface AgentTaskTarget {
  target_type:string;
  new_cli_type?:string|null;
  new_mode?:string|null;
  target_session_id?:string|null;
}
function targetSession(target:AgentTaskTarget){
  return target.target_session_id?getDb().prepare('SELECT * FROM sessions WHERE id=?').get(target.target_session_id) as (AgentSession&{mode?:string|null})|undefined:undefined;
}
export function taskAgent(target:AgentTaskTarget){
  if(target.target_type==='new')return getAgent(target.new_cli_type||'claude');
  const session=targetSession(target);if(!session)throw Error('找不到任务目标会话');
  return agentForSession(session);
}
export function targetSupportsQuota(target:AgentTaskTarget):boolean {
  try{
    if(target.target_type==='new')return target.new_mode!=='terminal'&&taskAgent(target).descriptor.capabilities.quota;
    const session=targetSession(target);
    return !!session&&session.mode!=='terminal'&&agentForSession(session).descriptor.capabilities.quota;
  }catch{return false;}
}
