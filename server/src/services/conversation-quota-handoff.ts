import {setTimeout as delay} from 'node:timers/promises';
import {isAdmin,userCanUseSessionTool} from '../auth.js';
import {prepareBriefSend,type BriefPayload} from '../shared/conversation-brief.js';
import {rebindActiveAgentDocsBatches} from './agent-docs-batches.js';
import {canUseSessionEnvironment} from './agents/environment-access.js';
import {agentForSession} from './agents/index.js';
import {sessionAgentContext} from './agents/session.js';
import {AgentQuotaExhaustedError,AgentSubmissionError} from './agents/submission.js';
import {decorateConversationAttachments} from './conversation-attachments.js';
import {linkConversationInputs} from './conversation-input-links.js';
import {readConversation} from './conversation-reader.js';
import {RetrySuperseded,type ConversationRetry} from './conversation-retry.js';
import {broadcastEphemeral} from './event-store.js';
import {userHasPermission} from './rbac.js';
import {nativeConversationId} from './session-identity.js';
import {getSession,newSessionConversation,type Session} from './session-manager.js';

function canHandoff(session: Session,userId: string) {
  return ['running','detached','released'].includes(session.status) &&
    session.created_by_user_id===userId && isAdmin(userId) &&
    userHasPermission(userId,'agent_api','write') &&
    userCanUseSessionTool(userId,session.id,agentForSession(session).descriptor.id,session.mode==='terminal'?'terminal':'session') &&
    canUseSessionEnvironment(session,userId);
}

function historyBinding(session: Session) {
  return {...session,cli_type:session.cli_type??null,codex_session_id:session.codex_session_id??null,
    claude_session_id:session.claude_session_id??null,project_path:sessionAgentContext(session).projectPath??null};
}

export function matchesQuotaHandoff(session: Session,error: unknown): boolean {
  return agentForSession(session).quota.exhausted?.(sessionAgentContext(session),error)===true;
}

/** Change only the authenticated tab binding, after the brief and the source
 * checks are ready. The existing lifecycle owns rollback and source history. */
export async function switchExhaustedConversation(
  session: Session,userId: string,payload: BriefPayload,
  options: {definitiveError?:boolean; failedTurn?:{id:string; clientIds:Array<string|null>}; visited?:ReadonlySet<string>; verify?:()=>Promise<void>} = {},
) {
  const adapter=agentForSession(session),native=nativeConversationId(session),environment=session.agent_environment_id||'native';
  const context=sessionAgentContext(session,{actorUserId:userId});
  const validateSource=()=>{
    const current=getSession(session.id);
    if(!current||!native||!canHandoff(current,userId)||nativeConversationId(current)!==native||
       (current.agent_environment_id||'native')!==environment||current.project_id!==session.project_id||agentForSession(current)!==adapter)
      throw new RetrySuperseded('access_changed');
  };
  validateSource();
  if(options.definitiveError)adapter.quota.observeExhaustion?.(context);
  if(!adapter.lifecycle.prepareFreshInEnvironment)throw new RetrySuperseded('quota_no_account');
  const target=adapter.quota.alternateAccount?.(context);
  if(!target||target.id===environment||options.visited?.has(target.id))throw new RetrySuperseded('quota_no_account');
  const binding=historyBinding(session);
  let prepared:BriefPayload;
  let failedInputFound=false;
  try{
    prepared=await prepareBriefSend(session.id,native!,payload,async({before,limit})=>{
      const page=await readConversation(binding,{before,limit:Number(limit)});
      const messages=decorateConversationAttachments(session.id,linkConversationInputs(session.id,native!,page.messages));
      if(options.failedTurn&&messages.some(message=>message.role==='user'&&
        (message.turn_id===options.failedTurn!.id||!!message.client_id&&options.failedTurn!.clientIds.includes(message.client_id))))
        failedInputFound=true;
      return {...page,session_id:session.id,native_id:native,messages};
    },{allowEmpty:!options.failedTurn});
    // A first input can be explicitly rejected before the empty thread has a
    // rollout file. Verify that it really has no history before leading off.
  }catch(error){
    if(options.failedTurn)throw new RetrySuperseded('quota_brief_failed');
    const snapshot=await adapter.retry.inspect(native!);
    if(snapshot.state!=='idle'||snapshot.turn||snapshot.queued)throw error;
    prepared=payload;
  }
  if(options.failedTurn&&!failedInputFound)throw new RetrySuperseded('quota_brief_failed');
  const verify=async()=>{
    validateSource();
    await options.verify?.();
    if(adapter.quota.alternateAccount?.(context)?.id!==target.id)throw new RetrySuperseded('quota_no_account');
  };
  await verify();
  const fresh=await newSessionConversation(session.id,undefined,undefined,native!,target.id,
    {preserveHistory:true,verifySource:verify});
  if(!fresh.ok)throw new AgentSubmissionError(fresh.error||'账号切换失败，原会话已保留','rejected');
  const next=getSession(session.id),newNative=next&&nativeConversationId(next);
  if(!next||!newNative||newNative===native||(next.agent_environment_id||'native')!==target.id||
     next.project_id!==session.project_id||agentForSession(next)!==adapter||!canHandoff(next,userId))
    throw new RetrySuperseded('access_changed');
  rebindActiveAgentDocsBatches(session.id,native!,newNative,environment,target.id);
  broadcastEphemeral({type:'session.environment',session_id:session.id,project_id:session.project_id??undefined});
  return {session:next,nativeId:newNative,environmentId:target.id,payload:prepared};
}

