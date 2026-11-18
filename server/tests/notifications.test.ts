import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import {createTestDatabase} from './helpers/database.js';
import {getDb,closeDb,initDb} from '../src/db/index.js';
import {authHook,createUser,createSession} from '../src/auth.js';
import {registerAgent,getAgent} from '../src/services/agents/index.js';
import {capabilities,type AgentMessage,type AgentRuntime} from '../src/services/agents/types.js';
import type {AgentStreamFrame,AgentStreamSnapshot} from '../src/services/agents/events.js';
import {observeConversationFile} from '../src/services/conversation-file-stream.js';
import {notificationRoutes} from '../src/routes/notifications.js';
import {streamRoutes} from '../src/routes/stream.js';
import {broadcastEphemeral} from '../src/services/event-store.js';
import {rememberInputSource} from '../src/services/conversation-input-links.js';
import {listNotifications,notificationSession,putNotification,pruneNotifications,notificationInputBoundary,settleNotificationsForInput} from '../src/services/notifications.js';

vi.mock('../src/services/conversation-file-stream.js',()=>({observeConversationFile:vi.fn()}));
let cleanup:()=>void,unregister:()=>void,app:ReturnType<typeof Fastify>,owner:string,other:string,cookie:string,otherCookie:string;
const streams=new Map<string,(frame:AgentStreamFrame)=>void>(),files=new Map<string,Parameters<typeof observeConversationFile>[1]>();
const stopped=vi.fn(),submit=vi.fn();
const stored=(kind:string)=>getDb().prepare('SELECT * FROM notifications WHERE kind=? ORDER BY id DESC').all(kind) as Array<{id:number;state:string;source_id:string}>;
const now=()=>new Date(Date.now()+100).toISOString();
const message=(id:string,extra:Partial<AgentMessage>={}):AgentMessage=>({id,role:'assistant',phase:'final',text:'本轮结果',timestamp:now(),turn_id:'turn',...extra});
const snapshot=(extra:Partial<AgentStreamSnapshot>={}):AgentStreamSnapshot=>({type:'snapshot',messages:[],interactions:[],activities:[],compaction:null,busy:false,connected:true,turn_id:'turn',started_at:null,completed_at:null,stage:'idle',...extra});
const runtime=(extra:Partial<AgentRuntime>={}):AgentRuntime=>({source:'fixture',session_id:'opaque/thread',state:'idle',last_activity_at:null,observed_at:now(),reason:'native',pending_questions:[],...extra});
function history(raw:AgentRuntime,messages:AgentMessage[]=[]) {files.get('s')!({type:'history',runtime:raw,messages});}
beforeEach(async()=>{
  cleanup=createTestDatabase().cleanup;streams.clear();files.clear();vi.clearAllMocks();
  unregister=registerAgent({descriptor:{id:'notice_fixture',label:'Fixture',sessionHost:'managed',presentation:{icon:'agent',color:'#123456'},capabilities:capabilities(['history','runtime','input','stream'])},
    history:{read:async()=>null},runtime:{read:async()=>runtime(),subscribe:()=>()=>{}},input:{submit},
    stream:{observe:(context,emit)=>{streams.set(context.session.id!,emit);return Object.assign(()=>stopped(context.session.id),{respond:vi.fn()});}},
  });
  vi.mocked(observeConversationFile).mockImplementation((session,emit)=>{files.set((session as {id?:string}).id!,emit);return()=>stopped('file');});
  owner=createUser({username:'notice-owner',password:'password1',role:'admin'}).id;
  other=createUser({username:'notice-other',password:'password1',role:'admin'}).id;
  cookie=`agentmanager_session=${createSession(owner)}`;otherCookie=`agentmanager_session=${createSession(other)}`;
  getDb().prepare("INSERT INTO projects(id,name,path,owner_id) VALUES('p','项目 A','/fixture/project',?)").run(owner);
  getDb().prepare("INSERT INTO sessions(id,project_id,task,status,mode,cli_type,native_session_id,created_by_user_id) VALUES('s','p','后端修复','running','session','notice_fixture','opaque/thread',?)").run(owner);
  app=Fastify();await app.register(websocket);app.addHook('onRequest',authHook);
  await app.register(notificationRoutes,{prefix:'/api'});await app.register(streamRoutes,{prefix:'/api'});await app.ready();
});
afterEach(async()=>{await app.close();await getAgent('notice_fixture').stream.shutdown?.();unregister();cleanup();});

