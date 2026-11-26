import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {createTestDatabase} from './helpers/database.js';
import {authHook,createUser,createSession,setProjectToolAccess} from '../src/auth.js';
import {getDb} from '../src/db/index.js';
import {settingsRoutes} from '../src/routes/settings.js';
import {agentRoutes} from '../src/routes/agent.js';
import {sessionRoutes} from '../src/routes/sessions.js';
import {getAgent} from '../src/services/agents/index.js';
const codexAdapter=getAgent('codex');
import {DEFAULT_SEND_GUARD,SEND_GUARD_KEY} from '../src/services/send-guard-policy.js';
import {validGuardToken,guardToken,inspectSendGuard} from '../src/services/conversation-send-guard.js';
import * as stream from '../src/services/agents/codex/stream.js';
import * as manager from '../src/services/session-manager.js';
import {updateAgentManagement} from '../src/services/agents/management-store.js';
import {initAccountStatus} from '../src/services/agents/codex/account-status.js';
import * as environments from '../src/services/agents/codex/environments.js';
import * as history from '../src/services/conversation-reader.js';
import {AgentQuotaExhaustedError} from '../src/services/agents/submission.js';
import {parseBriefContext} from '../src/shared/conversation-brief.js';
import {resumeQuotaFailedTurn} from '../src/services/conversation-quota-handoff.js';
import {setRoleGrants,setUserRoles} from '../src/services/rbac.js';
let app:ReturnType<typeof Fastify>,cleanup:()=>void,cookie:string,userId:string;
beforeEach(async()=>{
 ({cleanup}=createTestDatabase());const owner=createUser({username:'owner',password:'password1',role:'admin'});userId=owner.id;cookie=`agentmanager_session=${createSession(owner.id)}`;
 getDb().prepare("INSERT INTO projects(id,name,path,owner_id) VALUES('p','fixture','/fixture',?)").run(owner.id);setProjectToolAccess({projectId:'p',userId:owner.id,canSession:true,canTerminal:true,sessionClients:['codex'],grantedBy:owner.id});
 getDb().prepare("INSERT INTO sessions(id,project_id,task,status,mode,cli_type,codex_session_id,created_by_user_id) VALUES('s','p','fixture','running','terminal','codex','native',?)").run(owner.id);
 vi.spyOn(codexAdapter.telemetry,'read').mockResolvedValue({usage:{total:{total_tokens:2000},last:{total_tokens:800},window:1000},observed_at:new Date().toISOString()});
 vi.spyOn(codexAdapter.runtime,'read').mockResolvedValue({source:'fixture',session_id:'native',state:'idle',last_turn_ended_at:new Date(Date.now()-40*60000).toISOString(),last_activity_at:new Date(Date.now()-40*60000).toISOString(),observed_at:new Date().toISOString(),reason:'fixture'});
 vi.spyOn(manager,'isSessionActive').mockReturnValue(true);vi.spyOn(stream,'submitStreamingCodexInput').mockResolvedValue(true);vi.stubEnv('AGENTMANAGER_CODEX_STREAM_SOCKET','/fixture/socket');
 app=Fastify();await app.register(websocket);app.addHook('onRequest',authHook);await app.register(settingsRoutes,{prefix:'/api'});await app.register(agentRoutes,{prefix:'/api'});await app.register(sessionRoutes,{prefix:'/api'});await app.ready();
});
afterEach(async()=>{await app.close();vi.restoreAllMocks();vi.unstubAllEnvs();cleanup();});
const input={input:'hello',source:'conversation',client_id:'client'};
it('rejects invalid or stale expected identities on the internal new-conversation route',async()=>{
 const invalid=await app.inject({method:'POST',url:'/api/sessions/s/new-conversation',headers:{cookie},payload:{expected_native_id:[]}});
 expect(invalid.statusCode).toBe(400);
 const stale=await app.inject({method:'POST',url:'/api/sessions/s/new-conversation',headers:{cookie},payload:{expected_native_id:'other'}});
 expect(stale.statusCode).toBe(409);expect(stale.json().error).toContain('原生会话已变化');expect(manager.getSession('s')?.codex_session_id).toBe('native');
 const missing=await app.inject({method:'POST',url:'/api/sessions/s/new-conversation',headers:{cookie},payload:{environment_id:'native'}});
 expect(missing.statusCode).toBe(400);
 const denied=await app.inject({method:'POST',url:'/api/sessions/s/new-conversation',headers:{cookie},payload:{environment_id:'account:missing',expected_native_id:'native'}});
 expect(denied.statusCode).toBe(409);expect(manager.getSession('s')?.codex_session_id).toBe('native');
});
it('requires confirmation before dispatch and binds tokens to the exact user/native/policy/payload',async()=>{
 const check=await app.inject({method:'POST',url:'/api/sessions/s/input-check',headers:{cookie},payload:{input:'hello'}});expect(check.statusCode).toBe(200);expect(check.json()).toMatchObject({needs_confirmation:true,context_percent:80,can_compact:true,can_new:true});expect(stream.submitStreamingCodexInput).not.toHaveBeenCalled();
 const denied=await app.inject({method:'POST',url:'/api/sessions/s/input',headers:{cookie},payload:input});expect(denied.statusCode).toBe(409);expect(denied.json()).toMatchObject({submission:'rejected',send_guard:{needs_confirmation:true}});expect(stream.submitStreamingCodexInput).not.toHaveBeenCalled();
 const changed=await app.inject({method:'POST',url:'/api/sessions/s/input',headers:{cookie},payload:{...input,input:'different',guard_token:check.json().token}});expect(changed.statusCode).toBe(409);
 const accepted=await app.inject({method:'POST',url:'/api/sessions/s/input',headers:{cookie},payload:{...input,guard_token:check.json().token}});expect(accepted.statusCode).toBe(202);expect(stream.submitStreamingCodexInput).toHaveBeenCalledOnce();
 const session=manager.getSession('s')!,payload={input:'hello',attachments:[],batch:null},token=guardToken(session,userId,payload);expect(validGuardToken(token,session,userId,payload)).toBe(true);expect(validGuardToken(token,session,'someone',payload)).toBe(false);expect(validGuardToken(token,{...session,native_session_id:'other',codex_session_id:'other'},userId,payload)).toBe(false);expect(validGuardToken(token,session,userId,payload,Date.now()+6*60000)).toBe(false);
 getDb().prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(SEND_GUARD_KEY,JSON.stringify({...DEFAULT_SEND_GUARD,conditions:{operator:'and',conditions:[{type:'context_percent',value:99}]}}));expect(validGuardToken(token,session,userId,payload)).toBe(false);
});
it('only permits administrators to update rules even when a member has settings-write permission',async()=>{
 const member=createUser({username:'member',password:'password1'});getDb().prepare("INSERT INTO rbac_roles(id,name,builtin) VALUES('settings-writer','writer',0)").run();setRoleGrants('settings-writer',{settings:'write'});setUserRoles(member.id,['settings-writer']);const headers={cookie:`agentmanager_session=${createSession(member.id)}`};
 const denied=await app.inject({method:'PUT',url:'/api/settings',headers,payload:{settings:{[SEND_GUARD_KEY]:JSON.stringify(DEFAULT_SEND_GUARD)}}});expect(denied.statusCode).toBe(403);
 const invalid=await app.inject({method:'PUT',url:'/api/settings',headers:{cookie},payload:{settings:{[SEND_GUARD_KEY]:JSON.stringify({enabled:true,conditions:{operator:'or',conditions:[]}})}}});expect(invalid.statusCode).toBe(400);
 const saved=await app.inject({method:'PUT',url:'/api/settings',headers:{cookie},payload:{settings:{[SEND_GUARD_KEY]:JSON.stringify({...DEFAULT_SEND_GUARD,enabled:false})}}});expect(saved.statusCode).toBe(200);expect(JSON.parse(saved.json().settings[SEND_GUARD_KEY]).enabled).toBe(false);
});
it('shows the effective defaults and confirms an input that matches a combined branch',async()=>{
 const settings=await app.inject({url:'/api/settings',headers:{cookie}});
 expect(JSON.parse(settings.json().settings[SEND_GUARD_KEY])).toEqual(DEFAULT_SEND_GUARD);
 vi.mocked(codexAdapter.telemetry.read).mockResolvedValue({usage:{total:{},last:{total_tokens:300},window:1000},observed_at:null});
 const response=await app.inject({method:'POST',url:'/api/sessions/s/input-check',headers:{cookie},payload:{input:'hello'}});
 expect(response.json()).toMatchObject({needs_confirmation:true,context_percent:30});
});
it('does not fabricate idle time while a turn is running',async()=>{
 vi.mocked(codexAdapter.runtime.read).mockResolvedValue({source:'fixture',session_id:'native',state:'running',last_activity_at:new Date(Date.now()-99999999).toISOString(),observed_at:new Date().toISOString(),reason:'fixture'});
 const result=await app.inject({method:'POST',url:'/api/sessions/s/input-check',headers:{cookie},payload:{input:'hello'}});expect(result.json()).toMatchObject({idle_minutes:null,can_compact:false,can_new:false});
});

