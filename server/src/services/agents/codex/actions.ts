import {submissionFailure,AgentSubmissionError} from '../submission.js';
import {runInCodexEngine,engineForProvider} from './engine-context.js';
import {validateModelPreference,readCodexModels} from './controls.js';
import type {ModelPreference} from '../types.js';
import {withCodexConnection,rememberStreamingSharedResources} from './stream.js';

/** Native RPCs only: no PTY keystrokes and no synthetic model turn. */
export async function compactCodexConversation(threadId:string) {
  let dispatched=false;
  await withCodexConnection(async request=>{
    const {thread}=await request('thread/read',{threadId});
    if(thread?.status?.type==='active')throw new AgentSubmissionError('当前任务仍在运行，请在本轮结束后压缩','rejected');
    if(!thread||thread.status?.type==='notLoaded')throw new AgentSubmissionError('会话未连接，压缩尚未启动，请先重连','rejected');
    // A failed/blocked native turn can leave systemError while the loaded
    // engine accepts /compact. Native RPC remains the authority for admission.
    dispatched=true;await request('thread/compact/start',{threadId});
  }).catch(error=>{throw submissionFailure(error,dispatched);});
}

/** Persist an otherwise empty thread without generating a reply. The native
 * client cannot resume an empty thread until its rollout has been flushed. */
export async function prepareFreshCodexConversation(threadId:string,cwd:string,sharedInstructions?:string,preference?:ModelPreference) {
  return withCodexConnection(async request=>{
    const current=await request('thread/read',{threadId});
    if(!current.thread)throw Error('原生会话不存在，历史已保留');
    const chosen=preference?await validateModelPreference(preference):undefined;
    if(!chosen&&!(await readCodexModels()).some(m=>m.model===current.thread.model&&(!m.provider||m.provider===current.thread.modelProvider)))throw Error('原模型当前不可用，请先选择新会话的模型');
    const settings=await request('thread/resume',{threadId,excludeTurns:true});
    const serviceTier=chosen?.service_tier??(chosen?.provider&&chosen.provider!==current.thread.modelProvider?'default':settings.serviceTier);
    const sandbox=({readOnly:'read-only',workspaceWrite:'workspace-write',dangerFullAccess:'danger-full-access'} as Record<string,string>)[settings.sandbox?.type];
    if(!['read-only','workspace-write','danger-full-access'].includes(sandbox)||!settings.approvalPolicy)throw Error('无法确认原会话权限，原会话已保留');
    if(sandbox==='read-only'&&settings.sandbox.networkAccess===true)throw Error('此只读会话有自定义网络权限，请在原始终端新开会话');
    return runInCodexEngine(engineForProvider(chosen?.provider||current.thread.modelProvider),()=>withCodexConnection(async target=>{
    const result=await target('thread/start',{
      cwd,model:chosen?.model||current.thread.model,modelProvider:chosen?.provider||current.thread.modelProvider,
      ...(sharedInstructions?{developerInstructions:sharedInstructions}:{}),
      approvalPolicy:settings.approvalPolicy,sandbox,...settings.approvalsReviewer?{approvalsReviewer:settings.approvalsReviewer}:{},...serviceTier?{serviceTier}:{},
      ...(settings.runtimeWorkspaceRoots?{runtimeWorkspaceRoots:settings.runtimeWorkspaceRoots}:{}),
      config:{...((chosen?.effort||current.thread.reasoningEffort)?{model_reasoning_effort:chosen?.effort||current.thread.reasoningEffort}:{}),
        ...(sandbox==='workspace-write'?{sandbox_workspace_write:{writable_roots:settings.sandbox.writableRoots||[],network_access:settings.sandbox.networkAccess===true,exclude_tmpdir_env_var:settings.sandbox.excludeTmpdirEnvVar===true,exclude_slash_tmp:settings.sandbox.excludeSlashTmp===true}}:{})},
    });
    const id=result.thread?.id;
    if(typeof id!=='string'||!/^[a-f0-9-]{36}$/i.test(id)||id===threadId)throw Error('新会话未创建，原会话已保留');
    try {
      await target('thread/inject_items',{threadId:id,items:[{type:'message',role:'developer',content:[{type:'input_text',text:'A fresh conversation was opened in this platform tab. Wait for the user to provide a task. Previous conversation history has not been carried over.'}]}]});
      const verified=await target('thread/resume',{threadId:id,excludeTurns:true});
      if(verified.thread?.id!==id||verified.thread?.status?.type==='notLoaded')throw Error('新会话尚不可恢复');
      if(sharedInstructions)rememberStreamingSharedResources(id,sharedInstructions);
      return id;
    } catch(error){await target('thread/archive',{threadId:id}).catch(()=>{});throw error;}
    }));
  });
}

/** Stop old background shells and release our subscription. Native app-server
 * reclaims unsubscribed thread memory after its own inactivity grace period.
 * Do not archive a user thread: that could also affect its descendant tabs. */
export async function releaseCodexConversation(threadId:string) {
  await withCodexConnection(async request=>{
    await request('thread/backgroundTerminals/clean',{threadId});
    await request('thread/unsubscribe',{threadId});
  });
}