it('only notifies errors, questions and completed execution; quiet/open sessions and progress do not create entries',()=>{
  const emit=streams.get('s')!;
  emit(snapshot({messages:[message('old',{timestamp:'2020-01-01T00:00:00Z'})]}));
  expect(listNotifications(owner).notifications).toHaveLength(0);
  emit(snapshot({busy:true,stage:'tools',messages:[message('progress',{phase:'commentary'})]}));
  emit(snapshot({busy:true,stage:'answering',messages:[message('result')]}));
  expect(listNotifications(owner).notifications).toHaveLength(0);
  emit(snapshot({messages:[message('result')],completed_at:now()}));
  emit(snapshot({messages:[message('result')],completed_at:now()}));
  expect(listNotifications(owner)).toMatchObject({unread:1,pending:0,notifications:[{kind:'result',title:'本轮运行完成',message_id:'result'}]});
  expect(submit).not.toHaveBeenCalled();
});

it('keeps reading separate from answering and follows queued answers, cancellation and original-view answers',async()=>{
  const q={id:'opaque/question',title:'兼容旧版本吗？',options:['是','否']};
  history(runtime({pending_questions:[{id:'group',questions:[q],timestamp:now()}]}));
  const first=listNotifications(owner);expect(first.pending).toBe(1);
  await app.inject({method:'POST',url:'/api/notifications/read',headers:{cookie},payload:{ids:[first.notifications[0].id]}});
  expect(listNotifications(owner)).toMatchObject({pending:1,unread:0});
  history(runtime({submitted_question_ids:[q.id],queued_answer_count:1}));
  expect(stored('question')[0].state).toBe('submitted');expect(listNotifications(owner).notifications).toEqual([]);
  history(runtime({pending_questions:[{id:'group',questions:[q],timestamp:now()}]}));
  expect(listNotifications(owner).pending).toBe(1);
  history(runtime());expect(stored('question')[0].state).toBe('resolved');expect(listNotifications(owner).notifications).toEqual([]);
});

it('updates live approvals in place and rejects malformed read/preference requests',async()=>{
  const emit=streams.get('s')!;
  emit(snapshot({interactions:[{id:'request:1',turn_id:'turn',kind:'command',title:'确认执行命令',detail:'运行测试',blocking:true,submitted:false}]}));
  expect(listNotifications(owner).pending).toBe(1);
  emit(snapshot({interactions:[]}));expect(listNotifications(owner)).toMatchObject({pending:0,notifications:[]});expect(stored('approval')[0].state).toBe('resolved');
  for(const payload of [{ids:[-1]},{ids:['1']},{through_id:0},{ids:[1],unexpected:true}])expect((await app.inject({method:'POST',url:'/api/notifications/read',headers:{cookie},payload})).statusCode).toBe(400);
  expect((await app.inject({method:'GET',url:'/api/notifications?filter=invalid',headers:{cookie}})).statusCode).toBe(400);
  expect((await app.inject({method:'PUT',url:'/api/notifications/preferences',headers:{cookie},payload:{muted_project_ids:['missing']}})).statusCode).toBe(404);
});

