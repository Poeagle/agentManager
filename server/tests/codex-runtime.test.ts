import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {appendFileSync,mkdirSync,mkdtempSync,rmSync,writeFileSync,utimesSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import {readCodexRuntime} from '../src/services/agents/codex/runtime.js';
import Fastify from 'fastify';
import {authHook,createSession,createUser} from '../src/auth.js';
import {getDb} from '../src/db/index.js';
import {sessionRoutes} from '../src/routes/sessions.js';
import {createTestDatabase} from './helpers/database.js';
import * as manager from '../src/services/session-manager.js';
import * as questionIndex from '../src/services/agents/codex/pending-questions.js';
import {readConversation} from '../src/services/conversation-reader.js';

const id='019ff001-1111-7111-8111-111111111111';
let dir:string; let file:string;
function event(type:string,second:number,extra:Record<string,unknown>={}) {
  return JSON.stringify({timestamp:`2026-10-29T10:00:${String(second).padStart(2,'0')}.000Z`,type:'event_msg',payload:{type,...extra}})+'\n';
}
beforeEach(()=>{
  dir=mkdtempSync(join(tmpdir(),'codex-native-'));vi.stubEnv('CODEX_HOME',dir);mkdirSync(join(dir,'sessions'));
  file=join(dir,'sessions',`rollout-test-${id}.jsonl`);
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();rmSync(dir,{recursive:true,force:true});});

describe('Codex native execution status',()=>{
  it('reuses pending-question metadata for unchanged native history and reads again only after append',async()=>{
    const read=vi.spyOn(questionIndex,'readPendingQuestions');
    writeFileSync(file,event('task_complete',1));await readCodexRuntime(id);await readCodexRuntime(id);await readCodexRuntime(id);
    expect(read).toHaveBeenCalledTimes(1);
    appendFileSync(file,event('task_started',2));await readCodexRuntime(id);expect(read).toHaveBeenCalledTimes(2);
  });
  it('recognizes a newly created native conversation as ready without inventing activity',async()=>{
    writeFileSync(file,JSON.stringify({type:'session_meta',payload:{id},timestamp:'2026-10-29T10:00:00Z'})+'\n'+JSON.stringify({type:'response_item',payload:{type:'message',role:'developer',content:[{type:'input_text',text:'shared resource instructions'}]}})+'\n');
    expect(await readCodexRuntime(id)).toMatchObject({state:'ready',last_activity_at:null});
    appendFileSync(file,event('task_started',1));expect((await readCodexRuntime(id)).state).toBe('running');
    appendFileSync(file,event('turn_aborted',2));expect((await readCodexRuntime(id)).state).toBe('interrupted');
  });
  it('persists bulk ignore per user/native thread without sending answers or hiding later questions',async()=>{
    const database=createTestDatabase(),app=Fastify();
    try {
      const user=createUser({username:'ignore-owner',password:'password1',role:'admin'}),other=createUser({username:'ignore-other',password:'password1'});
      const cookie=`agentmanager_session=${createSession(user.id)}`;
      getDb().prepare("INSERT INTO sessions(id,task,status,cli_type,codex_session_id,created_by_user_id) VALUES ('ignore-s','Task','completed','codex',?,?)").run(id,user.id);
      const question=(call:string)=>event('item_completed',1,{thread_id:id,item:{type:'AgentMessage',id:call,delivery:'async',questions:[{title:call,options:['A','B']}]}});
      writeFileSync(file,question('old-a')+question('old-b')+event('task_complete',2));
      app.addHook('onRequest',authHook);await app.register(sessionRoutes,{prefix:'/api'});
      const list=async()=> (await app.inject({url:'/api/sessions',headers:{cookie}})).json().sessions[0].agent_runtime;
      const before=await list(),ids=before.pending_questions.flatMap((group:any)=>group.questions.map((q:any)=>q.id));expect(before.pending_question_count).toBe(2);
      const request={method:'POST' as const,url:'/api/sessions/ignore-s/questions/ignore',headers:{cookie},payload:{question_ids:ids}};
      expect((await app.inject({...request,headers:{cookie:`agentmanager_session=${createSession(other.id)}`}})).statusCode).toBe(404);
      expect((await app.inject({...request,payload:{question_ids:['unrelated']}})).statusCode).toBe(409);
      expect((await app.inject(request)).statusCode).toBe(200);
      expect(await list()).toMatchObject({state:'idle',pending_question_count:0,ignored_question_ids:ids});
      expect(await readCodexRuntime(id)).toMatchObject({pending_question_count:2});
      appendFileSync(file,question('new-c'));
      expect((await list()).pending_question_count).toBe(1);
      expect((await app.inject({...request,payload:{question_ids:ids,ignored:false}})).statusCode).toBe(200);
      expect((await list()).pending_question_count).toBe(3);
    }finally{await app.close();database.cleanup();}
  });
  it('retains nonblocking questions through completion and unrelated user input, resolving only their explicit native answers',async()=>{
    const questions=[{title:'请选择方案',options:['A','B']}],call='call-pending';
    const record=(payload:unknown)=>JSON.stringify({timestamp:'2026-10-29T10:00:02Z',type:'response_item',payload})+'\n';
    writeFileSync(file,event('task_started',1)+record({type:'function_call',name:'request_user_input_async',call_id:call,arguments:JSON.stringify({questions})})+event('item_completed',2,{item:{type:'AgentMessage',id:call,delivery:'async',questions}})+event('task_complete',3));
    expect(await readCodexRuntime(id)).toMatchObject({state:'idle',pending_question_count:1});
    appendFileSync(file,event('user_message',4,{message:'先处理另一件事'})+event('task_started',5));
    expect(await readCodexRuntime(id)).toMatchObject({state:'running',pending_question_count:1});
    const questionItemId=JSON.stringify(['request_user_input_async',call,0]);
    const answer='<send_user_message_question_reply>\n'+JSON.stringify([{questionItemId,question:'请选择方案',answer:'A'}])+'\n</send_user_message_question_reply>';
    appendFileSync(file,record({type:'message',role:'user',content:[{type:'input_text',text:answer}]}));
    expect(await readCodexRuntime(id)).toMatchObject({state:'running',pending_question_count:0,pending_questions:[]});
  });
  it('restores a confirmed historical image answer whose placeholder split the reply wrapper',async()=>{
    const call='legacy-image-question',questionItemId=JSON.stringify(['request_user_input_async',call,0]);
    const answer='<send_user_message_question_reply>'+JSON.stringify([{questionItemId,question:'查看截图？',answer:'请看图片'}])+'</send_user_message_question_reply>';
    const broken=answer.slice(0,4)+'[Image #1]'+answer.slice(4);
    writeFileSync(file,event('item_completed',1,{item:{type:'AgentMessage',id:call,delivery:'async',questions:[{title:'查看截图？',options:null}]}})+event('task_complete',2));
    expect((await readCodexRuntime(id)).pending_question_count).toBe(1);
    appendFileSync(file,JSON.stringify({type:'response_item',timestamp:'2026-10-29T10:00:03Z',payload:{type:'message',role:'user',content:[{type:'input_text',text:broken},{type:'input_image',image_url:'fixture'}]}})+'\n');
    expect((await readCodexRuntime(id)).pending_question_count).toBe(0);
  });
  it('uses the same public text as the conversation when native images have surrounding text wrappers',async()=>{
    const database=createTestDatabase();try {
    const call='wrapped-image-question',questionItemId=JSON.stringify(['request_user_input_async',call,0]);
    const answer='<send_user_message_question_reply>'+JSON.stringify([{questionItemId,question:'查看截图？',answer:'已确认'}])+'</send_user_message_question_reply>[Image #1]';
    const content=[{type:'input_text',text:answer},{type:'input_text',text:'<image name=[Image #1] path="/project/screenshot.png">'},{type:'input_image',image_url:'data:image/png;base64,AAAA'},{type:'input_text',text:'</image>'}];
    writeFileSync(file,event('item_completed',1,{item:{type:'AgentMessage',id:call,delivery:'async',questions:[{title:'查看截图？',options:null}]}})+event('task_complete',2)+JSON.stringify({type:'response_item',timestamp:'2026-10-29T10:00:03Z',payload:{type:'message',role:'user',content}})+'\n');
    const conversation=await readConversation({cli_type:'codex',codex_session_id:id,project_path:'/project'});
    expect(conversation.messages.at(-1)?.question_replies).toEqual([{question_id:questionItemId,question:'查看截图？',answer:'已确认'}]);
    expect((await readCodexRuntime(id)).pending_question_count).toBe(0);
    appendFileSync(file,event('item_completed',4,{item:{type:'AgentMessage',id:'new-unanswered',delivery:'async',questions:[{title:'另一个问题',options:null}]}}));
    expect((await readCodexRuntime(id)).pending_questions?.map(group=>group.id)).toEqual(['new-unanswered']);
    } finally { database.cleanup(); }
  });
  it('recognizes a large image answer across partial appends without retaining image data in runtime state',async()=>{
    const call='large-image-question',questionItemId=JSON.stringify(['request_user_input_async',call,0]);
    const answer='<send_user_message_question_reply>'+JSON.stringify([{questionItemId,question:'查看大图？',answer:'确认'}])+'</send_user_message_question_reply>';
    writeFileSync(file,event('item_completed',1,{item:{type:'AgentMessage',id:call,delivery:'async',questions:[{title:'查看大图？',options:null}]}})+event('task_complete',2));
    expect((await readCodexRuntime(id)).pending_question_count).toBe(1);
    const record=JSON.stringify({type:'response_item',timestamp:'2026-10-29T10:00:03Z',payload:{type:'message',role:'user',content:[{type:'input_text',text:answer},{type:'input_text',text:'<image name=[Image #1] path="/project/large.png">'},{type:'input_image',image_url:'data:image/png;base64,'+'A'.repeat(700*1024)},{type:'input_text',text:'</image>'}]}})+'\n';
    appendFileSync(file,record.slice(0,-20));expect((await readCodexRuntime(id)).pending_question_count).toBe(1);
    appendFileSync(file,record.slice(-20));const runtime=await readCodexRuntime(id);expect(runtime.pending_question_count).toBe(0);expect(JSON.stringify(runtime).length).toBeLessThan(2000);
  });
  it('finds an unanswered question outside both the runtime tail and current chat page without retaining a large tool result',async()=>{
    const questions=[{title:'更早的提问',options:null}];
    writeFileSync(file,event('item_completed',1,{item:{type:'AgentMessage',id:'old-question',delivery:'async',questions}})
      +JSON.stringify({type:'response_item',payload:{type:'function_call_output',output:'x'.repeat(5*1024*1024)}})+'\n'+event('task_complete',3));
    const runtime=await readCodexRuntime(id);
    expect(runtime).toMatchObject({state:'idle',pending_question_count:1,pending_questions:[{id:'old-question',questions:[{title:'更早的提问'}]}]});
    expect(JSON.stringify(runtime).length).toBeLessThan(2000);
  });
  it('reports a failed turn instead of idle when completion carries a model error',async()=>{
    writeFileSync(file,event('task_started',1,{turn_id:'failed'})+event('task_complete',2,{turn_id:'failed',error:{message:'Selected model is at capacity.',codex_error_info:'server_overloaded'}}));
    expect(await readCodexRuntime(id)).toMatchObject({state:'failed',last_activity_at:'2026-10-29T10:00:02.000Z'});
    appendFileSync(file,event('task_started',3,{turn_id:'retry'}));expect((await readCodexRuntime(id)).state).toBe('running');
  });
  it('preserves running status through quiet periods and ignores bookkeeping/mtime/PTY clocks',async()=>{
    writeFileSync(file,event('task_started',1,{turn_id:'a'})+event('agent_reasoning',2));
    expect(await readCodexRuntime(id)).toMatchObject({state:'running',last_activity_at:'2026-10-29T10:00:02.000Z'});
    appendFileSync(file,event('token_count',20)+JSON.stringify({timestamp:'2026-10-29T11:00:00Z',type:'session_meta',payload:{id}})+'\n');
    utimesSync(file,new Date(),new Date());
    expect(await readCodexRuntime(id)).toMatchObject({state:'running',last_activity_at:'2026-10-29T10:00:02.000Z'});
    expect(await readCodexRuntime(id)).toMatchObject({state:'running',last_activity_at:'2026-10-29T10:00:02.000Z'});
  });
  it('uses exact native tool events, handles partial JSON, and waits for actual task completion',async()=>{
    writeFileSync(file,event('task_started',1,{turn_id:'a'}));
    const call=JSON.stringify({timestamp:'2026-10-29T10:00:03Z',type:'response_item',payload:{type:'function_call',name:'request_user_input',call_id:'question',arguments:'private'}})+'\n';
    appendFileSync(file,call.slice(0,60)); expect((await readCodexRuntime(id)).state).toBe('running');
    appendFileSync(file,call.slice(60)); expect((await readCodexRuntime(id)).state).toBe('waiting_for_input');
    appendFileSync(file,JSON.stringify({timestamp:'2026-10-29T10:00:04Z',type:'response_item',payload:{type:'function_call_output',call_id:'question',output:'private'}})+'\n');
    expect((await readCodexRuntime(id)).state).toBe('running');
    appendFileSync(file,event('task_complete',5,{turn_id:'a'}));
    const runtime=await readCodexRuntime(id);expect(runtime).toMatchObject({state:'idle',last_activity_at:'2026-10-29T10:00:05.000Z',completed_turn_id:'a'});
    expect(JSON.stringify(runtime)).not.toContain('private');
  });
  it('does not let another turn completion or another thread override the active turn',async()=>{
    writeFileSync(file,event('task_started',1,{turn_id:'old'})+event('task_started',2,{turn_id:'new'})+event('turn_aborted',3,{turn_id:'old'})+event('task_complete',4,{turn_id:'elsewhere',thread_id:'other'}));
    expect(await readCodexRuntime(id)).toMatchObject({state:'running',last_activity_at:'2026-10-29T10:00:03.000Z'});
    appendFileSync(file,event('turn_aborted',5,{turn_id:'new'}));expect((await readCodexRuntime(id)).state).toBe('interrupted');
  });
  it('recovers after file replacement and never substitutes a different conversation for missing logs',async()=>{
    writeFileSync(file,event('task_complete',1));expect((await readCodexRuntime(id)).state).toBe('idle');
    writeFileSync(file,event('task_started',2));expect((await readCodexRuntime(id)).state).toBe('running');
    expect(await readCodexRuntime('019ff001-2222-7222-8222-222222222222')).toMatchObject({state:'unknown',last_activity_at:null});
    expect(await readCodexRuntime(null)).toMatchObject({state:'unknown',last_activity_at:null});
  });
  it('returns only authorized native timestamps in the session list despite newer terminal output',async()=>{
    const database=createTestDatabase(); const app=Fastify();
    try {
      const user=createUser({username:'native-owner',password:'password1',role:'admin'});
      const cookie=`agentmanager_session=${createSession(user.id)}`;
      getDb().prepare("INSERT INTO projects(id,name,path,owner_id) VALUES ('native-p','Native',?,?)").run(dir,user.id);
      getDb().prepare("INSERT INTO sessions(id,project_id,task,status,cli_type,codex_session_id,created_by_user_id) VALUES ('native-s','native-p','Task','running','codex',?,?)").run(id,user.id);
      getDb().prepare("INSERT INTO pty_output(session_id,seq,data,created_at) VALUES ('native-s',1,'screen repaint','2099-01-01 00:00:00')").run();
      writeFileSync(file,event('task_started',1));vi.spyOn(manager,'getLiveWorkAgent').mockResolvedValue('codex');
      app.addHook('onRequest',authHook); await app.register(sessionRoutes,{prefix:'/api'});
      const first=await app.inject({url:'/api/sessions',headers:{cookie}});
      expect(first.json().sessions[0]).toMatchObject({last_activity_at:'2026-10-29T10:00:01.000Z',agent_runtime:{source:'codex_rollout',state:'running'}});
      const second=await app.inject({url:'/api/sessions',headers:{cookie}});
      expect(second.json().sessions[0].last_activity_at).toBe(first.json().sessions[0].last_activity_at);
      vi.mocked(manager.getLiveWorkAgent).mockResolvedValue(null);
      expect((await app.inject({url:'/api/sessions',headers:{cookie}})).json().sessions[0].agent_runtime.state).toBe('unknown');
      const other=createUser({username:'native-other',password:'password1'});
      expect((await app.inject({url:'/api/sessions',headers:{cookie:`agentmanager_session=${createSession(other.id)}`}})).json().sessions).toEqual([]);
    } finally {await app.close();database.cleanup();}
  });
});
