import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import Fastify,{type FastifyInstance} from 'fastify';
import websocket from '@fastify/websocket';
import {createServer,type Server} from 'http';
import {WebSocketServer} from 'ws';
import {mkdirSync,writeFileSync,appendFileSync} from 'fs';
import {join} from 'path';
import {createTestDatabase} from './helpers/database.js';
import {authHook,createUser,createSession,setProjectToolAccess} from '../src/auth.js';
import {getDb} from '../src/db/index.js';
import {agentRoutes} from '../src/routes/agent.js';
import * as manager from '../src/services/session-manager.js';
import {readConversationTelemetry,readModelPreference,saveModelPreference,readCodexModels} from '../src/services/agents/codex/controls.js';
import {saveCodexEnvironment} from '../src/services/agents/codex/environments.js';
import {runInCodexEngine} from '../src/services/agents/codex/engine-context.js';
import * as accountTransport from '../src/services/agents/codex/account-transport.js';
import {setRoleGrants,setUserRoles} from '../src/services/rbac.js';

const native='019ff001-9999-7999-8999-999999999999';
let app:FastifyInstance,server:Server,wss:WebSocketServer,cleanup:()=>void,cookie:string,owner:string,dir:string,log:string;
let inputs:any[],methods:string[],active:boolean,loaded:boolean,fail:boolean,noModels:boolean,model:string,effort:string,tier:string;
const record=(type:string,payload:unknown)=>JSON.stringify({type,payload,timestamp:'2026-10-31T02:00:00Z'})+'\n';
beforeEach(async()=>{
  const fixture=createTestDatabase();cleanup=fixture.cleanup;dir=fixture.dir;vi.stubEnv('CODEX_HOME',dir);vi.stubEnv('AGENTMANAGER_CODEX_PROVIDER_ENGINES','');const socket=join(dir,'controls.sock');vi.stubEnv('AGENTMANAGER_CODEX_STREAM_SOCKET',socket);
  writeFileSync(join(dir,'models_cache.json'),JSON.stringify({models:[{slug:'model-a',context_window:128000,input_modalities:['text','image'],release_date:'2026-01-01',private_token:'PRIVATE MODEL SECRET'}]}));
  mkdirSync(join(dir,'sessions'));log=join(dir,'sessions',`rollout-${native}.jsonl`);
  writeFileSync(log,record('turn_context',{model:'model-a',effort:'high',approval_policy:'never',sandbox_policy:{type:'workspace-write',private:'PRIVATE CONFIG'},service_tier:'priority'})+record('event_msg',{type:'token_count',info:{total_token_usage:{input_tokens:1000000,cached_input_tokens:900000,output_tokens:12000,total_tokens:1012000},last_token_usage:{input_tokens:11000,cached_input_tokens:9000,output_tokens:1000,total_tokens:12000},model_context_window:40000},rate_limits:{primary:{used_percent:25,window_minutes:10080,resets_at:1900000000},credits:{balance:'PRIVATE BALANCE'}}})+record('response_item',{type:'function_call_output',output:'PRIVATE TOOL OUTPUT'}));
  inputs=[];methods=[];active=false;loaded=true;fail=false;noModels=false;model='model-a';effort='high';tier='default';server=createServer();wss=new WebSocketServer({server});
  wss.on('connection',ws=>ws.on('message',bytes=>{const f=JSON.parse(bytes.toString());if(!f.method||!f.id)return;methods.push(f.method);let result:any={};
    if(f.method==='thread/read')result={thread:{id:native,status:{type:loaded?active?'active':'idle':'notLoaded'},model,reasoningEffort:effort,modelProvider:'openai',cwd:'/project',cliVersion:'0.test'}};
    if(f.method==='model/list')result={data:[{model:'model-a',displayName:'Model A',supportedReasoningEfforts:[{reasoningEffort:'high'}],defaultReasoningEffort:'high',serviceTiers:[{id:'priority',name:'Fast',description:'Faster requests'}]},{model:'model-b',displayName:'Model B',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'medium'}],defaultReasoningEffort:'low'},{model:'hidden',displayName:'Hidden',hidden:true,supportedReasoningEfforts:[{reasoningEffort:'low'}]}]};
    if(f.method==='model/list'&&noModels)result={data:[]};
    if(f.method==='thread/resume')result={serviceTier:tier};
    if(f.method==='account/rateLimits/read')result={rateLimits:{primary:{usedPercent:30,windowDurationMins:10080,resetsAt:1900000000},credits:{balance:'PRIVATE BALANCE'}}};
    if(f.method==='thread/settings/update'){if(fail){ws.send(JSON.stringify({id:f.id,error:{message:'failed'}}));return;}model=f.params.model;effort=f.params.effort;if(f.params.serviceTier!==undefined)tier=f.params.serviceTier;}
    if(f.method==='turn/start'){inputs.push(f.params);if(fail){ws.send(JSON.stringify({id:f.id,error:{message:'failed'}}));return;}if(f.params.model)model=f.params.model;if(f.params.effort)effort=f.params.effort;}
    ws.send(JSON.stringify({id:f.id,result}));
  }));await new Promise<void>(r=>server.listen(socket,r));
  owner=createUser({username:'owner',password:'password1',role:'admin'}).id;cookie=`agentmanager_session=${createSession(owner)}`;
  getDb().prepare("INSERT INTO projects(id,name,path,owner_id) VALUES ('p','Project',?,?)").run(dir,owner);
  getDb().prepare("INSERT INTO sessions(id,project_id,task,status,mode,cli_type,codex_session_id,created_by_user_id) VALUES ('s','p','Task','running','terminal','codex',?,?)").run(native,owner);
  vi.spyOn(manager,'isSessionActive').mockReturnValue(true);vi.spyOn(manager,'writeToSession').mockReturnValue(true);
  app=Fastify();await app.register(websocket);app.addHook('onRequest',authHook);await app.register(agentRoutes,{prefix:'/api'});
});
afterEach(async()=>{await app.close();for(const ws of wss.clients)ws.terminate();await new Promise<void>(r=>wss.close(()=>r()));await new Promise<void>(r=>server.close(()=>r()));vi.restoreAllMocks();vi.unstubAllEnvs();cleanup();});
const get=()=>app.inject({url:'/api/sessions/s/controls',headers:{cookie}});
const set=(value:any)=>app.inject({method:'PUT',url:'/api/sessions/s/controls',headers:{cookie,'content-type':'application/json'},payload:JSON.stringify(value)});
const send=()=>app.inject({method:'POST',url:'/api/sessions/s/input',headers:{cookie},payload:{input:'继续',source:'conversation'}});
describe('native conversation controls',()=>{
 it('exposes only safe metadata from the matching Engine catalog',async()=>{
  const response=await get();expect(response.statusCode).toBe(200);
  expect(response.json().models.find((m:any)=>m.model==='model-a')).toMatchObject({context_window:128000,input_modalities:['text','image'],release_date:'2026-01-01'});
  expect(response.body).not.toContain('PRIVATE MODEL SECRET');
 });
 it('reads account model metadata through the selected system account and does not expose other fields',async()=>{
  const env=await saveCodexEnvironment({name:'Fixture',allowed_user_ids:[owner],connection:{username:'fixture',port:22,authMethod:'key',identityFile:'',codexHome:'',codexCommand:'codex'}});
  const remote=vi.spyOn(accountTransport,'accountCommand').mockResolvedValue(JSON.stringify([{slug:'model-a',context_window:256000,input_modalities:['text','image'],private:'NEVER EXPOSE'}]));
  const models=await runInCodexEngine({socket:join(dir,'controls.sock'),environmentId:env.id,accountHome:'/home/fixture/.codex'},()=>readCodexModels(true,owner));
  expect(remote).toHaveBeenCalledOnce();expect(models.find(m=>m.model==='model-a')).toMatchObject({context_window:256000,input_modalities:['text','image']});
  expect(JSON.stringify(models)).not.toContain('NEVER EXPOSE');
 });
 it('reads context category counters without submitting or resuming a model turn',async()=>{
  const response=await app.inject({url:'/api/sessions/s/context-breakdown',headers:{cookie}});expect(response.statusCode).toBe(200);expect(response.json()).toMatchObject({context:{source:'jsonl',exact:false,usage:{last:{total_tokens:12000}}}});expect(response.body).not.toContain('PRIVATE');expect(methods).not.toContain('thread/resume');expect(methods).not.toContain('turn/start');expect(methods).not.toContain('model/list');expect(methods).not.toContain('account/rateLimits/read');
 });
 it('protects context statistics with session permissions and validates refresh flags',async()=>{
  const other=createUser({username:'context-member',password:'password1'}),otherCookie='agentmanager_session='+createSession(other.id);
  expect((await app.inject({url:'/api/sessions/s/context-breakdown',headers:{cookie:otherCookie}})).statusCode).toBe(404);
  expect((await app.inject({url:'/api/sessions/missing/context-breakdown',headers:{cookie}})).statusCode).toBe(404);
  expect((await app.inject({url:'/api/sessions/s/context-breakdown?refresh=false',headers:{cookie}})).statusCode).toBe(400);
 });
 it('keeps external model and quota reads cached for five minutes while local counters can change immediately',async()=>{
  let now=Date.now();vi.spyOn(Date,'now').mockImplementation(()=>now);
  await get();methods=[];now+=120000;
  appendFileSync(log,record('event_msg',{type:'token_count',info:{last_token_usage:{total_tokens:2400},model_context_window:40000}}));
  const local=await get();expect(local.json().usage.last.total_tokens).toBe(2400);
  expect(methods).not.toContain('model/list');expect(methods).not.toContain('account/rateLimits/read');
  methods=[];now+=180001;await get();expect(methods).toContain('model/list');expect(methods).toContain('account/rateLimits/read');
 });
 it('waits for a complete appended usage record rather than caching a partial JSON line',async()=>{
  await readConversationTelemetry(native);
  const next=record('event_msg',{type:'token_count',info:{last_token_usage:{total_tokens:2400},model_context_window:40000}});
  appendFileSync(log,next.slice(0,40));expect((await readConversationTelemetry(native)).usage?.last.total_tokens).toBe(12000);
  appendFileSync(log,next.slice(40));expect((await readConversationTelemetry(native)).usage?.last.total_tokens).toBe(2400);
 });
 it('returns actual dynamic model capabilities and allowlisted counters without tools, credentials or quota balances',async()=>{
  const response=await get();expect(response.statusCode).toBe(200);expect(response.json()).toMatchObject({model:'model-a',effort:'high',can_edit:true,usage:{last:{total_tokens:12000},window:40000},limits:[{used_percent:30}]});expect(response.json().models.map((m:any)=>m.model)).toEqual(['model-a','model-b']);expect(response.body).not.toContain('PRIVATE');expect(methods.filter(m=>m==='thread/resume')).toHaveLength(1);expect(methods).not.toContain('turn/start');
 });
 it('does not cache an empty model catalog as a successful result and recovers on the next read',async()=>{
  noModels=true;const first=await get();expect(first.json()).toMatchObject({can_edit:false,models:[]});noModels=false;const second=await get();expect(second.json()).toMatchObject({can_edit:true,models:[{model:'model-a'},{model:'model-b'}],limits:[{used_percent:30}]});expect(methods.filter(m=>m==='model/list')).toHaveLength(2);
 });
 it('applies settings immediately through the TUI settings-only RPC without submitting a user turn',async()=>{
  expect((await set({model:'model-b',effort:'medium'})).statusCode).toBe(200);expect(inputs).toHaveLength(0);expect(methods).toContain('thread/settings/update');expect((await get()).json()).toMatchObject({model:'model-b',effort:'medium',pending:null});expect(readModelPreference(owner,'s')).toBeNull();
  expect((await send()).statusCode).toBe(202);expect(inputs[0]).not.toHaveProperty('model');expect(manager.writeToSession).not.toHaveBeenCalled();
 });
 it('sets and cancels Fast using catalog tier IDs, verifies native receipts, and never submits a turn',async()=>{
  const enabled=await set({model:'model-a',effort:'high',service_tier:'priority'});expect(enabled.statusCode).toBe(200);expect(enabled.json().service_tier).toBe('priority');expect((await get()).json().service_tier).toBe('priority');
  const disabled=await set({model:'model-a',effort:'high',service_tier:'default'});expect(disabled.statusCode).toBe(200);expect((await get()).json().service_tier).toBe('default');
  expect((await set({model:'model-b',effort:'low',service_tier:'priority'})).statusCode).toBe(400);expect(inputs).toHaveLength(0);expect(methods).not.toContain('turn/start');
 });
 it('updates settings while a task is active without interrupting it or waiting for another task',async()=>{
  active=true;expect((await set({model:'model-b',effort:'low'})).statusCode).toBe(200);expect(inputs).toHaveLength(0);expect(methods).not.toContain('turn/interrupt');expect((await get()).json()).toMatchObject({model:'model-b',effort:'low',pending:null});
 });
 it('does not claim a failed update applied or send it through the terminal, and clears legacy pending state only on success',async()=>{
  saveModelPreference(owner,'s',{model:'model-b',effort:'low'});fail=true;expect((await set({model:'model-b',effort:'low'})).statusCode).toBe(503);expect(readModelPreference(owner,'s')).not.toBeNull();expect(manager.writeToSession).not.toHaveBeenCalled();expect(inputs).toHaveLength(0);fail=false;expect((await set({model:'model-b',effort:'low'})).statusCode).toBe(200);expect(readModelPreference(owner,'s')).toBeNull();
 });
 it('manual refresh bypasses catalog and quota caches',async()=>{
  await get();methods=[];const response=await app.inject({url:'/api/sessions/s/controls?refresh=true',headers:{cookie}});expect(response.statusCode).toBe(200);expect(methods).toContain('model/list');expect(methods).toContain('account/rateLimits/read');
 });
 it('rejects unsupported effort, hidden models and permission injection, and allows undo',async()=>{
  for(const value of [{model:'model-b',effort:'high'},{model:'hidden',effort:'low'},{model:'model-a',effort:'high',approvalPolicy:'never'}])expect((await set(value)).statusCode).toBe(400);
  await set({model:'model-b',effort:'low'});const reset=await app.inject({method:'PUT',url:'/api/sessions/s/controls',headers:{cookie,'content-type':'application/json'},payload:'null'});expect(reset.statusCode).toBe(200);expect(readModelPreference(owner,'s')).toBeNull();
 });
 it('allows an unloaded session to save a recovery model without loading a second engine',async()=>{
  loaded=false;const response=await get();expect(response.json()).toMatchObject({loaded:false,can_edit:true,model:'model-a'});const saved=await set({model:'model-b',effort:'low'});expect(saved.statusCode).toBe(200);expect(saved.json()).toMatchObject({pending:{model:'model-b',effort:'low'},pending_status:'saved'});expect(methods).not.toContain('thread/resume');expect(methods).not.toContain('thread/settings/update');expect(inputs).toHaveLength(0);
 });
 it('does not expose the host catalog or quotas to a member or allow a member to write engine settings',async()=>{
  getDb().prepare("UPDATE users SET role='member' WHERE id=?").run(owner);getDb().prepare("INSERT INTO rbac_roles(id,name) VALUES ('controls','Controls')").run();setRoleGrants('controls',{agent_api:'write'});setUserRoles(owner,['controls']);setProjectToolAccess({projectId:'p',userId:owner,canSession:true,canTerminal:true,sessionClients:['codex'],grantedBy:owner});
  const response=await get();expect(response.statusCode).toBe(200);expect(response.json()).toMatchObject({can_edit:false,models:[],limits:[]});expect(methods).toEqual([]);expect((await set({model:'model-a',effort:'high'})).statusCode).toBe(403);
 });
 it('rejects another session owner before any native request',async()=>{
  const other=createUser({username:'other',password:'password1',role:'admin'});getDb().prepare('UPDATE sessions SET created_by_user_id=? WHERE id=?').run(other.id,'s');const response=await set({model:'model-b',effort:'low'});expect([403,404]).toContain(response.statusCode);expect(methods).toHaveLength(0);
 });
 it('updates counters on append and does not fabricate missing values',async()=>{
  await readConversationTelemetry(native);appendFileSync(log,record('event_msg',{type:'token_count',info:{last_token_usage:{total_tokens:20000},model_context_window:40000}}));const value=await readConversationTelemetry(native);expect(value.usage?.last.total_tokens).toBe(20000);expect(value.usage?.last.input_tokens).toBeNull();expect(value.usage?.total.total_tokens).toBeNull();appendFileSync(log,JSON.stringify({type:'event_msg',timestamp:'2030-01-01T00:00:00Z',payload:{type:'token_count',info:null,rate_limits:{primary:{used_percent:55,window_minutes:10080}}}})+'\n');const unchanged=await readConversationTelemetry(native);expect(unchanged.observed_at).toBe('2026-10-31T02:00:00Z');expect(unchanged.limits[0].used_percent).toBe(55);
 });
});
