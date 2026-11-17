import Fastify from 'fastify';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createTestDatabase} from './helpers/database.js';
import {authHook,createUser,setProjectToolAccess} from '../src/auth.js';
import {getDb} from '../src/db/index.js';
import {saveChannel} from '../src/services/platform-ai/channels.js';
import {acceptChannelMessage} from '../src/services/platform-ai/ingress.js';
import {readAiConfig,updateAiConfig} from '../src/services/platform-ai/config.js';
import {setBotTransport} from '../src/services/platform-ai/channel-runtime.js';
import {enqueueNotice,getConversation,receiveMessage,trackTask,claimMessage} from '../src/services/platform-ai/store.js';
import {notificationReplyTarget,quotedReplyRoute,replyTurnKey,prefixReplyNotification} from '../src/services/platform-ai/quoted-replies.js';
import {textCollector} from '../src/services/agents/history-text.js';
import {PlatformAiWorker} from '../src/services/platform-ai/worker.js';
import {saveProjectNotification} from '../src/services/platform-ai/project-notifications.js';

let cleanup:()=>void,app:ReturnType<typeof Fastify>,worker:PlatformAiWorker,user:string,other:string,channel:ReturnType<typeof saveChannel>,conversation:string;
let inputs:Array<{id:string;body:any}>,delivered:string[],currentRef:Record<string,string>,promptType:string|null,inputStatus:number;
let finalText:string|null,beforeDisplay:(()=>void)|null;
beforeEach(async()=>{
 ({cleanup}=createTestDatabase());user=createUser({username:'owner',password:'password1',role:'admin'}).id;other=createUser({username:'other',password:'password1',role:'admin'}).id;
 getDb().prepare("INSERT INTO projects(id,name,path,owner_id) VALUES('p','Project','/fixture',?)").run(user);
 setProjectToolAccess({projectId:'p',userId:user,canSession:true,canTerminal:true,sessionClients:['codex'],grantedBy:user});
 for(const id of ['a','b'])getDb().prepare("INSERT INTO sessions(id,project_id,task,mode,status,cli_type,codex_session_id,created_by_user_id) VALUES(?,'p',?,'session','running','codex',?,?)").run(id,id,'native-'+id,user);
 updateAiConfig({enabled:true,endpoint:'https://model.example/v1',model:'fixture',api_key:'dummy'});
 channel=saveChannel({name:'BOT',kind:'wecom_bot',enabled:true,config:{bot_id:'fixture'},secrets:{bot_secret:'dummy'}});
 for(const [external,uid] of [['wx-owner',user],['wx-other',other]])getDb().prepare('INSERT INTO platform_ai_bindings(id,channel_id,external_user_id,user_id) VALUES(?,?,?,?)').run(external,channel.id,external,uid);
 conversation=receiveMessage({userId:user,channelId:channel.id,externalUserId:'wx-owner',chatId:'wx-owner',messageId:'initial',content:'hello'}).conversation_id;
 getDb().prepare("UPDATE platform_ai_messages SET status='done'").run();
 inputs=[];delivered=[];currentRef={a:'turn-a',b:'turn-b'};promptType=null;inputStatus=202;finalText=null;beforeDisplay=null;
 app=Fastify();app.addHook('onRequest',authHook);
 app.get<{Params:{id:string}}>('/api/sessions/:id',req=>({session:getDb().prepare('SELECT * FROM sessions WHERE id=?').get(req.params.id)}));
 app.get<{Params:{id:string}}>('/api/sessions/:id/agent-messages',req=>({messages:[{role:'user',phase:'user',timestamp:'2026-11-17T00:00:00Z',text:'request',task_reference:currentRef[req.params.id]},...finalText?[{role:'assistant',phase:'final',text:finalText,timestamp:'2026-11-17T00:00:01Z',task_reference:currentRef[req.params.id]}]:[]]}));
 app.get('/api/sessions/:id/display',()=>{beforeDisplay?.();return {cursor:0,processState:'idle',promptType};});
 app.get('/api/sessions/:id/completed-turn',()=>({turns:[]}));
 app.post<{Params:{id:string};Body:any}>('/api/sessions/:id/input',(req,reply)=>{inputs.push({id:req.params.id,body:req.body});return reply.code(inputStatus).send(inputStatus===202?{status:'submitted'}:{error:'fixture failure'});});
 await app.ready();worker=new PlatformAiWorker(app);
 setBotTransport(channel.id,{status:{state:'connected',message:'fixture',updated_at:''},deliver:async(_chat,content)=>{delivered.push(content);}});
 vi.stubGlobal('fetch',vi.fn(()=>{throw Error('Model must not run for a quoted reply');}));
});
afterEach(async()=>{await worker.stop();await app.close();setBotTransport(channel.id);vi.unstubAllGlobals();vi.restoreAllMocks();cleanup();});
async function notice(id='a'){
 const task=trackTask(getConversation(conversation)!,id,'request',0,currentRef[id]);
 getDb().prepare("UPDATE platform_ai_tasks SET status='reported_complete' WHERE id=?").run(task.id);
 enqueueNotice(conversation,`task:${task.id}:done`,'Agent 的问题',{notification_target:notificationReplyTarget(id,'ref:'+currentRef[id])});
 worker.tick();await worker.drain();
 return delivered.at(-1)!;
}
function reply(quote:string,text='使用独立环境',messageId='reply',external='wx-owner',chat='wx-owner'){
 return acceptChannelMessage(channel,{externalUserId:external,chatId:chat,messageId,content:text,replyContext:{bot_message_id:messageId,direct_route:quotedReplyRoute(quote)}});
}
async function process(){worker.tick();await worker.drain();}
function response(){return (getDb().prepare("SELECT content FROM platform_ai_messages WHERE role='assistant' ORDER BY rowid DESC LIMIT 1").get() as {content:string}|undefined)?.content||'';}