it('invalidates checks when policy changes during telemetry collection',async()=>{
 let release!:(value:any)=>void;vi.mocked(codexAdapter.telemetry.read).mockReturnValueOnce(new Promise(resolve=>{release=resolve;}));
 const session=manager.getSession('s')!,payload={input:'hello',attachments:[],batch:null};const pending=inspectSendGuard(session,userId,payload);
 getDb().prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(SEND_GUARD_KEY,JSON.stringify({enabled:true,conditions:{operator:'or',conditions:[{type:'context_percent',value:10}]}}));
 release({usage:{last:{total_tokens:200},total:{total_tokens:200},window:1000},observed_at:null});const result=await pending;
 expect(result.needs_confirmation).toBe(false);expect(validGuardToken(result.token,session,userId,payload)).toBe(false);
 const response=await app.inject({method:'POST',url:'/api/sessions/s/input',headers:{cookie},payload:{...input,guard_token:result.token}});expect(response.statusCode).toBe(409);expect(stream.submitStreamingCodexInput).not.toHaveBeenCalled();
});
it('asks for confirmation on unknown history metrics without substituting activity for turn-end time',async()=>{
 vi.mocked(codexAdapter.telemetry.read).mockResolvedValue({usage:{total:{},last:{total_tokens:600},window:1000},observed_at:null});
 vi.mocked(codexAdapter.runtime.read).mockResolvedValue({source:'fixture',session_id:'native',state:'idle',last_activity_at:new Date(Date.now()-60*60000).toISOString(),observed_at:new Date().toISOString(),reason:'no end event'});
 const response=await app.inject({method:'POST',url:'/api/sessions/s/input-check',headers:{cookie},payload:{input:'hello'}});expect(response.json()).toMatchObject({needs_confirmation:false,idle_minutes:null,last_completed_at:null});
});
it('does not warn before the first turn of a newly created session',async()=>{
 vi.mocked(codexAdapter.telemetry.read).mockRejectedValue(Error('no usage yet'));
 vi.mocked(codexAdapter.runtime.read).mockRejectedValue(Error('runtime not connected yet'));
 const response=await app.inject({method:'POST',url:'/api/sessions/s/input-check',headers:{cookie},payload:{input:'hello'}});
 expect(response.statusCode).toBe(200);expect(response.json()).toMatchObject({needs_confirmation:false,matched:null,context_tokens:null,context_window:null,last_completed_at:null});
});
it('does not warn when usage exists but the provider omits its context window',async()=>{
 vi.mocked(codexAdapter.telemetry.read).mockResolvedValue({usage:{total:{total_tokens:35564},last:{total_tokens:35564},window:null},observed_at:new Date().toISOString()});
 vi.mocked(codexAdapter.runtime.read).mockResolvedValue({source:'fixture',session_id:'native',state:'idle',last_activity_at:new Date().toISOString(),observed_at:new Date().toISOString(),reason:'fixture'});
 const response=await app.inject({method:'POST',url:'/api/sessions/s/input-check',headers:{cookie},payload:{input:'hello'}});
 expect(response.json()).toMatchObject({needs_confirmation:false,matched:null,context_tokens:35564,context_window:null,context_percent:null});
 const sent=await app.inject({method:'POST',url:'/api/sessions/s/input',headers:{cookie},payload:input});
 expect(sent.statusCode).toBe(202);
});