it('isolates accounts including admins, rechecks revoked access, and sends invalidations only to the owner',async()=>{
  streams.get('s')!(snapshot({messages:[message('failure',{phase:'error'})]}));
  const id=listNotifications(owner).notifications[0].id;
  expect((await app.inject({url:'/api/notifications',headers:{cookie:otherCookie}})).json().notifications).toEqual([]);
  await app.inject({method:'POST',url:'/api/notifications/read',headers:{cookie:otherCookie},payload:{ids:[id]}});
  expect(listNotifications(owner).unread).toBe(1);
  const socket=await app.injectWS('/api/stream',{headers:{cookie:otherCookie}}),received:string[]=[];
  socket.on('message',bytes=>received.push(bytes.toString()));
  broadcastEphemeral({type:'notification.changed',data:{user_id:owner,id}});
  broadcastEphemeral({type:'session.retry',session_id:'s',data:{retry:{private:'value'}}});
  await new Promise(resolve=>setTimeout(resolve,20));expect(received).toEqual([]);socket.close();
  getDb().prepare('UPDATE users SET disabled=1 WHERE id=?').run(owner);
  expect(listNotifications(owner).notifications).toEqual([]);
});

it('muting suppresses counts while preserving entries, and read-all cannot consume newer arrivals',async()=>{
  const session=notificationSession('s')!;
  putNotification(session,{kind:'result',state:'info',source_id:'one',title:'完成',body:'一'});
  const through=listNotifications(owner).through_id;
  putNotification(session,{kind:'question',state:'pending',source_id:'two',title:'提问',body:'二'});
  await app.inject({method:'POST',url:'/api/notifications/read',headers:{cookie},payload:{through_id:through}});
  expect(listNotifications(owner).unread).toBe(1);
  await app.inject({method:'PUT',url:'/api/notifications/preferences',headers:{cookie},payload:{muted_project_ids:['p']}});
  expect(listNotifications(owner)).toMatchObject({unread:0,pending:0,notifications:[{muted:true},{muted:true}]});
});

it('survives migration/restart without losing read state and removes only settled retained history',async()=>{
  await app.close();
  const session=notificationSession('s')!;
  putNotification(session,{kind:'question',state:'pending',source_id:'keep',title:'待回答',body:'保留'});
  putNotification(session,{kind:'result',state:'info',source_id:'prune',title:'过期',body:'旧记录'});
  getDb().exec("UPDATE notifications SET created_at='2000-01-01T00:00:00Z',read_at='2026-01-01T00:00:00Z'; PRAGMA user_version=27");
  closeDb();initDb();pruneNotifications();
  expect(listNotifications(owner).notifications).toMatchObject([{kind:'question',read_at:'2026-01-01T00:00:00Z'}]);
  getDb().prepare('DELETE FROM sessions WHERE id=?').run('s');expect(getDb().prepare('SELECT * FROM notifications').all()).toEqual([]);
});

it('keeps restored active native questions actionable and resolves old-binding actions without using them in a new conversation',async()=>{
  history(runtime({pending_questions:[{id:'g',questions:[{id:'q',title:'范围？',options:null}],timestamp:null}]}));
  expect(listNotifications(owner).pending).toBe(1);
  getDb().prepare("UPDATE sessions SET native_session_id='opaque/new-thread' WHERE id='s'").run();
  broadcastEphemeral({type:'session.bound',session_id:'s'});
  await vi.waitFor(()=>expect(stored('question')[0].state).toBe('resolved'));expect(listNotifications(owner).notifications).toEqual([]);
  expect(submit).not.toHaveBeenCalled();
});

it('notifies a live structured question before its history is written and does not reopen it on replay',()=>{
  const emit=streams.get('s')!,question={id:'live-q',title:'现在选择？',options:['A','B']};
  emit(snapshot({messages:[message('live-question',{async_questions:[question]})]}));
  expect(listNotifications(owner)).toMatchObject({pending:1,notifications:[{source_id:'question:live-q'}]});
  emit(snapshot({messages:[message('reply',{role:'user',question_replies:[{question_id:'live-q',question:question.title,answer:'A'}]})]}));
  expect(listNotifications(owner).pending).toBe(0);
  emit(snapshot({baseline:true,messages:[message('live-question',{async_questions:[question]})]}));
  expect(listNotifications(owner).pending).toBe(0);
});

