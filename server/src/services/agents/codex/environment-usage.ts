import {getDb} from '../../../db/index.js';
import {savedSessionTabs,removeSessionTabs} from '../../session-tabs.js';
import {nativeConversationId} from '../../session-identity.js';
import {engineForEnvironment} from './environments.js';
import {runInCodexEngine} from './engine-context.js';
import {withCodexConnection} from './stream.js';
const activeStatuses=new Set(['pending','launching','running','detached','released']);
export interface EnvironmentTab {id:string;user_id:string|null;username:string;project_id:string|null;project_name:string;name:string;status:string;native_id:string|null;model:string|null;busy:boolean|null}
export function environmentTabs(id:string):EnvironmentTab[] {
 const rows=getDb().prepare(`SELECT s.*,u.username,p.name project_name FROM sessions s LEFT JOIN users u ON u.id=s.created_by_user_id LEFT JOIN projects p ON p.id=s.project_id WHERE COALESCE(s.agent_id,s.cli_type)='codex' AND COALESCE(s.agent_environment_id,'native')=?`).all(id) as any[];
 const saved=new Map(savedSessionTabs().map(tab=>[tab.sessionId,tab]));return rows.filter(row=>activeStatuses.has(row.status)||saved.has(row.id)).map(row=>({id:row.id,user_id:row.created_by_user_id,username:row.username||'未绑定用户',project_id:row.project_id,project_name:row.project_name||'无项目',name:saved.get(row.id)?.name||row.task?.slice(0,100)||row.id,status:row.status,native_id:nativeConversationId(row),model:null,busy:row.status==='pending'||row.status==='launching'?true:null}));
}
export async function environmentUsage(id:string):Promise<{tabs:EnvironmentTab[];busy:boolean;verified:boolean}> {
 const tabs=environmentTabs(id);if(!tabs.length)return {tabs,busy:false,verified:true};
 for(const tab of tabs)if(!tab.native_id)tab.busy=activeStatuses.has(tab.status);
 const bound=tabs.filter(tab=>tab.native_id);
 if(!bound.length)return {tabs,busy:tabs.some(tab=>tab.busy===true),verified:true};
 try{
  const engine=await engineForEnvironment(id);
  await runInCodexEngine(engine,()=>withCodexConnection(async request=>{
   for(const tab of bound){
    try{const result=await request('thread/read',{threadId:tab.native_id});tab.busy=result.thread?.status?.type==='active';tab.model=result.thread?.model||null;}catch{tab.busy=null;}
   }
  }));
 }catch{/* Unknown execution state blocks mutation but never hides occupying tabs. */}
 return {tabs,busy:tabs.some(tab=>tab.busy===true),verified:tabs.every(tab=>tab.busy!==null)};
}
export async function assertEnvironmentIdle(id:string):Promise<void>{const usage=await environmentUsage(id);if(usage.busy||!usage.verified)throw Object.assign(Error(usage.busy?'该 Provider 有任务正在执行，请等待完成后再调整或重启':'无法确认占用标签页的执行状态，请先检查连接或关闭相关标签页'),{statusCode:409});}
export function assertEnvironmentUnused(id:string):void {const tabs=environmentTabs(id);if(tabs.length)throw Object.assign(Error(`该 Provider 仍有 ${tabs.length} 个标签页被用户使用，请先关闭所有相关标签页`),{statusCode:409});}
export async function closeEnvironmentTabs(id:string,ids:string[]):Promise<Array<{id:string;ok:boolean;error?:string}>> {
 const {killSession,waitForStoppedSessionLifecycle,isSessionActive}=await import('../../session-manager.js');
 const allowed=new Set(environmentTabs(id).map(tab=>tab.id));if(ids.some(id=>!allowed.has(id)))throw Object.assign(Error('所选标签页不属于此 Provider 或已关闭，请刷新列表'),{statusCode:409});
 const results:Array<{id:string;ok:boolean;error?:string}>=[];
 for(const sessionId of ids){try{await killSession(sessionId);await waitForStoppedSessionLifecycle(sessionId);if(isSessionActive(sessionId))throw Error('后台会话仍未停止');removeSessionTabs(sessionId);results.push({id:sessionId,ok:true});}catch{results.push({id:sessionId,ok:false,error:'停止会话失败，标签页已保留，请检查后台状态后重试'});}}
 return results;
}
