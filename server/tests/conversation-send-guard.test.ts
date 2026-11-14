import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {createTestDatabase} from './helpers/database.js';
import {authHook,createUser,createSession,setProjectToolAccess} from '../src/auth.js';
import {getDb} from '../src/db/index.js';
import {settingsRoutes} from '../src/routes/settings.js';
import {agentRoutes} from '../src/routes/agent.js';
import {getAgent} from '../src/services/agents/index.js';
const codexAdapter=getAgent('codex');
import {DEFAULT_SEND_GUARD,SEND_GUARD_KEY} from '../src/services/send-guard-policy.js';
import {validGuardToken,guardToken,inspectSendGuard} from '../src/services/conversation-send-guard.js';
import * as stream from '../src/services/agents/codex/stream.js';
import * as manager from '../src/services/session-manager.js';
import {setRoleGrants,setUserRoles} from '../src/services/rbac.js';
let app:ReturnType<typeof Fastify>,cleanup:()=>void,cookie:string,userId:string;
beforeEach(async()=>{
 ({cleanup}=createTestDatabase());const owner=createUser({username:'owner',password:'password1',role:'admin'});userId=owner.id;cookie=`agentmanager_session=${createSession(owner.id)}`;
 getDb().prepare("INSERT INTO projects(id,name,path,owner_id) VALUES('p','fixture','/fixture',?)").run(owner.id);setProjectToolAccess({projectId:'p',userId:owner.id,canSession:true,canTerminal:true,sessionClients:['codex'],grantedBy:owner.id});
 getDb().prepare("INSERT INTO sessions(id,project_id,task,status,mode,cli_type,codex_session_id,created_by_user_id) VALUES('s','p','fixture','running','terminal','codex','native',?)").run(owner.id);
 vi.spyOn(codexAdapter.telemetry,'read').mockResolvedValue({usage:{total:{total_tokens:2000},last:{total_tokens:800},window:1000},observed_at:new Date().toISOString()});
 vi.spyOn(codexAdapter.runtime,'read').mockResolvedValue({source:'fixture',session_id:'native',state:'idle',last_turn_ended_at:new Date(Date.now()-40*60000).toISOString(),last_activity_at:new Date(Date.now()-40*60000).toISOString(),observed_at:new Date().toISOString(),reason:'fixture'});
 vi.spyOn(manager,'isSessionActive').mockReturnValue(true);vi.spyOn(stream,'submitStreamingCodexInput').mockResolvedValue(true);vi.stubEnv('AGENTMANAGER_CODEX_STREAM_SOCKET','/fixture/socket');
 app=Fastify();await app.register(websocket);app.addHook('onRequest',authHook);await app.register(settingsRoutes,{prefix:'/api'});await app.register(agentRoutes,{prefix:'/api'});await app.ready();
});
afterEach(async()=>{await app.close();vi.restoreAllMocks();vi.unstubAllEnvs();cleanup();});
const input={input:'hello',source:'conversation',client_id:'client'};
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
 const response=await app.inject({method:'POST',url:'/api/sessions/s/input-check',headers:{cookie},payload:{input:'hello'}});expect(response.json()).toMatchObject({needs_confirmation:true,matched:null,idle_minutes:null,last_completed_at:null});
});