it.each(['wrong-native',''])('rejects stale or invalid notification native binding %s before submission',async expected=>{
 const response=await app.inject({method:'POST',url:'/api/sessions/s/input',headers:{cookie},payload:{input:'hello',source:'conversation',expected_native_id:expected}});
 expect(response.statusCode).toBe(expected?409:400);expect(response.json().submission).toBe('rejected');expect(stream.submitStreamingCodexInput).not.toHaveBeenCalled();
});

it('rejects a notification whose Agent environment has changed',async()=>{
 const response=await app.inject({method:'POST',url:'/api/sessions/s/input',headers:{cookie},payload:{input:'hello',source:'conversation',expected_native_id:'native',expected_environment_id:'other-environment'}});
 expect(response.statusCode).toBe(409);expect(response.json().submission).toBe('rejected');expect(stream.submitStreamingCodexInput).not.toHaveBeenCalled();
});

it('rechecks the expected native binding after waiting for another input submission',async()=>{
 getDb().prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(SEND_GUARD_KEY,JSON.stringify({...DEFAULT_SEND_GUARD,enabled:false}));
 let release!:(value:boolean)=>void;
 vi.mocked(stream.submitStreamingCodexInput).mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
 const first=app.inject({method:'POST',url:'/api/sessions/s/input',headers:{cookie},payload:{input:'first',source:'conversation'}}).then(r=>r);
 await vi.waitFor(()=>expect(stream.submitStreamingCodexInput).toHaveBeenCalledOnce());
 const second=app.inject({method:'POST',url:'/api/sessions/s/input',headers:{cookie},payload:{input:'reply',source:'conversation',expected_native_id:'native'}}).then(r=>r);
 // Let the second request reach the shared input queue before changing the binding.
 await new Promise(resolve=>setImmediate(resolve));
 getDb().prepare("UPDATE sessions SET codex_session_id='replacement' WHERE id='s'").run();release(true);
 await first;const response=await second;expect(response.statusCode).toBe(409);expect(response.json().submission).toBe('rejected');expect(stream.submitStreamingCodexInput).toHaveBeenCalledOnce();
});

