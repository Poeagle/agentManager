import type {FastifyInstance} from 'fastify';
import {createHash} from 'crypto';
import {customAlphabet} from 'nanoid';
import {getDb} from '../../db/index.js';
import {userCanUseSessionTool} from '../../auth.js';
import {agentForSession} from '../agents/index.js';
import {getSession,getLiveWorkAgent} from '../session-manager.js';
import {nativeConversationId} from '../session-identity.js';
import {getTracker} from '../session-state.js';
import {sessionPresenter} from '../session-labels.js';
import type {AgentTextMessage} from '../prompt-context.js';
import {ChannelError,compactText} from './channels.js';
import {platformApi,PlatformApiError,copyImagesToSession} from './tools.js';
import {messageAttachments,ownedImage,prepareImages} from './attachments.js';
import {formatTaskNotification,trackTask,type Conversation,type InboxMessage} from './store.js';
import {notificationInputBoundary,settleNotificationsForInput,markNotificationsRead} from '../notifications.js';

const token = customAlphabet('23456789abcdefghjkmnpqrstuvwxyz',12);
export const quotedReplyOperationId=(messageId:string)=>'quoted_'+messageId;
const ROUTE_TTL = 7*24*60*60*1000;
export interface ReplyTarget {session_id:string;native_id:string;environment_id:string;turn_key:string|null}
type ProjectNoticeAuthorizer=(key:string,conversationId:string)=>{channel_id:string;external_user_id:string;chat_id:string};
interface ReplyRoute extends ReplyTarget {id:string;notice_id:string;user_id:string;channel_id:string;external_user_id:string;chat_id:string;notice_key:string;expires_at:number}

/** Native references identify a request; ordinary web input falls back to its stable public record. */
export function replyTurnKey(message?:AgentTextMessage):string|null {
  if(!message)return null;
  if(message.task_reference)return 'ref:'+message.task_reference;
  return message.timestamp?'message:'+createHash('sha256').update(JSON.stringify([message.timestamp,message.text])).digest('hex'):null;
}
export function notificationReplyTarget(sessionId:string,turnKey:string|null):ReplyTarget|null {
  const session=getSession(sessionId),native=session&&nativeConversationId(session);
  return session&&native?{session_id:sessionId,native_id:native,environment_id:session.agent_environment_id||'native',turn_key:turnKey}:null;
}

/** WeCom quotes contain text, not the original message ID. Match the delivered
 * text within the authorized chat; ambiguous identical notices fail closed. */
