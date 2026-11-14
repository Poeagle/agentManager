import {targetSupportsQuota} from '../src/services/agents/scheduling.js';
import {attachManagedAgent,observeAgentConversation,detachManagedAgents,isManagedAgentActive} from '../src/services/agents/host.js';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,writeFileSync,rmSync,mkdirSync} from 'fs';
import {join} from 'path';import {tmpdir} from 'os';
import Fastify from 'fastify';
import {registerAgent,getAgent,agentContext,agentDescriptors} from '../src/services/agents/index.js';
import {capabilities,type AgentDefinition,type AgentAdapter,type AgentControls} from '../src/services/agents/types.js';
import {linkConversationInputs} from '../src/services/conversation-input-links.js';
import {readConversation} from '../src/services/conversation-reader.js';
import {loadRecentPromptContext} from '../src/services/prompt-context.js';
import {nativeConversationId} from '../src/services/session-identity.js';
import {buildSessionCommand} from '../src/services/cli-command.js';
import {sessionClients} from '../src/services/session-clients.js';
import {createTestDatabase} from './helpers/database.js';
import {getDb} from '../src/db/index.js';
import {authHook,createUser,createSession,userCanUseToolForProject} from '../src/auth.js';
import {agentRoutes} from '../src/routes/agent.js';
import {sessionRoutes} from '../src/routes/sessions.js';
import * as manager from '../src/services/session-manager.js';

