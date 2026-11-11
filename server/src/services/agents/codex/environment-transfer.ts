import {getDb} from '../../../db/index.js';
import {assertEnvironmentUse,canControlEnvironment,environmentAccessChanged} from '../environment-access.js';
import {getSession,newSessionConversation} from '../../session-manager.js';
import {nativeConversationId} from '../../session-identity.js';
import {engineForThread,runInCodexEngine} from './engine-context.js';
import {withCodexConnection} from './stream.js';
import {engineForEnvironment,getCodexEnvironment,sessionEnvironmentId,environmentConnection} from './environments.js';
import {stageEnvironmentHistory} from './account-files.js';
import {preparePagedHistory} from './history-bundle.js';
import {findCodexRollout} from '../../prompt-context.js';
import {checkAccountProject,accountCommand} from './account-transport.js';
import {readEngineModelsForEnvironment} from './controls.js';
import type {ModelPreference} from '../types.js';
import {recordUsageImports,recordUsageFork} from './usage-provenance.js';

/** Fork the full native rollout, never seed a lossy user/assistant summary.
 * The existing tab lifecycle supplies serialization, history snapshots and
 * rollback; a failed target is never made the active binding. */
export async function transferCodexEnvironment(sessionId:string,userId:string,targetId:string,preference:ModelPreference) {
 const original=getSession(sessionId);
 if(!original||original.cli_type!=='codex'||original.created_by_user_id!==userId)throw Object.assign(Error('只能切换自己创建的 Codex 标签页'),{statusCode:403});
 const sourceId=sessionEnvironmentId(original);assertEnvironmentUse('codex',sourceId,userId);assertEnvironmentUse('codex',targetId,userId);
 if(!canControlEnvironment(targetId,userId))throw Object.assign(Error('该环境尚未授予你会话控制权限'),{statusCode:403});
 const native=nativeConversationId(original);if(!native)throw Object.assign(Error('会话尚未绑定 Codex，请先恢复会话'),{statusCode:409});
 const target=getCodexEnvironment(targetId);let fresh:string|undefined;
 let paged:Awaited<ReturnType<typeof preparePagedHistory>>|undefined;
 const targetEngine=await engineForEnvironment(targetId);
 const result=await newSessionConversation(sessionId,undefined,{environmentId:targetId,prepare:async context=>{
  const assertAccess=()=>{assertEnvironmentUse('codex',sourceId,userId);assertEnvironmentUse('codex',targetId,userId);};assertAccess();
  const sourceEngine=await engineForThread(native);
  // Keep one source connection alive while preparing the target. A persisted
  // thread may be unloaded when its last terminal disconnected.
  return runInCodexEngine(sourceEngine,()=>withCodexConnection(async sourceRequest=>{
  const before=await sourceRequest('thread/read',{threadId:native});
  if(before.thread?.status?.type==='active')throw Error('当前任务仍在执行，请等待本轮结束后切换 Codex 环境');
  if(!before.thread)throw Error('原会话不存在或无法读取，原会话保持不变');
  const models=await readEngineModelsForEnvironment(targetId,true);
  const choice=models.find(m=>m.model===preference.model&&(!preference.provider||m.provider===preference.provider));
  if(!choice||!choice.efforts.some(e=>e.value===preference.effort))throw Error('目标环境不支持所选模型或推理强度，请重新预检模型列表');
  if(preference.service_tier!==undefined&&preference.service_tier!=='default'&&!choice.service_tiers?.some(t=>t.id===preference.service_tier))throw Error('目标模型不支持该服务档位');
  if(target.kind==='account') {
   await checkAccountProject(environmentConnection(target),context.projectPath!);
   const attachments=getDb().prepare('SELECT attachments FROM conversation_attachments WHERE session_id=?').all(sessionId) as Array<{attachments:string}>;
   const paths=[...new Set(attachments.flatMap(row=>{try{return (JSON.parse(row.attachments) as Array<{path:string}>).map(x=>x.path);}catch{return [];}}))];
   if(paths.length)await accountCommand(environmentConnection(target),`import os,sys\npaths=${JSON.stringify(paths)}\nif any(not os.path.isfile(p) or not os.access(p,os.R_OK) for p in paths):sys.exit('PROJECT_ACCESS')\nprint('ok')`);
  }
  const source=before.thread.historyMode==='paginated'?before.thread.path:await findCodexRollout(native);if(typeof source!=='string'||!source.startsWith('/'))throw Error('找不到可完整复制的原生会话历史，原会话保持不变');
  const settings=await sourceRequest('thread/resume',{threadId:native,excludeTurns:true});
  const sandbox=({readOnly:'read-only',workspaceWrite:'workspace-write',dangerFullAccess:'danger-full-access'} as Record<string,string>)[settings.sandbox?.type];
  if(!sandbox||!settings.approvalPolicy)throw Error('无法确认原会话权限，迁移尚未执行');
  if(sandbox==='read-only'&&settings.sandbox.networkAccess===true)throw Error('该只读会话包含自定义网络权限，暂不能完整复制权限配置，原会话保持不变');
  if(before.thread.historyMode==='paginated')paged=await preparePagedHistory(sourceId,source,targetId);
  if(paged)recordUsageImports(targetId,paged.importedIds);
  const forkBoundary=new Date().toISOString();
  const staged=paged?{path:paged.path,cleanup:async()=>{}}:await stageEnvironmentHistory(targetId,source);
  try {
   fresh=await runInCodexEngine(targetEngine,()=>withCodexConnection(async request=>{
    const fork=await request('thread/fork',{threadId:native,path:staged.path,model:choice.model,...choice.provider?{modelProvider:choice.provider}:{},cwd:context.projectPath,approvalPolicy:settings.approvalPolicy,sandbox,...settings.approvalsReviewer?{approvalsReviewer:settings.approvalsReviewer}:{},...preference.service_tier!==undefined?{serviceTier:preference.service_tier}:settings.serviceTier?{serviceTier:settings.serviceTier}:{},deferGoalContinuation:true,excludeTurns:true,...settings.runtimeWorkspaceRoots?{runtimeWorkspaceRoots:settings.runtimeWorkspaceRoots}:{},config:{model_reasoning_effort:preference.effort,...sandbox==='workspace-write'?{sandbox_workspace_write:{writable_roots:settings.sandbox.writableRoots||[],network_access:settings.sandbox.networkAccess===true,exclude_tmpdir_env_var:settings.sandbox.excludeTmpdirEnvVar===true,exclude_slash_tmp:settings.sandbox.excludeSlashTmp===true}}:{}}});
    const id=fork.thread?.id;if(typeof id!=='string'||id===native)throw Error('目标引擎未创建独立的历史副本');
    fresh=id;
    recordUsageFork(targetId,id,forkBoundary);
    const verified=await request('thread/resume',{threadId:id,model:choice.model,excludeTurns:true});
    if(verified.thread?.id!==id||verified.thread?.status?.type==='notLoaded'||(verified.model||verified.thread?.model)!==choice.model)throw Error('目标会话恢复或模型验证失败，原会话保持不变');
    // Only generated import identities are archived. Their files remain as
    // immutable ancestors of the new fork; original account history is intact.
    for(const imported of paged?.importedIds||[])await request('thread/archive',{threadId:imported}).catch(()=>{});
    return id;
   }));
   const after=await sourceRequest('thread/read',{threadId:native});
   if(after.thread?.status?.type==='active')throw Error('迁移期间原会话开始了新任务，已取消切换，请等待本轮完成后重试');
   assertAccess();return fresh!;
  }finally{await staged.cleanup();}
  }));
 }});
 if(paged)await paged.finish(Boolean(fresh));
 if(!result.ok&&fresh)await runInCodexEngine(targetEngine,()=>withCodexConnection(request=>request('thread/archive',{threadId:fresh}))).catch(()=>{});
 if(result.ok)environmentAccessChanged();
 return result;
}