it('shows automatic recovery without repeated failure notices and confirms recovery only after a result',()=>{
  getDb().exec('CREATE TABLE conversation_retries(session_id TEXT,native_id TEXT,root_turn_id TEXT,data TEXT,updated_at TEXT)');
  const job={session_id:'s',native_id:'opaque/thread',root_turn_id:'turn',failed_turn_ids:['turn'],status:'waiting',attempt:0};
  getDb().prepare('INSERT INTO conversation_retries VALUES(?,?,?,?,?)').run('s','opaque/thread','turn',JSON.stringify(job),now());
  const emit=streams.get('s')!,failure=message('fail',{phase:'error',text:'Selected model is at capacity'});
  emit(snapshot({messages:[failure]}));expect(listNotifications(owner)).toMatchObject({pending:0,notifications:[{state:'recovering'}]});
  broadcastEphemeral({type:'session.retry',session_id:'s',data:{retry:{...job,status:'exhausted'}}});
  expect(listNotifications(owner).pending).toBe(1);
  getDb().prepare('UPDATE conversation_retries SET data=?').run(JSON.stringify({...job,status:'exhausted'}));
  emit(snapshot({busy:true,stage:'tools',messages:[]}));expect(stored('error')[0].state).toBe('submitted');expect(listNotifications(owner).notifications).toEqual([]);
  emit(snapshot({messages:[message('recovered',{turn_id:'new-turn'})],completed_at:now()}));
  expect(stored('error')[0].state).toBe('resolved');expect(listNotifications(owner).notifications.some(row=>row.kind==='error')).toBe(false);
  emit(snapshot({messages:[failure]}));
  // Historical replay must not reset a confirmed recovery to pending.
  expect(stored('error')).toHaveLength(1);
  expect(stored('error')[0].state).toBe('resolved');expect(listNotifications(owner).notifications.some(row=>row.kind==='error')).toBe(false);
});

it('does not replay a question acknowledgment as a completion when the next turn finishes',()=>{
  history(runtime({pending_questions:[{id:'g',questions:[{id:'q',title:'选择范围',options:null}],timestamp:now(),turn_id:'question-turn'}]}));
  history(runtime({pending_questions:[{id:'g',questions:[{id:'q',title:'选择范围',options:null}],timestamp:now()}]}),[message('question-ack',{text:'问题已发出，可以点选。',turn_id:'question-turn'})]);
  history(runtime({state:'running',submitted_question_ids:['q']}));
  streams.get('s')!(snapshot({messages:[message('actual-result',{text:'任务已完成',turn_id:'next-turn'})],completed_at:now()}));
  expect(listNotifications(owner).notifications.filter(row=>row.kind==='result').map(row=>row.body)).toEqual(['任务已完成']);
});

it('settles accepted replies only through their captured boundary and preserves new results, other users and unanswered questions',()=>{
  const session=notificationSession('s')!;
  putNotification(session,{kind:'result',state:'info',source_id:'old',message_id:'old',title:'完成',body:'旧结果'});
  putNotification(session,{kind:'question',state:'pending',source_id:'q',title:'提问',body:'仍需回答'});
  putNotification(session,{kind:'error',state:'pending',source_id:'retry-chain',message_id:'old-error',title:'失败',body:'原来的失败'});
  const boundary=notificationInputBoundary(session,owner);
  putNotification(session,{kind:'result',state:'info',source_id:'new',message_id:'new',title:'完成',body:'新结果'});
  putNotification(session,{kind:'error',state:'pending',source_id:'retry-chain',message_id:'new-error',title:'失败',body:'新的失败'});
  settleNotificationsForInput(session,other,boundary);expect(listNotifications(owner).notifications).toHaveLength(4);
  settleNotificationsForInput(session,owner,boundary);
  for(const filter of ['all','unread','pending'])expect(listNotifications(owner,{filter}).notifications.some(row=>row.source_id==='old')).toBe(false);
  expect(listNotifications(owner).notifications.map(row=>row.source_id)).toEqual(['new','retry-chain','q']);
  putNotification(session,{kind:'result',state:'info',source_id:'old',message_id:'old',title:'完成',body:'旧结果'});
  expect(stored('result').find(row=>row.source_id==='old')?.state).toBe('resolved');
});