it.each(['codex','claude'] as const)('enforces ordered automatic rules for %s even with a token from before telemetry changed',async agentId=>{
 const adapter=getAgent(agentId);
 const submit=vi.spyOn(adapter.input,'submit');
 if(agentId==='claude'){
  getDb().prepare("UPDATE sessions SET cli_type='claude',codex_session_id=NULL,claude_session_id='native' WHERE id='s'").run();
  vi.spyOn(adapter.telemetry,'read').mockImplementation(codexAdapter.telemetry.read);
  vi.spyOn(adapter.runtime,'read').mockImplementation(codexAdapter.runtime.read);
 }
 const group=(value:number)=>({operator:'and',conditions:[{type:'context_percent',value}]});
 const policy={enabled:true,conditions:group(20),automatic_rules:[
  {action:'brief',conditions:group(90)},
  {action:'new',conditions:group(80)},
 ]};
 const settings=await app.inject({method:'PUT',url:'/api/settings',headers:{cookie},payload:{settings:{[SEND_GUARD_KEY]:JSON.stringify(policy)}}});
 expect(settings.statusCode).toBe(200);
 const preflight=()=>app.inject({method:'POST',url:'/api/sessions/s/input-check',headers:{cookie},payload:{input:'hello'}});
 const telemetry=(tokens:number)=>({usage:{last:{total_tokens:tokens},total:{},window:1000},observed_at:null});
 vi.mocked(adapter.telemetry.read).mockResolvedValue(telemetry(500));
 const before=(await preflight()).json();
 expect(before).toMatchObject({needs_confirmation:true,required_action:null,token:expect.any(String)});
 vi.mocked(adapter.telemetry.read).mockResolvedValue(telemetry(800));
 expect((await preflight()).json()).toMatchObject({needs_confirmation:true,required_action:'new',token:null});
 vi.mocked(adapter.telemetry.read).mockResolvedValue(telemetry(950));
 for(const token of [undefined,before.token]){
  const denied=await app.inject({method:'POST',url:'/api/sessions/s/input',headers:{cookie},payload:{...input,guard_token:token}});
  expect(denied.statusCode).toBe(409);
  expect(denied.json()).toMatchObject({submission:'rejected',send_guard:{required_action:'brief',token:null}});
 }
 expect(submit).not.toHaveBeenCalled();
});

it('returns an available account for a quota rule and keeps blocking when no candidate exists',async()=>{
 const remaining=vi.spyOn(codexAdapter.quota,'accountRemaining').mockReturnValue(0);
 const alternate=vi.spyOn(codexAdapter.quota,'alternateAccount').mockReturnValue({id:'account:backup',label:'备用账号'});
 const policy={...DEFAULT_SEND_GUARD,reminder_enabled:false,automatic_rules:[{
  action:'brief',target:'available_account',conditions:{operator:'and',conditions:[{type:'account_remaining_percent',value:0}]},
 }]};
 getDb().prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(SEND_GUARD_KEY,JSON.stringify(policy));
 const preflight=()=>app.inject({method:'POST',url:'/api/sessions/s/input-check',headers:{cookie},payload:{input:'hello'}});
 expect((await preflight()).json()).toMatchObject({required_action:'brief',switch_account:true,account_remaining_percent:0,target_account:{id:'account:backup',label:'备用账号'},token:null});
 alternate.mockReturnValue(null);
 expect((await preflight()).json()).toMatchObject({required_action:'brief',switch_account:true,target_account:null,token:null});
 const denied=await app.inject({method:'POST',url:'/api/sessions/s/input',headers:{cookie},payload:input});
 expect(denied.statusCode).toBe(409);
 expect(stream.submitStreamingCodexInput).not.toHaveBeenCalled();
 remaining.mockReturnValue(null);
 expect((await preflight()).json()).toMatchObject({needs_confirmation:false,required_action:null,account_remaining_percent:null,token:expect.any(String)});
});