function quoteHash(text: string): string {
  const normalized = text.replace(/\r\n?/g,'\n').replace(/^ {0,3}#{1,6}\s+/gm,'')
    .replace(/^[ \t]*[·•●][ \t]+/gm,'- ')
    .replace(/\[([^\]\n]+)\]\(https?:\/\/[^\s)]+\)/g,'$1').replace(/\*\*([^*]+)\*\*/g,'$1')
    .replace(/\\([\\`*_[\]<>])/g,'$1').replace(/`([^`\n]+)`/g,'$1').replace(/\s+/g,' ').trim();
  return createHash('sha256').update(normalized).digest('hex');
}

/** Called only after outbound authorization. Freeze the actual Markdown sent
 * in the existing outbox metadata so retries and renames keep quote identity. */
export function prepareReplyNotification(input:{noticeId:string;noticeKey:string;target:ReplyTarget;userId:string;channelId:string;externalUserId:string;chatId:string;content:string}):string {
  const db=getDb(),now=Date.now();
  db.prepare('DELETE FROM platform_ai_reply_routes WHERE expires_at<?').run(now);
  let route=db.prepare('SELECT * FROM platform_ai_reply_routes WHERE notice_id=?').get(input.noticeId) as ReplyRoute|undefined;
  if(!route){
    // Bound the mapping independently from history retention; old notifications then fail closed.
    db.prepare('DELETE FROM platform_ai_reply_routes WHERE id IN (SELECT id FROM platform_ai_reply_routes ORDER BY expires_at DESC LIMIT -1 OFFSET 9999)').run();
    const id=token();
    db.prepare(`INSERT INTO platform_ai_reply_routes(id,notice_id,notice_key,user_id,channel_id,external_user_id,chat_id,session_id,native_id,environment_id,turn_key,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,input.noticeId,input.noticeKey,input.userId,input.channelId,input.externalUserId,input.chatId,input.target.session_id,input.target.native_id,input.target.environment_id,input.target.turn_key,now+ROUTE_TTL);
    route=db.prepare('SELECT * FROM platform_ai_reply_routes WHERE id=?').get(id) as ReplyRoute;
  }
  if(route.user_id!==input.userId||route.channel_id!==input.channelId||route.external_user_id!==input.externalUserId||route.chat_id!==input.chatId)throw new ChannelError('通知接收身份或聊天已变化，请等待最新通知。',409,true);
  const session=getSession(route.session_id);
  const label=session?sessionPresenter(input.userId)(session):null;
  const name=[label?.project_name,label?.tab_name].filter(Boolean).join(' / ')||'工作会话';
  const row=db.prepare('SELECT reply_context FROM platform_ai_outbox WHERE id=?').get(input.noticeId) as {reply_context:string};
  const metadata=JSON.parse(row.reply_context);
  const content=metadata.wecom_quote_text||compactText(input.content.startsWith(formatTaskNotification(name,''))?input.content:formatTaskNotification(name,input.content),4000);
  db.prepare("UPDATE platform_ai_outbox SET reply_context=json_set(reply_context,'$.wecom_quote_text',?,'$.wecom_quote_hash',?) WHERE id=?").run(content,quoteHash(content),input.noticeId);
  return content;
}

export function quotedReplyRoute(text:string,identity?:{channelId:string;externalUserId:string;chatId:string}):string {
  if(text.length>24000)throw new ChannelError('引用内容过长，请只引用一条任务通知。',400,true);
  if(identity){
    const routes=getDb().prepare(`SELECT r.id FROM platform_ai_reply_routes r
      JOIN platform_ai_outbox o ON o.id=r.notice_id
      JOIN platform_ai_bindings b ON b.channel_id=r.channel_id AND b.external_user_id=r.external_user_id AND b.user_id=r.user_id
      WHERE r.channel_id=? AND r.external_user_id=? AND r.chat_id=? AND r.expires_at>=?
      AND o.status IN ('sending','sent','pending') AND json_extract(o.reply_context,'$.wecom_quote_hash')=? LIMIT 2`)
      .all(identity.channelId,identity.externalUserId,identity.chatId,Date.now(),quoteHash(text)) as Array<{id:string}>;
    if(routes.length===1)return routes[0].id;
    if(routes.length>1)throw new ChannelError('引用内容对应多条相同通知，无法确定原轮次，请打开原标签页回复。',409,true);
  }
  // Exact delivered content wins over marker-like text inside the Agent body.
  // Old visible headers remain readable until their seven-day routes expire.
  const tokens=[...new Set([...text.matchAll(/(?:^|\n)【[^\r\n】]{1,160} · AM-([23456789abcdefghjkmnpqrstuvwxyz]{12})】/g)].map(match=>match[1]))];
  if(tokens.length>1)throw new ChannelError('引用了多个通知目标，请只引用一条通知回复。',400,true);
  if(tokens.length===1&&text.startsWith('【'))return tokens[0];
  throw new ChannelError('这条引用没有可识别的通知关联，请引用最新通知或打开原标签页回复。',400,true);
}

/** Does not invoke a model or retry a possibly submitted write. Durable operation records fence restarts. */
export async function dispatchQuotedReply(app:FastifyInstance,conversation:Conversation,message:InboxMessage,authorizeProjectNotice:ProjectNoticeAuthorizer,assertAuthorized:()=>void,signal?:AbortSignal):Promise<string> {
  const id=JSON.parse(message.reply_context).direct_route;
  const route=getDb().prepare('SELECT * FROM platform_ai_reply_routes WHERE id=?').get(id) as ReplyRoute|undefined;
  if(!route||route.expires_at<Date.now())throw new ChannelError('通知关联已过期，请打开原标签页或引用最新通知。',409,true);
  if(route.user_id!==conversation.user_id||route.channel_id!==conversation.channel_id||route.external_user_id!==conversation.external_user_id||route.chat_id!==conversation.external_chat_id)throw new ChannelError('这条通知不属于当前用户或聊天，未投递。',403,true);
  const operationId=quotedReplyOperationId(message.id);
  const previous=getDb().prepare('SELECT status,result FROM platform_ai_operations WHERE id=?').get(operationId) as {status:string;result:string|null}|undefined;
  if(previous)return previous.status==='done'&&previous.result?previous.result:'上次投递结果待核对，为避免重复执行，未再次发送。请查看原标签页。';
  const sourceTaskId=route.notice_key.startsWith('task:')?route.notice_key.split(':')[1]:null;
  const assertSource=()=>{
    // Project rules and tracked tasks remain the source of notification authorization.
    if(route.notice_key.startsWith('project-notice:')){
      const recipient=authorizeProjectNotice(route.notice_key,(getDb().prepare('SELECT conversation_id FROM platform_ai_outbox WHERE id=?').get(route.notice_id) as {conversation_id:string}|undefined)?.conversation_id||'');
      if(recipient.channel_id!==route.channel_id||recipient.external_user_id!==route.external_user_id||recipient.chat_id!==route.chat_id)throw new ChannelError('通知接收绑定已变化，请引用最新通知。',403,true);
    }
    if(sourceTaskId){
      const task=getDb().prepare('SELECT status FROM platform_ai_tasks WHERE id=?').get(sourceTaskId) as {status:string}|undefined;
      if(!task||['cancelled','superseded','suspended','failed'].includes(task.status))throw new ChannelError('原任务已停止或被替代，请引用最新通知。',409,true);
    }
  };
  assertSource();
  const checkSession=()=>{
    const session=getSession(route.session_id);
    if(!session||nativeConversationId(session)!==route.native_id||(session.agent_environment_id||'native')!==route.environment_id)throw new ChannelError('标签页已更换对话或账号，旧通知不能继续回复，请引用最新通知。',409,true);
    if(session.created_by_user_id!==conversation.user_id||!userCanUseSessionTool(conversation.user_id,session.id,agentForSession(session).descriptor.id,session.mode==='terminal'?'terminal':'session'))throw new ChannelError('当前账号已无权向该标签页发送消息。',403,true);
    return session;
  };
  let session=checkSession();
  if(!route.turn_key)throw new ChannelError('原通知缺少任务轮次依据，请打开标签页核对后回复。',409,true);
  await prepareImages(message.id,signal);
  const attachments=messageAttachments(message.id);
  if(attachments.some(image=>image.status!=='ready'))throw new ChannelError('图片接收失败，文字和图片均未投递，请重新发送。',400,true);
  assertAuthorized();assertSource();session=checkSession();
  const images=attachments.map(image=>ownedImage(image.id,conversation.user_id,conversation.id));
  if(images.some(image=>!image))throw new ChannelError('图片不可用或无权访问，文字和图片均未投递。',403,true);
  let imagePrompt:string;
  try{imagePrompt=await copyImagesToSession(app,conversation.user_id,session.id,images.filter(image=>image!==undefined));}
  catch{throw new ChannelError('图片保存到会话失败，文字和图片均未投递，请重新发送。',400,true);}
  const native=await platformApi(app,conversation.user_id,'GET',`/api/sessions/${encodeURIComponent(session.id)}/agent-messages`);
  const latest=[...(native.messages||[])].reverse().find((m:AgentTextMessage)=>m.role==='user');
  if(replyTurnKey(latest)!==route.turn_key)throw new ChannelError('标签页已经进入其他任务轮次，请引用最新通知，未投递。',409,true);
  const display=await platformApi(app,conversation.user_id,'GET',`/api/sessions/${encodeURIComponent(session.id)}/display?lines=1`);
  if(getTracker(session.id)?.state.isPermission||['confirmation','choice'].includes(display.promptType))throw new ChannelError('该标签页正在等待授权或交互选择，请在网页处理；本条文字未投递。',409,true);
  if(session.mode==='terminal'&&!await getLiveWorkAgent(session.id))throw new ChannelError('标签页当前没有运行工作 Agent，请先恢复会话。',409,true);
  session=checkSession();
  assertAuthorized();
  assertSource();
  if(signal?.aborted)throw new Error('图片回复处理已暂停');
  const active=getDb().prepare("SELECT id FROM platform_ai_tasks WHERE session_id=? AND status IN ('running','blocked','uncertain')").get(session.id) as {id:string}|undefined;
  if(sourceTaskId&&active&&active.id!==sourceTaskId)throw new ChannelError('标签页已有更新的任务，请引用最新通知。',409,true);
  const boundary=notificationInputBoundary(session,conversation.user_id);
  const source=getDb().prepare("SELECT json_extract(reply_context,'$.personal_notification_id') AS id FROM platform_ai_outbox WHERE id=?").get(route.notice_id) as {id:number|null}|undefined;
  const exactId=source?.id&&getDb().prepare('SELECT 1 FROM notifications WHERE id=? AND user_id=? AND session_id=? AND native_id=?').get(source.id,conversation.user_id,session.id,route.native_id)?source.id:null;
  getDb().prepare("INSERT INTO platform_ai_operations(id,message_id,tool_name,arguments,status) VALUES(?,?, 'quoted_reply',?,'started')").run(operationId,message.id,JSON.stringify({session_id:session.id,route_id:route.id}));
  let result:string,acceptedOrUnknown=false,quietSuccess=false;
  try {
    const sent=await platformApi(app,conversation.user_id,'POST',`/api/sessions/${encodeURIComponent(session.id)}/input`,{input:message.content+`\n\n[Platform task reference: ${operationId}]`+imagePrompt,source:'conversation',client_id:'quoted_'+message.id,expected_native_id:route.native_id,expected_environment_id:route.environment_id});
    acceptedOrUnknown=true;
    if(!['submitted','queued'].includes(sent.status))throw Error('Unknown input receipt');
    quietSuccess=true;
    const label=sessionPresenter(conversation.user_id)(session);
    result=`${sent.status==='queued'?'已排队提交':'已提交'}到「${[label.project_name,label.tab_name].filter(Boolean).join(' / ')}」，等待 Agent 处理。`;
  }catch(error){
    acceptedOrUnknown=!(error instanceof PlatformApiError&&error.statusCode<500);
    result=error instanceof PlatformApiError&&error.statusCode<500?`未投递：${error.message}。请处理后重新回复通知。`:'投递结果待核对，为避免重复执行不会自动重发，请查看原标签页。';
  }
  if(quietSuccess){
    try {settleNotificationsForInput(session,conversation.user_id,boundary);if(exactId)markNotificationsRead(conversation.user_id,[exactId]);}
    catch {quietSuccess=false;result+=' 网页通知状态未能更新，请在原标签页核对。';}
  }
  if(acceptedOrUnknown){
    try{getDb().transaction(()=>{
      const previous=sourceTaskId?getDb().prepare('SELECT requirement FROM platform_ai_tasks WHERE id=?').get(sourceTaskId) as {requirement:string}|undefined:undefined;
      if(sourceTaskId)getDb().prepare("UPDATE platform_ai_tasks SET status='superseded',updated_at=datetime('now') WHERE id=? AND status IN ('running','blocked','uncertain')").run(sourceTaskId);
      const task=trackTask(conversation,session.id,((previous?.requirement||'')+'\n\n用户回复：'+message.content).slice(-24000),Number(display.cursor)||0,operationId);
      if(result.startsWith('投递结果待核对'))getDb().prepare("UPDATE platform_ai_tasks SET status='uncertain' WHERE id=?").run(task.id);
    })();}catch{quietSuccess=false;result+=' 任务跟踪未能更新，请到原标签页核对后续结果。';}
  }
  getDb().prepare("UPDATE platform_ai_operations SET status='done',result=?,arguments=json_set(arguments,'$.quiet_success',?) WHERE id=?").run(result,Number(quietSuccess),operationId);
  return result;
}
