import {readSessionCacheMissCost} from './session-statistics.js';
import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {getDb} from '../db/index.js';
import {isAdmin} from '../auth.js';
import {agentForSession} from './agents/index.js';
import {sessionAgentContext} from './agents/session.js';
import type {AgentSession} from './agents/types.js';
import {nativeConversationId} from './session-identity.js';
import {DEFAULT_SEND_GUARD,SEND_GUARD_KEY,validateSendGuard,evaluateSendGuard,usesAccountQuota} from './send-guard-policy.js';
const secret=randomBytes(32),TTL=5*60_000;
export function sendGuardPolicy(){const row=getDb().prepare('SELECT value FROM settings WHERE key=?').get(SEND_GUARD_KEY) as {value:string}|undefined;const value=row?JSON.parse(row.value):DEFAULT_SEND_GUARD;validateSendGuard(value);return value;}
function scope(session:AgentSession,userId:string,payload:unknown,policy=sendGuardPolicy()){return createHash('sha256').update(JSON.stringify([userId,session.id,nativeConversationId(session),policy,payload])).digest('hex');}
export function guardToken(session:AgentSession,userId:string,payload:unknown,now=Date.now(),policy=sendGuardPolicy()){
 const body=Buffer.from(JSON.stringify({scope:scope(session,userId,payload,policy),expires:now+TTL})).toString('base64url');return `${body}.${createHmac('sha256',secret).update(body).digest('base64url')}`;
}
export function validGuardToken(token:unknown,session:AgentSession,userId:string,payload:unknown,now=Date.now(),policy=sendGuardPolicy()){
 if(typeof token!=='string'||token.length>1000)return false;try{const parts=token.split('.');if(parts.length!==2)return false;const [body,signature]=parts;const actual=Buffer.from(signature||'','base64url'),expected=createHmac('sha256',secret).update(body).digest();if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return false;const data=JSON.parse(Buffer.from(body,'base64url').toString());return Number.isFinite(data.expires)&&data.expires>now&&data.expires<=now+TTL&&data.scope===scope(session,userId,payload,policy);}catch{return false;}
}
/** Read neutral telemetry, runtime and cached quota without changing the session. */
export async function inspectSendGuard(session:AgentSession,userId:string,payload:unknown,policy=sendGuardPolicy()){
 const adapter=agentForSession(session),context=sessionAgentContext(session,{actorUserId:userId});
 const now=Date.now();let usage:Awaited<ReturnType<typeof adapter.telemetry.read>>|null=null,runtime:Awaited<ReturnType<typeof adapter.runtime.read>>|null=null;
 if(policy.enabled&&context.nativeId){const results=await Promise.allSettled([adapter.telemetry.read(context),adapter.runtime.read(context)]);if(results[0].status==='fulfilled')usage=results[0].value;if(results[1].status==='fulfilled')runtime=results[1].value;}
 const finite=(value:unknown):number|null=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
 const tokens=finite(usage?.usage?.last.total_tokens),window=finite(usage?.usage?.window),percent=tokens!==null&&window&&window>0?Math.min(100,tokens/window*100):null;
 const idle=!!runtime&&['idle','interrupted','failed'].includes(runtime.state),last=idle&&runtime?.last_turn_ended_at?Date.parse(runtime.last_turn_ended_at):NaN;
 const idleMinutes=Number.isFinite(last)&&last<=now?(now-last)/60000:null;
 const needsQuota=policy.enabled&&(policy.reminder_enabled!==false&&usesAccountQuota(policy.conditions)||policy.automatic_rules?.some(rule=>rule.target||usesAccountQuota(rule.conditions)));
 let accountRemaining:number|null=null;
 try{if(needsQuota)accountRemaining=finite(adapter.quota.accountRemaining?.(context));}catch{/* No confirmed quota snapshot. */}
 const values={context_percent:percent,context_tokens:tokens,idle_minutes:runtime&&['running','waiting_for_input'].includes(runtime.state)?0:idleMinutes,account_remaining_percent:accountRemaining};
 const rule=policy.enabled?policy.automatic_rules?.find(rule=>evaluateSendGuard(rule.conditions,values)===true):undefined;
 const requiredAction=rule?.action??null;
 const matched=requiredAction?true:policy.enabled&&policy.reminder_enabled!==false?evaluateSendGuard(policy.conditions,values):false;
 const owned=session.created_by_user_id===userId,canTransform=isAdmin(userId)&&owned&&idle;
 const switchAccount=rule?.target==='available_account';
 let targetAccount:{id:string;label:string}|null=null;
 try{
  if(switchAccount&&canTransform&&adapter.descriptor.capabilities.newConversation&&adapter.lifecycle.prepareFreshInEnvironment)
   targetAccount=adapter.quota.alternateAccount?.(context)??null;
 }catch{/* No authorized candidate with confirmed quota. */}
 const inputTokens=finite(usage?.usage?.last.input_tokens);
 const cachedTokens=finite(usage?.usage?.last.cached_input_tokens);
 const cacheMissEstimate=matched===true&&!requiredAction&&inputTokens!==null&&Number.isSafeInteger(inputTokens)
   &&cachedTokens!==null&&Number.isSafeInteger(cachedTokens)&&cachedTokens>0&&cachedTokens<=inputTokens
  ? {tokens:cachedTokens,cost:readSessionCacheMissCost(context,inputTokens,cachedTokens)}
  : null;
 return {
  needs_confirmation:matched===true,
  required_action:requiredAction,
  switch_account:switchAccount,
  target_account:targetAccount,
  account_remaining_percent:accountRemaining,
  cache_miss_estimate:cacheMissEstimate,
  matched,enabled:policy.enabled,
  context_tokens:tokens,context_window:window,context_percent:percent,
  idle_minutes:idleMinutes,last_completed_at:idle?runtime?.last_turn_ended_at??null:null,
  observed_at:usage?.observed_at??null,native_id:context.nativeId,checked_at:new Date(now).toISOString(),
  can_compact:canTransform&&!!adapter.descriptor.capabilities.compact,
  can_new:canTransform&&!!adapter.descriptor.capabilities.newConversation,
  token:requiredAction?null:guardToken(session,userId,payload,now,policy),
 };
}

/** Confirmation can waive a reminder, even after usage changes. Automatic
 * rules are evaluated again inside the submission queue before dispatch. */
export async function checkSendGuardSubmission(session:AgentSession,userId:string,payload:unknown,token:unknown,queued=false){
 const policy=sendGuardPolicy();
 if(!policy.enabled&&token===undefined)return null;
 const valid=validGuardToken(token,session,userId,payload,Date.now(),policy);
 if(valid&&!(queued&&policy.enabled&&policy.automatic_rules?.length))return null;
 const check=await inspectSendGuard(session,userId,payload,policy);
 const policyChanged=JSON.stringify(policy)!==JSON.stringify(sendGuardPolicy());
 if(check.required_action||policyChanged)return check;
 return !valid&&(check.needs_confirmation||token!==undefined)?check:null;
}