it('selects a funded account immediately after a failed turn on a depleted account',async()=>{
 initAccountStatus();
 vi.stubEnv('CODEX_HOME','/fixture/native-codex');
 const db=getDb(),now=new Date(),reset=now.getTime()/1000+3600;
 const source='account:depleted';
 db.prepare("INSERT INTO agent_environments(id,agent_id,name,kind,enabled,config,allowed_user_ids) VALUES(?,'codex','fixture','account',1,?,'[]')")
  .run(source,JSON.stringify({host:'127.0.0.1',username:'depleted',codexHome:'/fixture/depleted',port:22,authMethod:'key'}));
 db.prepare("UPDATE sessions SET agent_environment_id=? WHERE id='s'").run(source);
 const sample=db.prepare('INSERT INTO codex_account_status(account,identity,data,checked_at) VALUES(?,?,?,?)');
 sample.run(source,JSON.stringify(['depleted','/fixture/depleted']),JSON.stringify({
  account:{email:'depleted@example.invalid'},windows:[{usedPercent:100,resetsAt:reset}],
 }),now.toISOString());
 sample.run('native',JSON.stringify(['native','/fixture/native-codex']),JSON.stringify({
  account:{email:'funded@example.invalid'},windows:[{usedPercent:44,resetsAt:reset}],
 }),now.toISOString());
 vi.mocked(codexAdapter.runtime.read).mockResolvedValue({
  source:'fixture',session_id:'native',state:'failed',last_turn_ended_at:now.toISOString(),
  last_activity_at:now.toISOString(),observed_at:now.toISOString(),reason:'usage limit',
 });
 const response=await app.inject({method:'POST',url:'/api/sessions/s/input-check',headers:{cookie},payload:{input:'hello'}});
 expect(response.statusCode).toBe(200);
 const check=response.json();
 expect(check).toMatchObject({required_action:'brief',can_new:true,switch_account:true,account_remaining_percent:0,target_account:{id:'native'}});
 expect(check.idle_minutes).toBeLessThan(1);
});

function stubQuotaHandoff() {
 const read=vi.spyOn(history,'readConversation').mockResolvedValue({available:true,has_more:false,reset:false,generation:'fixture',
   messages:[{id:'previous',role:'user',text:'整理项目文件',timestamp:null,turn_id:'last-turn'}],statistics:[],metadata:null,cache_drops:[]});
 const candidate={id:'account:backup',label:'备用账号'};
 getDb().prepare("INSERT INTO agent_environments(id,agent_id,name,kind,enabled,config,allowed_user_ids) VALUES (?,'codex',?,'account',1,?,?)")
   .run(candidate.id,candidate.label,JSON.stringify({username:'fixture'}),JSON.stringify([userId]));
 vi.spyOn(environments,'engineForEnvironment').mockResolvedValue({socket:'/fixture/backup-socket',environmentId:candidate.id});
 vi.spyOn(codexAdapter.quota,'alternateAccount').mockReturnValue(candidate);
 vi.spyOn(codexAdapter.quota,'exhausted').mockImplementation((_context,error)=>error instanceof AgentQuotaExhaustedError);
 vi.spyOn(codexAdapter.quota,'observeExhaustion').mockImplementation(()=>{});
 const replace=vi.spyOn(manager,'newSessionConversation').mockImplementation(async(id,_model,_replacement,expected,environment,options)=>{
   expect(read).toHaveBeenCalled();
   expect(expected).toBe('native');
   expect(options?.preserveHistory).toBe(true);
   await options?.verifySource?.();
   getDb().prepare("UPDATE sessions SET native_session_id='fresh',codex_session_id='fresh',agent_environment_id=? WHERE id=?").run(environment,id);
   return {ok:true};
 });
 return {read,replace,candidate};
}

