import {withCodexConnection} from './conversation-stream.js';

/** Native RPCs only: no PTY keystrokes and no synthetic model turn. */
export async function compactCodexConversation(threadId:string) {
  await withCodexConnection(async request=>{
    const {thread}=await request('thread/read',{threadId});
    if(thread?.status?.type!=='idle')throw Error('请等待当前任务完成后再压缩会话');
    await request('thread/compact/start',{threadId});
  });
}

/** Persist an otherwise empty thread without generating a reply. The native
 * client cannot resume an empty thread until its rollout has been flushed. */
export async function prepareFreshCodexConversation(threadId:string,cwd:string) {
  return withCodexConnection(async request=>{
    const current=await request('thread/read',{threadId});
    if(!current.thread||current.thread.status?.type==='notLoaded')throw Error('请先重载标签页以接入实时控制');
    const settings=await request('thread/resume',{threadId});
    const sandbox=({readOnly:'read-only',workspaceWrite:'workspace-write',dangerFullAccess:'danger-full-access'} as Record<string,string>)[settings.sandbox?.type];
    if(!['read-only','workspace-write','danger-full-access'].includes(sandbox)||!settings.approvalPolicy)throw Error('无法确认原会话权限，原会话已保留');
    if(sandbox==='read-only'&&settings.sandbox.networkAccess===true)throw Error('此只读会话有自定义网络权限，请在原始终端新开会话');
    const result=await request('thread/start',{
      cwd,model:current.thread.model,modelProvider:current.thread.modelProvider,
      approvalPolicy:settings.approvalPolicy,sandbox,...settings.approvalsReviewer?{approvalsReviewer:settings.approvalsReviewer}:{},...settings.serviceTier?{serviceTier:settings.serviceTier}:{},
      ...(settings.runtimeWorkspaceRoots?{runtimeWorkspaceRoots:settings.runtimeWorkspaceRoots}:{}),
      config:{...(current.thread.reasoningEffort?{model_reasoning_effort:current.thread.reasoningEffort}:{}),
        ...(sandbox==='workspace-write'?{sandbox_workspace_write:{writable_roots:settings.sandbox.writableRoots||[],network_access:settings.sandbox.networkAccess===true,exclude_tmpdir_env_var:settings.sandbox.excludeTmpdirEnvVar===true,exclude_slash_tmp:settings.sandbox.excludeSlashTmp===true}}:{})},
    });
    const id=result.thread?.id;
    if(typeof id!=='string'||!/^[a-f0-9-]{36}$/i.test(id)||id===threadId)throw Error('新会话未创建，原会话已保留');
    try {
      await request('thread/inject_items',{threadId:id,items:[{type:'message',role:'developer',content:[{type:'input_text',text:'A fresh conversation was opened in this platform tab. Wait for the user to provide a task. Previous conversation history has not been carried over.'}]}]});
      const verified=await request('thread/resume',{threadId:id});
      if(verified.thread?.id!==id||verified.thread?.status?.type==='notLoaded')throw Error('新会话尚不可恢复');
      return id;
    } catch(error){await request('thread/archive',{threadId:id}).catch(()=>{});throw error;}
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
