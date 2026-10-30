import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import {appendFileSync,mkdirSync,writeFileSync} from 'fs';
import {join} from 'path';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {authHook,createUser} from '../src/auth.js';
import {getDb} from '../src/db/index.js';
import {agentRoutes} from '../src/routes/agent.js';
import {sessionRoutes} from '../src/routes/sessions.js';
import {projectRoutes} from '../src/routes/projects.js';
import {executePlatformTool} from '../src/services/platform-ai/tools.js';
import {getConversation,receiveMessage} from '../src/services/platform-ai/store.js';
import {readConversation} from '../src/services/conversation-reader.js';
import {progressExcerpt} from '../src/services/platform-ai/tab-progress.js';
import {createTestDatabase} from './helpers/database.js';

const nativeId='019ff001-1212-7121-8121-121212121212';
let app:ReturnType<typeof Fastify>,cleanup:()=>void,file:string,owner:string,conversationId:string;
const record=(type:string,payload:unknown,timestamp='2026-10-30T08:00:00Z')=>JSON.stringify({type,payload,timestamp})+'\n';
const user=(text:string,timestamp?:string)=>record('event_msg',{type:'user_message',message:text},timestamp);
const progress=(text:string,timestamp?:string)=>record('event_msg',{type:'agent_message',message:text},timestamp);
beforeEach(async()=>{
  const fixture=createTestDatabase();cleanup=fixture.cleanup;vi.stubEnv('CODEX_HOME',fixture.dir);
  mkdirSync(join(fixture.dir,'sessions'));
  file=join(fixture.dir,'sessions',`rollout-${nativeId}.jsonl`);
  owner=createUser({username:'owner',password:'password1',role:'admin'}).id;
  getDb().prepare("INSERT INTO projects(id,name,path,owner_id) VALUES ('p','Project',?,?)").run(fixture.dir,owner);
  getDb().prepare("INSERT INTO sessions(id,project_id,task,status,mode,cli_type,codex_session_id,created_by_user_id) VALUES ('tab','p','Task','running','terminal','codex',?,?)").run(nativeId,owner);
  conversationId=receiveMessage({userId:owner,externalUserId:owner,chatId:'private-a',messageId:'first',content:'进度'}).conversation_id;
  app=Fastify();await app.register(websocket);app.addHook('onRequest',authHook);
  await app.register(projectRoutes,{prefix:'/api'});await app.register(sessionRoutes,{prefix:'/api'});await app.register(agentRoutes,{prefix:'/api'});
});
afterEach(async()=>{await app.close();vi.unstubAllEnvs();cleanup();});
const read=(detail=false,chat=conversationId)=>executePlatformTool(app,getConversation(chat)!,'read_tab',JSON.stringify({session_id:'tab',detail}),'read');
const retain=(result:unknown,chat=conversationId)=>getDb().prepare('UPDATE platform_ai_conversations SET context=? WHERE id=?')
  .run(JSON.stringify([{role:'tool',content:JSON.stringify(result)}]),chat);