it.each(['cached','native rejection','uncertain'] as const)('recovers eligible quota exhaustion during input with evidence %s',async evidence=>{
 const {replace,candidate}=stubQuotaHandoff();
 const remaining=vi.spyOn(codexAdapter.quota,'accountRemaining').mockImplementation(context=>context.nativeId==='fresh'?50:25);
 const checked=await app.inject({method:'POST',url:'/api/sessions/s/input-check',headers:{cookie},payload:{input:'hello'}});
 if(evidence==='cached')remaining.mockImplementation(context=>context.nativeId==='fresh'?50:0);
 if(evidence==='native rejection')vi.mocked(stream.submitStreamingCodexInput).mockRejectedValueOnce(new AgentQuotaExhaustedError());
 if(evidence==='uncertain')vi.mocked(stream.submitStreamingCodexInput).mockRejectedValueOnce(new Error('socket closed'));
 const result=await app.inject({method:'POST',url:'/api/sessions/s/input',headers:{cookie},payload:{...input,expected_native_id:'native',guard_token:checked.json().token}});
 if(evidence==='uncertain'){
   expect(result.statusCode).toBe(503);
   expect(replace).not.toHaveBeenCalled();
   expect(stream.submitStreamingCodexInput).toHaveBeenCalledOnce();
   return;
 }
 expect(result.statusCode).toBe(202);
 expect(result.json()).toMatchObject({native_id:'fresh',guard_action:'brief',status:'submitted'});
 expect(manager.getSession('s')?.agent_environment_id).toBe(candidate.id);
 expect(replace).toHaveBeenCalledOnce();
 expect(stream.submitStreamingCodexInput).toHaveBeenCalledTimes(evidence==='cached'?1:2);
 const [native,text,client]=vi.mocked(stream.submitStreamingCodexInput).mock.calls.at(-1)!;
 expect([native,client]).toEqual(['fresh',input.client_id]);
 expect(parseBriefContext(text)).toMatchObject({input:'hello',context:{turns:[{input:'整理项目文件'}]}});
});

it.each(['unfinished','has final','queued','newer turn','stale history'] as const)('resumes a quota-failed task only when safe (%s)',async condition=>{
 const {replace,read}=stubQuotaHandoff();
 if(condition==='stale history')read.mockResolvedValue({available:true,has_more:false,reset:false,generation:'fixture',
   messages:[{id:'previous',role:'user',text:'另一个轮次的任务',timestamp:null,turn_id:'older'}],statistics:[],metadata:null,cache_drops:[]});
 vi.spyOn(codexAdapter.retry,'inspect').mockResolvedValue({
   state:'idle',queued:condition==='queued',turn:{id:condition==='newer turn'?'another':'last-turn',status:'failed',
     quota_exhausted:true,retryable:false,has_final:condition==='has final',user_client_ids:['original']},
 });
 const job={session_id:'s',native_id:'native',root_turn_id:'last-turn',failed_turn_ids:['last-turn'],user_id:userId,
   action:'quota_handoff',attempt:1,max_attempts:1,status:'submitting',client_id:'quota-handoff-test',
   next_retry_at:null,retry_turn_id:null} as const;
 if(condition!=='unfinished'){
   await expect(resumeQuotaFailedTurn({...job,failed_turn_ids:[...job.failed_turn_ids]},()=>true)).rejects.toThrow();
   expect(replace).not.toHaveBeenCalled();
   expect(stream.submitStreamingCodexInput).not.toHaveBeenCalled();
   return;
 }
 await resumeQuotaFailedTurn({...job,failed_turn_ids:[...job.failed_turn_ids]},()=>true);
 expect(replace).toHaveBeenCalledOnce();
 const [native,text,client]=vi.mocked(stream.submitStreamingCodexInput).mock.calls.at(-1)!;
 expect([native,client]).toEqual(['fresh','quota-handoff-test']);
 expect(parseBriefContext(text)).toMatchObject({input:expect.stringContaining('避免重复执行'),context:{turns:[{input:'整理项目文件'}]}});
});

it.each(['new','compact'] as const)('prioritizes a brief on depletion over a matched %s rule',async action=>{
 vi.spyOn(codexAdapter.quota,'accountRemaining').mockReturnValue(0);
 vi.spyOn(codexAdapter.quota,'alternateAccount').mockReturnValue({id:'account:backup',label:'备用账号'});
 const policy={enabled:true,rules:[{action,conditions:{operator:'and',conditions:[{type:'context_percent',value:80}]}}]};
 getDb().prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(SEND_GUARD_KEY,JSON.stringify(policy));
 const response=await app.inject({method:'POST',url:'/api/sessions/s/input-check',headers:{cookie},payload:{input:'hello'}});
 expect(response.json()).toMatchObject({required_action:'brief',switch_account:true,target_account:{id:'account:backup'}});
});

