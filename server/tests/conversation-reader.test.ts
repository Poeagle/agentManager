import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {appendFileSync,mkdirSync,writeFileSync} from 'fs';
import {join} from 'path';
import Fastify,{type FastifyInstance} from 'fastify';
import websocket from '@fastify/websocket';
import {createTestDatabase} from './helpers/database.js';
import {authHook,createSession,createUser} from '../src/auth.js';
import {getDb} from '../src/db/index.js';
import {agentRoutes} from '../src/routes/agent.js';
import {conversationMessageId,readConversation} from '../src/services/conversation-reader.js';

const id='019ff001-6666-7666-8666-666666666666';
let app:FastifyInstance,cleanup:()=>void,file:string,cookie:string;
const binding={cli_type:'codex' as const,codex_session_id:id,claude_session_id:null,project_path:'/project'};
const line=(type:string,payload:unknown,stamp='2026-10-29T10:00:00Z')=>JSON.stringify({type,timestamp:stamp,payload})+'\n';
const user=(text:string,stamp?:string)=>line('event_msg',{type:'user_message',message:text},stamp);
const final=(text:string,stamp?:string)=>line('event_msg',{type:'task_complete',last_agent_message:text},stamp);
beforeEach(async()=>{
  const db=createTestDatabase();cleanup=db.cleanup;vi.stubEnv('CODEX_HOME',db.dir);mkdirSync(join(db.dir,'sessions'));
  file=join(db.dir,'sessions',`rollout-test-${id}.jsonl`);
  const owner=createUser({username:'chat-owner',password:'password1',role:'admin'});
  cookie=`agentmanager_session=${createSession(owner.id)}`;
  getDb().prepare("INSERT INTO projects(id,name,path,owner_id) VALUES ('p','Chat',?,?)").run(db.dir,owner.id);
  getDb().prepare("INSERT INTO sessions(id,project_id,task,status,mode,cli_type,codex_session_id,created_by_user_id) VALUES ('chat','p','Task','completed','session','codex',?,?)").run(id,owner.id);
  app=Fastify();await app.register(websocket);app.addHook('onRequest',authHook);await app.register(agentRoutes,{prefix:'/api'});
});
afterEach(async()=>{await app.close();vi.unstubAllEnvs();cleanup();});
describe('public conversation pages',()=>{
  it('restores a native capacity error from task completion and excludes private details and tool errors',async()=>{
    writeFileSync(file,user('执行任务')+line('response_item',{type:'function_call_output',error:{message:'PRIVATE TOOL FAILURE'},output:'PRIVATE RESULT'})
      +line('event_msg',{type:'agent_message',message:'正在处理'})
      +line('event_msg',{type:'task_complete',turn_id:'capacity-turn',last_agent_message:null,error:{message:'Selected model is at capacity. Please try a different model.',codex_error_info:'server_overloaded',additionalDetails:'PRIVATE REQUEST'}}));
    const result=await app.inject({url:'/api/sessions/chat/conversation',headers:{cookie}});
    expect(result.statusCode).toBe(200);const messages=result.json().messages;
    expect(messages).toHaveLength(3);expect(messages[2]).toMatchObject({phase:'error',role:'assistant',turn_id:'capacity-turn',text:'Selected model is at capacity. Please try a different model.',error:{code:'server_overloaded',will_retry:false}});
    expect(result.body).not.toContain('PRIVATE');expect((await readConversation(binding)).messages[2].id).toBe(messages[2].id);
    expect((await readConversation(binding,{after:messages[1].id})).messages).toHaveLength(1);
  });
  it('shows user messages, agent progress and final text while excluding tool records',async()=>{
    writeFileSync(file,user('修复问题')
      +line('response_item',{type:'message',role:'user',content:[{type:'input_text',text:'修复问题'}]})
      +line('response_item',{type:'reasoning',text:'hidden reasoning'})
      +line('response_item',{type:'function_call',arguments:'secret arguments'})
      +line('response_item',{type:'function_call_output',output:'private tool output'})
      +line('event_msg',{type:'agent_message',message:'中间进展'})
      +line('response_item',{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'已完成。'}]})+final('已完成。'));
    const result=await app.inject({url:'/api/sessions/chat/conversation',headers:{cookie}});
    expect(result.statusCode).toBe(200);expect(result.headers['cache-control']).toContain('no-store');
    expect(result.json().messages.map((message:{text:string})=>message.text)).toEqual(['修复问题','中间进展','已完成。']);
    expect(result.body).not.toMatch(/secret arguments|private tool output|hidden reasoning/);
    expect(getDb().prepare('SELECT COUNT(*) n FROM platform_ai_tasks').get()).toEqual({n:0});
  });
  it('uses native user identity and log order even with equal or decreasing timestamps',async()=>{
    const record=(role:string,id:string,text:string,stamp:string)=>line('response_item',{type:'message',id,role,phase:role==='assistant'?'final_answer':undefined,internal_chat_message_metadata_passthrough:{turn_id:'turn'},content:[{type:role==='user'?'input_text':'output_text',text}]},stamp);
    writeFileSync(file,record('user','q1','继续','2030-01-01')+record('assistant','a1','第一答复','2030-01-01')+record('user','q2','继续','2020-01-01')+record('assistant','a2','第二答复','2019-01-01'));
    const result=await readConversation(binding);
    expect(result.messages.map(message=>message.id)).toEqual([conversationMessageId('turn','user','q1'),conversationMessageId('turn','assistant','a1'),conversationMessageId('turn','user','q2'),conversationMessageId('turn','assistant','a2')]);
    expect(result.messages.map(message=>message.sequence)).toEqual([...result.messages.map(message=>message.sequence)].sort((a,b)=>a!-b!));
  });
  it('returns only newly appended messages, handles partial UTF-8 and retains long final replies',async()=>{
    writeFileSync(file,user('first')+final('done'));
    const first=await readConversation(binding);const cursor=first.messages.at(-1)!.id;
    expect((await readConversation(binding,{after:cursor})).messages).toEqual([]);
    const next=Buffer.from(user('新问题','2026-10-29T10:01:00Z'));const split=next.indexOf(Buffer.from('新'))+1;
    appendFileSync(file,next.subarray(0,split));expect((await readConversation(binding,{after:cursor})).messages).toEqual([]);
    appendFileSync(file,next.subarray(split));const long='完整结果'.repeat(5000);appendFileSync(file,final(long,'2026-10-29T10:02:00Z'));
    const result=await readConversation(binding,{after:cursor});expect(result.messages.map(message=>message.text)).toEqual(['新问题',long]);
    expect(result.reset).toBe(false);
  });
  it('keeps image messages on cold load and incremental append without exposing inline image data',async()=>{
    const image=(id:string)=>line('response_item',{type:'message',id,role:'user',internal_chat_message_metadata_passthrough:{turn_id:'images'},content:[{type:'input_text',text:`图片问题 ${id}`},{type:'input_text',text:'<image name=[Image #1] path="/project/image.png">'},{type:'input_image',image_url:'data:image/png;base64,'+'A'.repeat(3*1024*1024)},{type:'input_text',text:'</image>'}]});
    writeFileSync(file,image('cold')+final('图像答复'));
    const first=await readConversation(binding);expect(first.messages.map(message=>message.text)).toEqual(['图片问题 cold','图像答复']);expect(JSON.stringify(first).length).toBeLessThan(2000);
    const next=Buffer.from(image('appended'));appendFileSync(file,next.subarray(0,next.length-50));expect((await readConversation(binding,{after:first.messages.at(-1)!.id})).messages).toEqual([]);
    appendFileSync(file,next.subarray(next.length-50));appendFileSync(file,final('第二份图像答复'));
    expect((await readConversation(binding,{after:first.messages.at(-1)!.id})).messages.map(message=>message.text)).toEqual(['图片问题 appended','第二份图像答复']);
  });
  it('pages old messages on demand without tool output displacing conversation',async()=>{
    writeFileSync(file,Array.from({length:80},(_,i)=>user(`q${i}`)+final(`a${i}`)).join(''));
    const latest=await readConversation(binding,{limit:20});expect(latest.messages).toHaveLength(20);expect(latest.has_more).toBe(true);
    const old=await readConversation(binding,{before:latest.messages[0].id,limit:20});expect(old.messages.at(-1)?.text).toBe('a69');
    appendFileSync(file,line('response_item',{type:'function_call_output',output:'x'.repeat(3*1024*1024)}));
    const delta=await readConversation(binding,{after:latest.messages.at(-1)!.id});expect(delta.messages).toEqual([]);
    expect((await readConversation(binding)).messages.at(-1)?.text).toBe('a79');
    expect((await readConversation(binding,{before:'f'.repeat(32),limit:5})).messages.length).toBeLessThanOrEqual(5);
  });
  it('recovers a replaced log and never reads another users session',async()=>{
    writeFileSync(file,user('old'));const first=await readConversation(binding);
    writeFileSync(file,user('new native conversation'));
    expect((await readConversation(binding,{after:first.messages[0].id})).reset).toBe(true);
    const other=createUser({username:'other-chat',password:'password1'});
    const denied=await app.inject({url:'/api/sessions/chat/conversation',headers:{cookie:`agentmanager_session=${createSession(other.id)}`}});
    expect(denied.statusCode).toBe(404);
    expect((await app.inject({url:'/api/sessions/chat/conversation?before=bad',headers:{cookie}})).statusCode).toBe(400);
  });
  it('finds dialogue on cold load even when a giant tool result is the last record',async()=>{
    writeFileSync(file,user('Keep this conversation')+final('Keep this final reply')+line('response_item',{type:'function_call_output',output:'x'.repeat(4*1024*1024)}));
    const result=await readConversation(binding);
    expect(result.messages.map(message=>message.text)).toEqual(['Keep this conversation','Keep this final reply']);
  });
  it('settles a delayed duplicate by native turn identity and preserves identical replies in later turns',async()=>{
    const response=(turn:string,stamp:string)=>line('response_item',{type:'message',role:'assistant',phase:'final_answer',internal_chat_message_metadata_passthrough:{turn_id:turn},content:[{type:'output_text',text:'相同结果'}]},stamp);
    writeFileSync(file,user('first')+response('turn-one','2026-10-29T10:00:00Z'));
    const first=await readConversation(binding);
    appendFileSync(file,line('event_msg',{type:'task_complete',turn_id:'turn-one',last_agent_message:'相同结果'},'2026-10-29T10:00:07Z'));
    expect((await readConversation(binding,{after:first.messages.at(-1)!.id})).messages).toEqual([]);
    expect((await readConversation(binding)).messages.map(item=>item.text)).toEqual(['first','相同结果']);
    appendFileSync(file,user('again','2026-10-29T10:01:00Z')+response('turn-two','2026-10-29T10:01:05Z')+line('event_msg',{type:'task_complete',turn_id:'turn-two',last_agent_message:'相同结果'},'2026-10-29T10:01:15Z'));
    expect((await readConversation(binding)).messages.map(item=>item.text)).toEqual(['first','相同结果','again','相同结果']);
  });
  it('keeps two answer items inside one native turn while removing its completion echo',async()=>{
    const answer=(id:string)=>line('response_item',{type:'message',id,role:'assistant',phase:'final_answer',internal_chat_message_metadata_passthrough:{turn_id:'shared-turn'},content:[{type:'output_text',text:'相同的回答'}]});
    writeFileSync(file,user('问题')+answer('first-item')+answer('second-item')+line('event_msg',{type:'task_complete',turn_id:'shared-turn',last_agent_message:'相同的回答'},'2026-10-29T10:00:10Z'));
    const result=await readConversation(binding);const answers=result.messages.filter(message=>message.role==='assistant');
    expect(answers).toHaveLength(2);expect(answers[0].id).not.toBe(answers[1].id);
  });
});