describe('quoted notification quick replies',()=>{
 it('routes two tabs by their quoted prefix, preserves reply text and tracks the follow-up without a model',async()=>{
  const a=await notice('a'),b=await notice('b');expect(quotedReplyRoute(a)).not.toBe(quotedReplyRoute(b));
  const received=reply(a);reply(a);await process();
  expect(inputs).toHaveLength(1);expect(inputs[0]).toMatchObject({id:'a',body:{source:'conversation',client_id:'quoted_'+received.message_id,expected_native_id:'native-a'}});
  expect(inputs[0].body.input).toBe('使用独立环境\n\n[Platform task reference: quoted_'+received.message_id+']');expect(inputs[0].body.input).not.toContain('Agent 的问题');
  const history=textCollector(8000);history.append('user','user',inputs[0].body.input,new Date().toISOString());history.append('assistant','final','follow-up done',new Date().toISOString());expect(history.messages[1].task_reference).toBe('quoted_'+received.message_id);
  expect(response()).toContain('已提交');expect(fetch).not.toHaveBeenCalled();
  expect(getDb().prepare("SELECT source_ref FROM platform_ai_tasks WHERE session_id='a' AND status='running'").get()).toEqual({source_ref:'quoted_'+received.message_id});
  expect((getDb().prepare('SELECT context FROM platform_ai_conversations WHERE id=?').get(conversation) as {context:string}).context).toBe('[]');
 });
 it('notifies the Agent follow-up and lets the next quoted notification reach the same tab',async()=>{
  const original=await notice(),received=reply(original);await process();
  const task=getDb().prepare("SELECT * FROM platform_ai_tasks WHERE session_id='a' AND status='running'").get() as any;
  currentRef.a='quoted_'+received.message_id;finalText='处理完成，已使用独立环境。';
  vi.mocked(fetch).mockImplementation(async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({status:'reported_complete',summary:'处理完成',evidence:'处理完成'})}}]}),{status:200}));
  await worker.observe(task,readAiConfig());expect(getDb().prepare('SELECT status FROM platform_ai_tasks WHERE id=?').get(task.id)).toEqual({status:'reported_complete'});
  await process();const next=delivered.at(-1)!;expect(next).toContain(finalText);expect(quotedReplyRoute(next)).not.toBe(quotedReplyRoute(original));
  finalText=null;reply(next,'再补充测试','second-reply');await process();expect(inputs).toHaveLength(2);expect(inputs[1].id).toBe('a');expect(inputs[1].body.input).toMatch(/^再补充测试/);
 });
 it.each(['native','environment','turn','expired','cancelled','permission','choice','other-user','other-chat','revoked-binding','unknown-token'])('fails closed for %s without dispatch or model fallback',async kind=>{
  let quoted=await notice();
  if(kind==='native')getDb().prepare("UPDATE sessions SET codex_session_id='new' WHERE id='a'").run();
  if(kind==='environment')getDb().prepare("UPDATE sessions SET agent_environment_id='new-account' WHERE id='a'").run();
  if(kind==='turn')currentRef.a='another-turn';
  if(kind==='expired')getDb().prepare('UPDATE platform_ai_reply_routes SET expires_at=0').run();
  if(kind==='cancelled')getDb().prepare("UPDATE platform_ai_tasks SET status='cancelled'").run();
  if(kind==='permission')getDb().prepare("UPDATE sessions SET created_by_user_id=? WHERE id='a'").run(other);
  if(kind==='choice')promptType='confirmation';
  if(kind==='unknown-token')quoted='【来源 · AM-222222222222】';
  reply(quoted,'yes','reply',kind==='other-user'?'wx-other':'wx-owner',kind==='other-chat'?'other-group':kind==='other-user'?'wx-other':'wx-owner');
  if(kind==='revoked-binding')getDb().prepare("DELETE FROM platform_ai_bindings WHERE external_user_id='wx-owner'").run();
  await process();expect(inputs).toHaveLength(0);expect(response()).toContain('未投递');expect(fetch).not.toHaveBeenCalled();
 });
 it.each(['binding','task'])('rechecks %s authorization after asynchronous reads before writing',async kind=>{
  const quoted=await notice();reply(quoted);
  beforeDisplay=()=>{if(kind==='binding')getDb().prepare("DELETE FROM platform_ai_bindings WHERE external_user_id='wx-owner'").run();else getDb().prepare("UPDATE platform_ai_tasks SET status='cancelled'").run();};
  await process();expect(inputs).toHaveLength(0);expect(response()).toContain('未投递');expect(fetch).not.toHaveBeenCalled();
 });
 it('keeps direct replies independent of queued and processing model messages',async()=>{
  const quoted=await notice();
  const ordinary=receiveMessage({userId:user,channelId:channel.id,externalUserId:'wx-owner',chatId:'wx-owner',messageId:'slow',content:'slow model'});
  expect(claimMessage(Date.now(),60000)?.id).toBe(ordinary.message_id);
  const direct=reply(quoted);
  expect(claimMessage(Date.now(),60000)).toBeUndefined();
  await process();expect(inputs).toHaveLength(1);expect(getDb().prepare('SELECT status FROM platform_ai_messages WHERE id=?').get(direct.message_id)).toEqual({status:'done'});expect(fetch).not.toHaveBeenCalled();
 });
 it('does not resend an ambiguous write after recovery',async()=>{
  const quoted=await notice();inputStatus=503;const direct=reply(quoted);await process();
  expect(response()).toContain('投递结果待核对');expect(inputs).toHaveLength(1);
  getDb().prepare("UPDATE platform_ai_messages SET status='queued' WHERE id=?").run(direct.message_id);
  await process();expect(inputs).toHaveLength(1);expect(fetch).not.toHaveBeenCalled();
 });
 it('recovers the confirmed receipt even if the task was already advanced before the reply was persisted',async()=>{
  const quoted=await notice(),direct=reply(quoted);await process();const ack=response();
  getDb().prepare("DELETE FROM platform_ai_messages WHERE role='assistant'").run();
  getDb().prepare("UPDATE platform_ai_messages SET status='queued' WHERE id=?").run(direct.message_id);
  currentRef.a='quoted_'+direct.message_id;
  await process();expect(inputs).toHaveLength(1);expect(response()).toBe(ack);
 });
 it('does not claim a write was rejected when persisting the confirmed receipt fails',async()=>{
  const quoted=await notice();reply(quoted);
  const db=getDb(),prepare=db.prepare.bind(db);let fail=true;
  const spy=vi.spyOn(db,'prepare').mockImplementation(((sql:string)=>{
   if(fail&&sql==="UPDATE platform_ai_operations SET status='done',result=? WHERE id=?"){fail=false;throw Error('temporary journal failure');}
   return prepare(sql);
  }) as typeof db.prepare);
  try{await process();expect(inputs).toHaveLength(1);expect(response()).toContain('投递结果待核对');expect(response()).not.toContain('未投递');}finally{spy.mockRestore();}
 });
 it('does not replay an operation interrupted after its write fence was persisted',async()=>{
  const quoted=await notice(),direct=reply(quoted);
  getDb().prepare("INSERT INTO platform_ai_operations(id,message_id,tool_name,arguments,status) VALUES(?,?,'quoted_reply','{}','started')").run('quoted_'+direct.message_id,direct.message_id);
  await process();expect(inputs).toHaveLength(0);expect(response()).toContain('上次投递结果待核对');
 });
 it('preserves stable prefixes across delivery retry and worker restart',async()=>{
  const quoted=await notice(),route=quotedReplyRoute(quoted);
  getDb().prepare("UPDATE platform_ai_outbox SET status='pending' WHERE dedupe_key LIKE 'task:%'").run();
  await worker.stop();worker=new PlatformAiWorker(app);await process();expect(quotedReplyRoute(delivered.at(-1)!)).toBe(route);
  reply(quoted);await process();expect(inputs).toHaveLength(1);
 });
 it('rejects a revoked project notification rule and otherwise forwards only raw reply text',async()=>{
  const rule=saveProjectNotification(user,{project_id:'p',recipient_id:'binding:wx-owner',enabled:true,on_complete:true,on_input:true});
  const key=`project-notice:${rule.id}:a:input:${rule.since_ms}:fixture`;
  const outbox='project-notice';getDb().prepare('INSERT INTO platform_ai_outbox(id,conversation_id,dedupe_key,content) VALUES(?,?,?,?)').run(outbox,rule.conversation_id,key,'question');
  const quoted=prefixReplyNotification({noticeId:outbox,noticeKey:key,target:notificationReplyTarget('a','ref:turn-a')!,userId:user,channelId:channel.id,externalUserId:'wx-owner',chatId:'wx-owner',content:'question'});
  getDb().prepare("UPDATE platform_ai_outbox SET status='sent'").run();reply(quoted);await process();expect(inputs[0].body.input).toBe('使用独立环境');
  getDb().prepare('UPDATE platform_ai_project_notifications SET enabled=0 WHERE id=?').run(rule.id);reply(quoted,'again','reply-2');await process();expect(inputs).toHaveLength(1);expect(response()).toContain('未投递');
 });
 it('does not guess missing, ambiguous or malformed notification prefixes',()=>{
  expect(()=>quotedReplyRoute('x'.repeat(24001))).toThrow('过长');
  expect(()=>quotedReplyRoute('ordinary quote')).toThrow('没有可识别');expect(()=>quotedReplyRoute('【来源 · AM-222222222222】\n【来源 · AM-333333333333】')).toThrow('多个');expect(()=>quotedReplyRoute('AM-222222222222suffix')).toThrow();
 });
 it('uses stable task references or timestamped public user records without fabricating unknown turn identities',()=>{
  const m={role:'user' as const,phase:'user' as const,text:'hello',timestamp:'2026-11-17T00:00:00Z'};
  expect(replyTurnKey(m)).toBe(replyTurnKey({...m}));expect(replyTurnKey({...m,text:'other'})).not.toBe(replyTurnKey(m));expect(replyTurnKey({...m,timestamp:null})).toBeNull();
 });
});