it('chooses a fresh conversation when a depleted account has yet to run its first turn',async()=>{
 vi.spyOn(codexAdapter.quota,'accountRemaining').mockReturnValue(0);
 vi.spyOn(codexAdapter.quota,'alternateAccount').mockReturnValue({id:'account:backup',label:'备用账号'});
 vi.mocked(codexAdapter.runtime.read).mockResolvedValue({
  source:'fixture',session_id:'native',state:'ready',last_activity_at:null,observed_at:new Date().toISOString(),reason:'fresh',
 });
 const response=await app.inject({method:'POST',url:'/api/sessions/s/input-check',headers:{cookie},payload:{input:'hello'}});
 expect(response.json()).toMatchObject({required_action:'new',can_new:true,can_compact:false,switch_account:true,target_account:{id:'account:backup'}});
});

it('keeps automatic account switching under the send protection master switch',async()=>{
 const remaining=vi.spyOn(codexAdapter.quota,'accountRemaining').mockReturnValue(0);
 getDb().prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(SEND_GUARD_KEY,JSON.stringify({enabled:false,rules:[]}));
 const response=await app.inject({method:'POST',url:'/api/sessions/s/input-check',headers:{cookie},payload:{input:'hello'}});
 expect(response.json()).toMatchObject({required_action:null,switch_account:false,token:expect.any(String)});
 expect(remaining).not.toHaveBeenCalled();
});

it.each([
 ['codex','new',25],
 ['codex','brief',null],
 ['claude','new',null],
] as const)('keeps the %s %s action on the current account when remaining quota is %s',async(agentId,action,remaining)=>{
 const adapter=getAgent(agentId);
 const alternate=vi.fn(()=>({id:'account:backup',label:'备用账号'}));
 if(agentId==='claude'){
  getDb().prepare("UPDATE sessions SET cli_type='claude',codex_session_id=NULL,claude_session_id='native' WHERE id='s'").run();
  vi.spyOn(adapter.telemetry,'read').mockImplementation(codexAdapter.telemetry.read);
  vi.spyOn(adapter.runtime,'read').mockImplementation(codexAdapter.runtime.read);
 }else{
  vi.spyOn(codexAdapter.quota,'accountRemaining').mockReturnValue(remaining);
  vi.spyOn(codexAdapter.quota,'alternateAccount').mockImplementation(alternate);
 }
 const policy={enabled:true,rules:[{
  action,target:'available_account',conditions:{operator:'or',conditions:[
   {type:'context_percent',value:80},{type:'account_remaining_percent',value:0},
  ]},
 }]};
 getDb().prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(SEND_GUARD_KEY,JSON.stringify(policy));
 const check=await app.inject({method:'POST',url:'/api/sessions/s/input-check',headers:{cookie},payload:{input:'hello'}});
 expect(check.statusCode).toBe(200);
 expect(check.json()).toMatchObject({required_action:action,can_new:true,switch_account:false,target_account:null,account_remaining_percent:remaining,token:null});
 expect(alternate).not.toHaveBeenCalled();
});

it('rejects automatic compaction when the original conversation was replaced',async()=>{
 const compact=vi.spyOn(codexAdapter.lifecycle,'compact');
 const result=await app.inject({method:'POST',url:'/api/sessions/s/compact',headers:{cookie},payload:{expected_native_id:'old'}});
 expect(result.statusCode).toBe(409);
 expect(result.json()).toMatchObject({submission:'rejected'});
 expect(compact).not.toHaveBeenCalled();
});

it.each(['codex','claude'] as const)('estimates the cached input at risk for the %s reminder from neutral telemetry',async agentId=>{
 const adapter=getAgent(agentId);
 if(agentId==='claude'){
  getDb().prepare("UPDATE sessions SET cli_type='claude',codex_session_id=NULL,claude_session_id='native' WHERE id='s'").run();
  vi.spyOn(adapter.telemetry,'read');
 }
 const check=()=>app.inject({method:'POST',url:'/api/sessions/s/input-check',headers:{cookie},payload:{input:'hello'}});
 const telemetry=(cached_input_tokens:number|null,total_tokens=800)=>({usage:{total:{},last:{input_tokens:760,cached_input_tokens,total_tokens},window:1000},observed_at:null});
 vi.mocked(adapter.telemetry.read).mockResolvedValue(telemetry(540));
 expect((await check()).json()).toMatchObject({needs_confirmation:true,cache_miss_estimate:{tokens:540,cost:null}});
 for(const cached of [null,0,761]){
  vi.mocked(adapter.telemetry.read).mockResolvedValue(telemetry(cached));
  expect((await check()).json()).toMatchObject({needs_confirmation:true,cache_miss_estimate:null});
 }
 vi.mocked(adapter.telemetry.read).mockResolvedValue(telemetry(540,760));
 getDb().prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(SEND_GUARD_KEY,JSON.stringify({...DEFAULT_SEND_GUARD,reminder_enabled:false}));
 expect((await check()).json()).toMatchObject({needs_confirmation:false,cache_miss_estimate:null});
});