it('repairs result notifications after a later confirmed native reply and keeps queued, automatic and earlier inputs from consuming results',()=>{
  const result=message('result',{timestamp:now()});
  streams.get('s')!(snapshot({busy:true,stage:'tools'}));streams.get('s')!(snapshot({messages:[result],completed_at:now()}));
  const user=message('human',{role:'user',phase:undefined,timestamp:new Date(Date.parse(result.timestamp!)+1000).toISOString(),text:'继续'});
  history(runtime(),[{...user,queued:true}]);expect(listNotifications(owner).notifications.some(row=>row.kind==='result')).toBe(true);
  history(runtime(),[{...user,text:'<task_notification>internal</task_notification>'}]);expect(listNotifications(owner).notifications.some(row=>row.kind==='result')).toBe(true);
  history(runtime(),[{...user,timestamp:new Date(Date.parse(result.timestamp!)-1000).toISOString()}]);expect(listNotifications(owner).notifications.some(row=>row.kind==='result')).toBe(true);
  history(runtime(),[user]);expect(listNotifications(owner).notifications).toEqual([]);
  streams.get('s')!(snapshot({messages:[result],completed_at:now()}));expect(listNotifications(owner).notifications).toEqual([]);
});

it('settles older stored results from a confirmed human reply while excluding platform input provenance',()=>{
  const session=notificationSession('s')!;
  putNotification(session,{kind:'result',state:'info',source_id:'old-page',title:'完成',body:'更早的结果'});
  getDb().prepare("UPDATE notifications SET created_at='2026-01-01T00:00:00Z'").run();
  const reply=message('receipt',{role:'user',timestamp:new Date().toISOString(),text:'继续',client_id:'scheduled-input'});
  rememberInputSource('s','scheduled-input',{kind:'scheduled',label:'定时巡检'});
  history(runtime(),[reply]);expect(listNotifications(owner).notifications).toHaveLength(1);
  history(runtime(),[{...reply,id:'human-receipt',client_id:'human-input'}]);expect(listNotifications(owner).notifications).toEqual([]);
});

it('dismisses notices explicitly without submitting input, preserves dismissal on replay and isolates users and boundaries',async()=>{
  const q={id:'q-dismiss',title:'无需回答',options:['是','否']};
  const raw=runtime({pending_questions:[{id:'g',questions:[q],timestamp:now()}]});history(raw);
  const notice=listNotifications(owner).notifications[0];
  const post=(headers:{cookie:string},payload:unknown)=>app.inject({method:'POST',url:'/api/notifications/dismiss',headers,payload});
  expect((await post({cookie:otherCookie},{ids:[notice.id]})).statusCode).toBe(200);
  expect(listNotifications(owner).pending).toBe(1);
  await post({cookie},{ids:[notice.id]});await post({cookie},{ids:[notice.id]});
  history(raw);expect(listNotifications(owner)).toMatchObject({pending:0,unread:0,notifications:[]});
  expect(submit).not.toHaveBeenCalled();
  putNotification(notificationSession('s')!,{kind:'result',state:'info',source_id:'later',title:'新完成',body:'仍提醒'});
  await post({cookie},{through_id:notice.id});expect(listNotifications(owner).notifications).toHaveLength(1);
  for(const payload of [{ids:[]},{ids:[-1]},{ids:[notice.id],unexpected:true}])expect((await post({cookie},payload)).statusCode).toBe(400);
});

it('keeps manually read errors quiet on replay but not a distinct later failure in the same retry chain',async()=>{
  const session=notificationSession('s')!;
  const failure={kind:'error' as const,state:'pending' as const,source_id:'retry-root',message_id:'failure-1',title:'失败',body:'同一报错'};
  putNotification(session,failure);const id=listNotifications(owner).notifications[0].id;
  await app.inject({method:'POST',url:'/api/notifications/dismiss',headers:{cookie},payload:{ids:[id]}});
  putNotification(session,failure);expect(listNotifications(owner).notifications).toEqual([]);
  putNotification(session,{...failure,message_id:'failure-2',body:'新的失败'});
  expect(listNotifications(owner)).toMatchObject({pending:1,unread:1,notifications:[{message_id:'failure-2'}]});
});