const continuation='上一次执行因订阅账号额度耗尽而中断。请依据简要历史接续最后一项尚未完成的任务。先核对已完成和结果未确认的操作，避免重复执行，再继续剩余步骤。';

export async function resumeQuotaFailedTurn(job: ConversationRetry,current:()=>boolean) {
  const session=getSession(job.session_id);
  if(!session||!current()||!canHandoff(session,job.user_id)||nativeConversationId(session)!==job.native_id)
    throw new RetrySuperseded('access_changed');
  const adapter=agentForSession(session);
  const inspect=()=>adapter.retry.inspect(job.native_id);
  const assertFailed=(state: Awaited<ReturnType<typeof inspect>>)=>{
    if(!current())throw new RetrySuperseded('new_input');
    if(!state.turn || state.turn.id!==job.root_turn_id)throw new RetrySuperseded('newer_turn');
    if(state.state!=='idle')throw new RetrySuperseded('thread_busy');
    if(state.queued)throw new RetrySuperseded('queued_input');
    if(state.turn.has_final)throw new RetrySuperseded('final_answer');
    if(state.turn.status!=='failed'||!state.turn.quota_exhausted)throw new RetrySuperseded('turn_finished');
  };
  let state=await inspect();
  // The error notification can precede the terminal turn status.
  for(let attempt=0;attempt<10&&current()&&state.turn?.id===job.root_turn_id&&state.turn.status==='running';attempt++){
    await delay(500);
    state=await inspect();
  }
  assertFailed(state);
  const visited=new Set([session.agent_environment_id||'native']);
  let next=await switchExhaustedConversation(session,job.user_id,{input:continuation},{
    definitiveError:true,failedTurn:{id:job.root_turn_id,clientIds:state.turn!.user_client_ids},verify:async()=>assertFailed(await inspect()),
  });
  while(current()){
    visited.add(next.environmentId);
    const context=sessionAgentContext(next.session,{actorUserId:job.user_id});
    try {
      const sent=await adapter.input.submit(context,next.payload.input,job.client_id!,undefined,{immediate:true});
      if(sent!==true)throw new AgentSubmissionError('换号后的接续消息未被原生会话确认','rejected');
      return;
    }catch(error){
      if(!(error instanceof AgentQuotaExhaustedError)||!matchesQuotaHandoff(next.session,error))throw error;
      next=await switchExhaustedConversation(next.session,job.user_id,next.payload,{
        definitiveError:true,visited,verify:async()=>{if(!current())throw new RetrySuperseded('new_input');},
      });
    }
  }
  throw new RetrySuperseded('new_input');
}