it.each(['codex','claude'] as const)('matches whole rules only for selected Provider bindings on %s',async agentId=>{
 for(const id of ['codex','claude']){
  updateAgentManagement(id,()=>({defaults:{},providers:['shared','backup','other'].map(id=>({id,name:id,kind:'fixture',enabled:true,fields:{}}))}));
 }
 const adapter=getAgent(agentId);
 if(agentId==='claude'){
  getDb().prepare("UPDATE sessions SET cli_type='claude',codex_session_id=NULL,claude_session_id='native' WHERE id='s'").run();
  vi.spyOn(adapter.telemetry,'read').mockImplementation(codexAdapter.telemetry.read);
  vi.spyOn(adapter.runtime,'read').mockImplementation(codexAdapter.runtime.read);
 }
 const submit=vi.spyOn(adapter.input,'submit');
 const prefix=agentId==='codex'?'provider:':'claude-provider:';
 const bind=(id:string)=>getDb().prepare("UPDATE sessions SET agent_environment_id=? WHERE id='s'").run(prefix+id);
 const conditions={operator:'and',conditions:[{type:'context_percent',value:80}]};
 const settings={enabled:true,rules:[
  {action:'compact',provider_ids:[`${agentId==='codex'?'claude':'codex'}:shared`],conditions},
  {action:'new',provider_ids:['codex:backup','claude:backup'],conditions},
  {action:'remind',provider_ids:['codex:shared','claude:shared'],conditions},
 ]};
 bind('shared');
 const saved=await app.inject({method:'PUT',url:'/api/settings',headers:{cookie},payload:{settings:{[SEND_GUARD_KEY]:JSON.stringify(settings)}}});
 expect(saved.statusCode).toBe(200);
 const check=()=>app.inject({method:'POST',url:'/api/sessions/s/input-check',headers:{cookie},payload:{input:'hello'}});
 const reminder=(await check()).json();
 expect(reminder).toMatchObject({needs_confirmation:true,required_action:null,token:expect.any(String)});
 bind('backup');
 expect((await check()).json()).toMatchObject({needs_confirmation:true,required_action:'new',token:null});
 const denied=await app.inject({method:'POST',url:'/api/sessions/s/input',headers:{cookie},payload:{...input,guard_token:reminder.token}});
 expect(denied.statusCode).toBe(409);
 expect(denied.json()).toMatchObject({submission:'rejected',send_guard:{required_action:'new'}});
 expect(submit).not.toHaveBeenCalled();
 bind('other');
 expect((await check()).json()).toMatchObject({needs_confirmation:false,required_action:null});
});

it('can confirm quota after switching out of the scope of a quota rule',async()=>{
 updateAgentManagement('codex',()=>({defaults:{},providers:[{id:'source',name:'source',kind:'fixture',enabled:true,fields:{}}]}));
 const quota=vi.spyOn(codexAdapter.quota,'accountRemaining').mockReturnValue(0);
 vi.spyOn(codexAdapter.quota,'alternateAccount').mockReturnValue({id:'native',label:'native'});
 const settings={enabled:true,rules:[{
  action:'brief',target:'available_account',provider_ids:['codex:source'],
  conditions:{operator:'and',conditions:[{type:'account_remaining_percent',value:0}]},
 }]};
 getDb().prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(SEND_GUARD_KEY,JSON.stringify(settings));
 getDb().prepare("UPDATE sessions SET agent_environment_id='provider:source' WHERE id='s'").run();
 const check=()=>app.inject({method:'POST',url:'/api/sessions/s/input-check',headers:{cookie},payload:{input:'hello'}});
 expect((await check()).json()).toMatchObject({required_action:'brief',switch_account:true,account_remaining_percent:0});
 quota.mockReturnValue(65);
 getDb().prepare("UPDATE sessions SET agent_environment_id=NULL WHERE id='s'").run();
 expect((await check()).json()).toMatchObject({required_action:null,needs_confirmation:false,account_remaining_percent:65});
});
