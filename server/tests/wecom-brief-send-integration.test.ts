import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import {afterEach,expect,it,vi} from 'vitest';
import {createTestDatabase} from './helpers/database.js';
import {authHook,createSession,createUser,setProjectToolAccess} from '../src/auth.js';
import {getDb} from '../src/db/index.js';
import {agentRoutes} from '../src/routes/agent.js';
import {sessionRoutes} from '../src/routes/sessions.js';
import {getAgent} from '../src/services/agents/index.js';
import * as manager from '../src/services/session-manager.js';
import * as conversationReader from '../src/services/conversation-reader.js';
import * as promptContext from '../src/services/prompt-context.js';
import {rememberInputSource} from '../src/services/conversation-input-links.js';
import {saveChannel} from '../src/services/platform-ai/channels.js';
import {getConversation,receiveMessage,trackTask} from '../src/services/platform-ai/store.js';
import {dispatchQuotedReply,notificationReplyTarget,prepareReplyNotification} from '../src/services/platform-ai/quoted-replies.js';
import {parseBriefContext} from '../src/shared/conversation-brief.js';

let cleanup:(()=>void)|undefined,app:ReturnType<typeof Fastify>|undefined;
afterEach(async()=>{await app?.close();vi.restoreAllMocks();vi.unstubAllEnvs();cleanup?.();});