describe('compact AI reads reuse the dashboard public conversation',()=>{
  it('uses the same public text, clips old and long progress, excludes tools, reasoning and attachment bodies',async()=>{
    const latest='当前在验证部署。'+'中间细节'.repeat(3000)+'末尾：等待服务健康检查。';
    writeFileSync(file,user('old request')+progress('OLD_ANSWER')+user('修复部署')
      +progress('EARLY_PROGRESS')+progress(latest,'2026-10-30T08:02:00Z')
      +record('response_item',{type:'reasoning',text:'HIDDEN_REASONING'})
      +record('response_item',{type:'function_call',arguments:'PRIVATE_ARGUMENTS'})
      +record('response_item',{type:'function_call_output',output:'PRIVATE_OUTPUT'}));
    const full=await readConversation({cli_type:'codex',codex_session_id:nativeId,claude_session_id:null,project_path:null});
    expect(full.messages.at(-1)?.text).toBe(latest);
    const result=await read();
    expect(result).toMatchObject({output_source:'conversation',tab_name:expect.any(String),messages_omitted:true,latest_update_local:'2026-10-30 16:02:00'});
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].text).toBe('修复部署');
    expect(result.messages[1].text).toContain('当前在验证部署。');
    expect(result.messages[1].text).toContain('等待服务健康检查。');
    expect(result.messages[1].text.length).toBeLessThanOrEqual(1000);
    expect(JSON.stringify(result)).not.toMatch(/OLD_ANSWER|EARLY_PROGRESS|PRIVATE_OUTPUT|PRIVATE_ARGUMENTS|HIDDEN_REASONING/);
    expect(JSON.stringify(result).length).toBeLessThan(2300);
    const detail=await read(true);
    expect(detail.messages.map((message:any)=>message.text).join('')).toContain('EARLY_PROGRESS');
    expect(detail.messages.reduce((size:number,message:any)=>size+message.text.length,0)).toBeLessThanOrEqual(6000);
  });
  it('omits unchanged text only while it is retained in this user conversation',async()=>{
    writeFileSync(file,user('修复部署')+progress('正在验证服务'));const first=await read();retain(first);
    const repeated=await read();expect(repeated.unchanged).toBe(true);expect(repeated).not.toHaveProperty('messages');
    expect(JSON.stringify(repeated)).not.toContain('正在验证服务');
    const otherChat=receiveMessage({userId:owner,externalUserId:owner,chatId:'private-b',messageId:'other',content:'进度'}).conversation_id;
    expect((await read(false,otherChat)).messages.at(-1).text).toBe('正在验证服务');
    getDb().prepare("UPDATE platform_ai_conversations SET context='[]' WHERE id=?").run(conversationId);
    expect((await read()).messages.at(-1).text).toBe('正在验证服务'); // Compacted history requires a fresh body.
    retain(first);appendFileSync(file,progress('健康检查通过','2026-10-30T08:03:00Z'));
    const updated=await read();expect(updated.unchanged).not.toBe(true);expect(updated.messages.at(-1).text).toBe('健康检查通过');
  });
  it('does not reuse an earlier final reply after a new user input, and tracks native running state',async()=>{
    writeFileSync(file,user('上一轮')+record('event_msg',{type:'task_complete',last_agent_message:'上轮已完成'})+user('新的任务','2026-10-30T08:03:00Z')
      +record('event_msg',{type:'task_started',turn_id:'new'},'2026-10-30T08:03:01Z'));
    const result=await read();expect(result.messages.map((message:any)=>message.text)).toEqual(['新的任务']);
    expect(result.process_state).toBe('busy');expect(JSON.stringify(result)).not.toContain('上轮已完成');
    const tabs=await executePlatformTool(app,getConversation(conversationId)!,'list_project_tabs',JSON.stringify({project_id:'p'}),'list');
    expect(tabs.tabs[0].latest_agent_message).toBeNull();
  });
  it('retains authorization on repeated reads and reuses project previews without fetching whole histories',async()=>{
    writeFileSync(file,user('部署')+progress('正在部署'.repeat(500)));
    const first=await executePlatformTool(app,getConversation(conversationId)!,'list_project_tabs',JSON.stringify({project_id:'p'}),'list');
    expect(first.tabs[0].latest_agent_message.text.length).toBeLessThanOrEqual(240);retain(first);
    const second=await executePlatformTool(app,getConversation(conversationId)!,'list_project_tabs',JSON.stringify({project_id:'p'}),'list');
    expect(second.tabs[0].unchanged).toBe(true);expect(second.tabs[0]).not.toHaveProperty('latest_agent_message');
    const member=createUser({username:'not-owner',password:'password1'}).id;
    const received=receiveMessage({userId:member,externalUserId:member,chatId:'private',messageId:'private',content:'进度'});
    await expect(read(false,received.conversation_id)).rejects.toThrow('404');
  });
  it('keeps even very small excerpt budgets bounded',()=>{
    for(const limit of [0,1,10,30,1000])expect(progressExcerpt('x'.repeat(10000),limit).length).toBeLessThanOrEqual(limit);
  });
});