const controls=(native_id:string):AgentControls=>({model:'future-model',effort:'standard',provider:'future-provider',cwd:null,cli_version:null,engine_version:null,installed_cli_version:null,git:null,state:'idle',permission:null,approval:null,service_tier:null,usage:null,limits:[],usage_observed_at:null,models:[{model:'future-model',name:'Future model',description:'fixture',efforts:[{value:'standard',description:''}],defaultEffort:'standard'}],loaded:true,warning:null,native_id,checked_at:new Date().toISOString()});
function fixture(path:string):AgentAdapter {
 const decode=(record:any)=>({role:record.speaker as 'user'|'assistant',phase:record.speaker==='user'?'user' as const:'final' as const,text:record.body as string,timestamp:record.when as string});
 return {
  descriptor:{sessionHost:'managed',id:'fixture_agent',label:'Fixture Agent',capabilities:capabilities(['history','runtime','controls','model','launch','resume','input','stream','attachments']),presentation:{icon:'agent',color:'#123456'}},
  identity:{read:()=>null},history:{file:{locate:async()=>path,decode:entries=>[...entries].map(decode),project:bytes=>{const entry=JSON.parse(bytes.toString());return {message:decode(entry),recordType:'native_message',imagePaths:[]};},recordLimit:()=>512*1024,questionCall:()=>null,relevant:()=>true,turns:entries=>{const messages=[...entries].map(decode);return [{user:messages[0].text,assistant:messages[1].text}];}},read:async()=>null},
  runtime:{read:async context=>({source:'fixture_events',session_id:context.nativeId,state:'idle',last_activity_at:null,observed_at:new Date().toISOString(),reason:'fixture'}),subscribe:()=>()=>{}},
  controls:{read:async context=>controls(context.nativeId!),validate:async(_context,value)=>value as {model:string;effort:string},apply:vi.fn(async(_context,value)=>value)},
  telemetry:{read:async()=>({usage:null,observed_at:null})},statistics:{read:async()=>[]},quota:{read:async()=>{throw Error('unsupported');}},retry:{retryable:()=>false,inspect:async()=>{throw Error('unsupported');},start:async()=>{throw Error('unsupported');}},
  input:{submit:vi.fn(async()=>true),afterTerminalSubmit:async()=>{}},stream:{observe:()=>Object.assign(()=>{},{respond:()=>{}})},
  lifecycle:{preflight:async()=>null,bind:async()=>{},compact:async()=>{},prepareFresh:async()=> 'opaque/new/thread',release:async()=>{},interrupt:async()=>{}},
  launch:{prepare:async()=>({nativeId:'opaque/thread:1'}),ready:async()=>{}},commands:{configure:command=>command,build:options=>`fixture --native ${options.resumeId||options.assignId||'new'}`,permissions:command=>command,sharedResources:command=>command},
 };
}
let unregister:(()=>void)|undefined;
afterEach(()=>{detachManagedAgents();unregister?.();unregister=undefined;vi.restoreAllMocks();});
describe('provider-neutral agent features',()=>{
 it('registers an agent with an opaque native ID and its own log syntax, without a vendor branch',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'agent-contract-')),path=join(dir,'history.log');
  try{
   writeFileSync(path,JSON.stringify({speaker:'user',body:'question',when:'2026-11-04T00:00:00Z'})+'\n'+JSON.stringify({speaker:'assistant',body:'answer',when:'2026-11-04T00:00:01Z'})+'\n');
   const adapter=fixture(path);unregister=registerAgent(adapter);
   const binding={agent_id:adapter.descriptor.id,cli_type:adapter.descriptor.id,native_session_id:'opaque/thread:1',codex_session_id:null,claude_session_id:null,project_path:dir};
   expect(nativeConversationId(binding)).toBe('opaque/thread:1');expect(agentContext(binding).nativeId).toBe('opaque/thread:1');
   expect(sessionClients()).toContainEqual({id:'fixture_agent',label:'Fixture Agent'});
   expect((await readConversation(binding)).messages.map(message=>message.text)).toEqual(['question','answer']);
   expect(await loadRecentPromptContext(binding,1)).toEqual([{user:'question',assistant:'answer'}]);
   expect(buildSessionCommand('',false,'fixture','fixture_agent','opaque/thread:1')).toBe('fixture --native opaque/thread:1');
   expect(()=>registerAgent(adapter)).toThrow('already registered');
   expect(()=>getAgent('unknown_provider')).toThrow('Unknown agent');
  }finally{rmSync(dir,{recursive:true,force:true});}
 });
 it('uses the same HTTP controls, runtime and project authorization for a third provider',async()=>{
  const database=createTestDatabase(),app=Fastify(),path=join(database.dir,'future.log');
  try{
   writeFileSync(path,'');const adapter=fixture(path);unregister=registerAgent(adapter);
   const user=createUser({username:'adapter-admin',password:'password1',role:'admin'}),cookie=`agentmanager_session=${createSession(user.id)}`;
   getDb().prepare("INSERT INTO projects(id,name,path,owner_id) VALUES('adapter-p','Adapters',?,?)").run(database.dir,user.id);
   getDb().prepare("INSERT INTO sessions(id,project_id,task,status,cli_type,native_session_id,created_by_user_id) VALUES('adapter-s','adapter-p','Task','running','fixture_agent','opaque/thread:1',?)").run(user.id);
   vi.spyOn(manager,'isSessionActive').mockReturnValue(true);
   app.addHook('onRequest',authHook);await app.register(agentRoutes,{prefix:'/api'});await app.register(sessionRoutes,{prefix:'/api'});
   expect(userCanUseToolForProject(user.id,'adapter-p','session','fixture_agent')).toBe(true);
   vi.spyOn(adapter.commands,'configure').mockImplementation(()=>{throw Error('A service agent must not start a terminal');});
   await manager.spawnSession('adapter-s',database.dir,'Fixture task',120,40,'fixture_agent');expect(isManagedAgentActive('adapter-s')).toBe(true);
   const read=await app.inject({url:'/api/sessions/adapter-s/controls',headers:{cookie}});expect(read.statusCode).toBe(200);expect(read.json()).toMatchObject({agent:{id:'fixture_agent'},native_id:'opaque/thread:1',can_edit:true});
   const update=await app.inject({method:'PUT',url:'/api/sessions/adapter-s/controls',headers:{cookie},payload:{model:'future-model',effort:'standard'}});expect(update.statusCode).toBe(200);expect(adapter.controls.apply).toHaveBeenCalledOnce();
   const sent=await app.inject({method:'POST',url:'/api/sessions/adapter-s/input',headers:{cookie},payload:{input:'Continue',source:'conversation',client_id:'fixture-client'}});expect(sent.statusCode).toBe(202);expect(adapter.input.submit).toHaveBeenCalledOnce();
   expect(getDb().prepare('SELECT client_id FROM conversation_input_links WHERE session_id=?').get('adapter-s')).toEqual({client_id:'fixture-client'});
   const pastes=join(database.dir,'.agentmanager','pastes');mkdirSync(pastes,{recursive:true});const image=join(pastes,'fixture.png');writeFileSync(image,Buffer.from([137,80,78,71,13,10,26,10]));
   const attached=await app.inject({method:'POST',url:'/api/sessions/adapter-s/input',headers:{cookie},payload:{input:'确认',source:'conversation',client_id:'image-client',attachments:[{kind:'image',name:'fixture.png',path:image,offset:0}]}});expect(attached.statusCode).toBe(202);
   const linked=linkConversationInputs('adapter-s','opaque/thread:1',[{id:'native-image',sequence:0,role:'user',text:'[Image #1]确认',timestamp:null}]);expect(linked[0].client_id).toBe('image-client');
   const sessions=(await app.inject({url:'/api/sessions',headers:{cookie}})).json().sessions;expect(sessions[0]).toMatchObject({agent_id:'fixture_agent',native_session_id:'opaque/thread:1',agent_runtime:{source:'fixture_events',state:'idle'}});
   const providers=(await app.inject({url:'/api/agent/providers',headers:{cookie}})).json().agents;expect(providers.some((agent:any)=>agent.id==='fixture_agent')).toBe(true);
   const other=createUser({username:'adapter-other',password:'password1'});expect((await app.inject({url:'/api/sessions/adapter-s/controls',headers:{cookie:`agentmanager_session=${createSession(other.id)}`}})).statusCode).toBe(404);
  }finally{await app.close();database.cleanup();}
 });
 it('creates a session without an initial task and still accepts explicit API tasks',async()=>{
  const database=createTestDatabase(),app=Fastify();
  try{
   const adapter=fixture(join(database.dir,'history'));unregister=registerAgent(adapter);
   const user=createUser({username:'empty-admin',password:'password1',role:'admin'}),headers={cookie:`agentmanager_session=${createSession(user.id)}`};
   getDb().prepare("INSERT INTO projects(id,name,path,owner_id) VALUES('empty-p','Empty',?,?)").run(database.dir,user.id);
   app.addHook('onRequest',authHook);await app.register(sessionRoutes,{prefix:'/api'});
   const create=(task?:unknown)=>app.inject({method:'POST',url:'/api/sessions',headers,payload:{project_path:database.dir,project_id:'empty-p',mode:'session',cli_type:'fixture_agent',...(task===undefined?{}:{task})}});
   for(const task of [undefined,'','explicit requirement']){
    const response=await create(task);expect(response.statusCode).toBe(200);expect(response.json().session.task).toBe(task??'');
    expect(isManagedAgentActive(response.json().session.id)).toBe(true);
   }
   expect((await create({bad:true})).statusCode).toBe(400);
  }finally{await app.close();database.cleanup();}
 });
 it('reads service-backed history without requiring a local file or native CLI format',async()=>{
  const adapter=fixture('/not-a-local-file');adapter.history.file={...adapter.history.file!,locate:async()=>{throw Error('Local history must not be read');}};
  adapter.history.read=async()=>({messages:[{id:'remote-message',role:'assistant',text:'Remote reply',timestamp:null,phase:'final'}],has_more:false,available:true,reset:false,generation:'service'});
  unregister=registerAgent(adapter);expect((await readConversation({cli_type:'fixture_agent',native_session_id:'remote/session',project_path:null,codex_session_id:null,claude_session_id:null})).messages[0].text).toBe('Remote reply');
 });
 it('shares one service connection, forwards failures and detaches without recreating or submitting a native task',async()=>{
  const database=createTestDatabase();
  try{
   const adapter=fixture('/unused'),stop=vi.fn();let emit:Parameters<typeof adapter.stream.observe>[1],failure:Parameters<typeof adapter.stream.observe>[2];
   const observe=vi.spyOn(adapter.stream,'observe').mockImplementation((_context,send,onFailure)=>{emit=send;failure=onFailure;return Object.assign(stop,{respond:()=>{}});});
   unregister=registerAgent(adapter);getDb().prepare("INSERT INTO sessions(id,task,status,cli_type,native_session_id) VALUES('managed-stream','Fixture','running','fixture_agent','opaque/native')").run();
   const session=manager.getSession('managed-stream')!;attachManagedAgent(session);const first=vi.fn(),second=vi.fn(),onFailure=vi.fn();
   const one=observeAgentConversation(session,first,onFailure),two=observeAgentConversation(session,second);
   emit!({type:'queue',messages:[]});failure!('failed-turn',new Error('fixture'),false);
   expect(observe).toHaveBeenCalledOnce();expect(first).toHaveBeenCalledOnce();expect(second).toHaveBeenCalledOnce();expect(onFailure).toHaveBeenCalledOnce();
   one();two();expect(isManagedAgentActive(session.id)).toBe(true);expect(adapter.input.submit).not.toHaveBeenCalled();
   detachManagedAgents();expect(stop).toHaveBeenCalledOnce();expect(isManagedAgentActive(session.id)).toBe(false);
  }finally{detachManagedAgents();database.cleanup();}
 });
 it('requires dialogue but allows a service agent to omit CLI, file codecs and optional feature implementations',async()=>{
  const base=fixture('/unused');
  const minimal:AgentDefinition={descriptor:{...base.descriptor,capabilities:capabilities(['input','stream','history','runtime'])},
   history:{read:async()=>({messages:[],has_more:false,reset:false,available:true,generation:null})},runtime:{read:base.runtime.read},input:{submit:base.input.submit},stream:base.stream};
  unregister=registerAgent(minimal);expect(getAgent('fixture_agent').history.file).toBeUndefined();
  await expect(getAgent('fixture_agent').quota.read()).rejects.toMatchObject({code:'AGENT_FEATURE_UNSUPPORTED',feature:'quota'});
  unregister();unregister=undefined;minimal.descriptor.capabilities.input=false;expect(()=>registerAgent(minimal)).toThrow('conversation capability input');
 });
 it('uses quota capabilities for a third provider and preserves terminal-task restrictions',()=>{
  const database=createTestDatabase();
  try{
   const adapter=fixture('/unused');adapter.descriptor.capabilities.quota=true;unregister=registerAgent(adapter);
   getDb().prepare("INSERT INTO sessions(id,task,status,cli_type,mode) VALUES('quota-session','Task','completed','fixture_agent','session'),('quota-terminal','Terminal','completed','fixture_agent','terminal')").run();
   expect(targetSupportsQuota({target_type:'new',new_cli_type:'fixture_agent',new_mode:'session'})).toBe(true);
   expect(targetSupportsQuota({target_type:'new',new_cli_type:'fixture_agent',new_mode:'terminal'})).toBe(false);
   expect(targetSupportsQuota({target_type:'existing',target_session_id:'quota-session'})).toBe(true);
   expect(targetSupportsQuota({target_type:'existing',target_session_id:'quota-terminal'})).toBe(false);
  }finally{database.cleanup();}
 });
 it('rejects incomplete implementations at registration, before exposing capabilities',()=>{
  const adapter=fixture('/unused');delete (adapter as any).controls;
  expect(()=>registerAgent(adapter)).toThrow('Missing agent implementation');const malformed=fixture('/unused');malformed.history.file={} as any;expect(()=>registerAgent(malformed)).toThrow('history.file.locate');expect(agentDescriptors().some(agent=>agent.id==='fixture_agent')).toBe(false);
 });
});