it('uses the real guard and input routes when a WeCom quote needs a fresh brief conversation',async()=>{
 const scheduledPrompt='检查服务状态并报告发现的问题。'.repeat(12);
 const fixture=createTestDatabase();cleanup=fixture.cleanup;
 const user=createUser({username:'owner',password:'password1',role:'admin'}).id;
 getDb().prepare("INSERT INTO projects(id,name,path,owner_id) VALUES('p','Project',?,?)").run(fixture.dir,user);
 setProjectToolAccess({projectId:'p',userId:user,canSession:true,canTerminal:true,sessionClients:['codex'],grantedBy:user});
 getDb().prepare("INSERT INTO sessions(id,project_id,task,status,mode,cli_type,codex_session_id,created_by_user_id) VALUES('s','p','Work','running','session','codex','native-old',?)").run(user);
 rememberInputSource('s','scheduled-1',{kind:'scheduled',label:'巡检'});
 rememberInputSource('s','scheduled-2',{kind:'scheduled',label:'巡检'});
 const channel=saveChannel({name:'BOT',kind:'wecom_bot',enabled:true,config:{bot_id:'fixture'},secrets:{bot_secret:'fixture'}});
 getDb().prepare("INSERT INTO platform_ai_bindings(id,channel_id,external_user_id,user_id) VALUES('binding',?,'wx',?)").run(channel.id,user);
 const original=receiveMessage({userId:user,channelId:channel.id,externalUserId:'wx',chatId:'wx',messageId:'original',content:'工作'});
 const conversation=getConversation(original.conversation_id)!;
 const task=trackTask(conversation,'s','原需求',0,'old-turn');
 getDb().prepare("UPDATE platform_ai_tasks SET status='reported_complete' WHERE id=?").run(task.id);
 const noticeKey=`task:${task.id}:done`;
 getDb().prepare("INSERT INTO platform_ai_outbox(id,conversation_id,dedupe_key,content,status) VALUES('notice',?,?,?,'sent')").run(conversation.id,noticeKey,'旧结论');
 prepareReplyNotification({noticeId:'notice',noticeKey,target:notificationReplyTarget('s','ref:old-turn')!,userId:user,channelId:channel.id,externalUserId:'wx',chatId:'wx',content:'旧结论'});
 const route=getDb().prepare("SELECT id FROM platform_ai_reply_routes WHERE notice_id='notice'").get() as {id:string};
 const incoming=receiveMessage({userId:user,channelId:channel.id,externalUserId:'wx',chatId:'wx',messageId:'reply',content:'继续处理',replyContext:{direct_route:route.id}});
 const message=getDb().prepare('SELECT * FROM platform_ai_messages WHERE id=?').get(incoming.message_id) as Parameters<typeof dispatchQuotedReply>[2];

 const adapter=getAgent('codex');
 vi.spyOn(adapter.runtime,'read').mockImplementation(async context=>({source:'fixture',session_id:context.nativeId,state:'idle',last_activity_at:null,last_turn_ended_at:null,observed_at:new Date().toISOString(),reason:'fixture'}));
 vi.spyOn(adapter.telemetry,'read').mockImplementation(async context=>({usage:{total:{total_tokens:0},last:{total_tokens:context.nativeId==='native-old'?800:0},window:1000},observed_at:new Date().toISOString()}));
 const submit=vi.spyOn(adapter.input,'submit').mockResolvedValue(true);
 vi.spyOn(manager,'isSessionActive').mockReturnValue(true);
 vi.spyOn(manager,'newSessionConversation').mockImplementation(async(id,_preference,_replacement,expected)=>{
  expect(expected).toBe('native-old');getDb().prepare("UPDATE sessions SET codex_session_id='native-fresh' WHERE id=?").run(id);
  return {ok:true,history_id:'history'};
 });
 vi.spyOn(promptContext,'loadRecentAgentMessages').mockResolvedValue([{role:'user',phase:'user',text:'原需求',timestamp:'2026-11-20T00:00:00Z',task_reference:'old-turn'}]);
 vi.spyOn(conversationReader,'readConversation').mockImplementation(async source=>({available:true,generation:'one',has_more:false,reset:false,messages:source.codex_session_id==='native-fresh'?[{
  id:'fresh-input',role:'user',text:submit.mock.calls[0][1],timestamp:null,client_id:'quoted_'+incoming.message_id,
 }]:[
  {id:'scheduled-input-1',role:'user',text:scheduledPrompt,timestamp:null,client_id:'scheduled-1'},
  {id:'scheduled-final-1',role:'assistant',phase:'final',text:'第一次结果',timestamp:null},
  {id:'scheduled-input-2',role:'user',text:scheduledPrompt,timestamp:null,client_id:'scheduled-2'},
  {id:'scheduled-final-2',role:'assistant',phase:'final',text:'第二次结果',timestamp:null},
  {id:'old-input',role:'user',text:'原需求',timestamp:null},
  {id:'old-final',role:'assistant',phase:'final',text:'原结论',timestamp:null},
 ],statistics:[],metadata:null,cache_drops:[]} as any));
 vi.stubGlobal('fetch',vi.fn(()=>{throw Error('No external model or service');}));
 app=Fastify();await app.register(websocket);app.addHook('onRequest',authHook);
 await app.register(agentRoutes,{prefix:'/api'});await app.register(sessionRoutes,{prefix:'/api'});await app.ready();

 const result=await dispatchQuotedReply(app,conversation,message,()=>{throw Error('not a project notice');},()=>{});
 expect(result).toContain('简要压缩');expect(submit).toHaveBeenCalledOnce();
 expect(submit.mock.calls[0][0].nativeId).toBe('native-fresh');
 const brief=parseBriefContext(submit.mock.calls[0][1])!;
 expect(brief.context.turns).toEqual([
  {input:scheduledPrompt,scheduled_task:'巡检',conclusion:'第一次结果'},
  {input:'同第 1 轮定时任务提示词',input_ref:1,scheduled_task:'巡检',conclusion:'第二次结果'},
  {input:'原需求',conclusion:'原结论'},
 ]);
 expect(brief.input).toContain('继续处理');expect(fetch).not.toHaveBeenCalled();
 const restored=await app.inject({url:'/api/sessions/s/conversation',headers:{cookie:`agentmanager_session=${createSession(user)}`}});
 expect(restored.statusCode).toBe(200);
 const visible=parseBriefContext(restored.json().messages[0].text)!;
 expect(visible.context.turns[1].input_ref).toBe(1);
 expect(visible.context.turns[2].conclusion).toBe('原结论');expect(visible.input).toBe('继续处理');
});
