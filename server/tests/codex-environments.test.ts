import * as stream from '../src/services/agents/codex/stream.js';
import {randomUUID} from 'crypto';
import Fastify,{type FastifyInstance} from 'fastify';
import websocket from '@fastify/websocket';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createTestDatabase} from './helpers/database.js';
import {authHook,createUser,createSession,hashApiKey,setProjectToolAccess,userCanUseSessionTool} from '../src/auth.js';
import {renameCodexProvider} from '../src/services/agents/codex/management.js';
import {getDb} from '../src/db/index.js';
import {codexEnvironmentRoutes} from '../src/routes/codex-environments.js';
import {sessionRoutes} from '../src/routes/sessions.js';
import {saveCodexEnvironment,visibleCodexEnvironments,engineForEnvironment,environmentConnection,restoreActiveAccountTransports} from '../src/services/agents/codex/environments.js';
import {watchSessionEnvironment,canUseEnvironment} from '../src/services/agents/environment-access.js';
import {engineForThread,rememberCodexThread,runInCodexEngine} from '../src/services/agents/codex/engine-context.js';
import {updateAgentManagement} from '../src/services/agents/management-store.js';
import * as transport from '../src/services/agents/codex/account-transport.js';
import {collectAccountStatus} from '../src/services/agents/codex/account-status.js';
import {collectEngineBalance,cachedEngineBalance} from '../src/services/agents/codex/engine-balance.js';
vi.mock('../src/services/agents/codex/account-transport.js',async original=>({...await original<typeof import('../src/services/agents/codex/account-transport.js')>(),ensureAccountTransport:vi.fn(async(id:string)=>({socket:'/fixture/'+id+'.sock',home:'/fixture/home'})),closeAccountTransport:vi.fn(async()=>{}),probeAccountConnection:vi.fn(async()=>({models:[{model:'fixture',name:'Fixture',description:'',efforts:[],defaultEffort:''}]})),accountCommand:vi.fn(async()=> 'ok'),checkAccountProject:vi.fn(async()=>{})}));
const connection={username:'ymchen',port:22,identityFile:'',codexCommand:'codex',codexHome:''};
describe('Codex account environments and platform ACLs',()=>{
 let app:FastifyInstance,db:ReturnType<typeof createTestDatabase>,owner:ReturnType<typeof createUser>,other:ReturnType<typeof createUser>,admin:ReturnType<typeof createUser>,cookies:Record<string,string>;
 beforeEach(async()=>{
  db=createTestDatabase();owner=createUser({username:'ymchen',password:'password1'});other=createUser({username:'other',password:'password1'});admin=createUser({username:'admin',password:'password1',role:'admin'});
  cookies={other:'agentmanager_session='+createSession(other.id),owner:'agentmanager_session='+createSession(owner.id),admin:'agentmanager_session='+createSession(admin.id)};
  getDb().prepare("INSERT INTO projects(id,name,path,owner_id) VALUES('p','Project','/tmp/fixture-project',?)").run(owner.id);
  setProjectToolAccess({projectId:'p',userId:owner.id,canSession:true,canTerminal:true,sessionClients:['codex'],grantedBy:admin.id});
  app=Fastify();await app.register(websocket);app.addHook('onRequest',authHook);await app.register(codexEnvironmentRoutes,{prefix:'/api'});await app.register(sessionRoutes,{prefix:'/api'});
 });
 afterEach(async()=>{await app.close();db.cleanup();vi.restoreAllMocks();});
 const create=()=>saveCodexEnvironment({name:'ymchen Codex',connection,allowed_user_ids:[owner.id]});
 it('allows only administrators to rebuild cached usage and exposes hourly data',async()=>{
  const path='/api/codex/environments/native/insights/rebuild';
  expect((await app.inject({method:'POST',url:path,headers:{cookie:cookies.owner}})).statusCode).toBe(403);
  vi.spyOn(transport,'localCommandInput').mockImplementation(async(_script,input)=>{const data=JSON.parse(input);return JSON.stringify({mode:data.mode,day:data.day,rows:[],event_keys:{},events:[],events_truncated:false,partial:false,errors:0});});
  expect((await app.inject({method:'POST',url:path,headers:{cookie:cookies.admin}})).statusCode).toBe(200);
  const key='amk_'+Buffer.alloc(32,9).toString('base64url');getDb().prepare('INSERT INTO api_keys(id,user_id,name,token_hash,grants,created_at,expires_at) VALUES(?,?,?,?,?,?,?)').run('fixture-key',admin.id,'fixture',hashApiKey(key),JSON.stringify({settings:'write',agent_api:'write'}),new Date().toISOString(),new Date(Date.now()+3600000).toISOString());
  expect((await app.inject({method:'POST',url:path,headers:{authorization:`Bearer ${key}`}})).statusCode).toBe(200);
  const hourly=await app.inject({url:'/api/codex/environments/native/insights?granularity=hour',headers:{cookie:cookies.admin}});expect(hourly.statusCode).toBe(200);expect(hourly.json().usage.rows).toEqual([]);
 });
 it('restores only enabled account tunnels used by running or detached sessions',async()=>{
  const active=await create(),disabled=await create(),closed=await create();
  getDb().prepare('UPDATE agent_environments SET enabled=0 WHERE id=?').run(disabled.id);
  const add=getDb().prepare("INSERT INTO sessions(id,task,status,cli_type,agent_environment_id) VALUES(?,?,?,'codex',?)");
  add.run('active','fixture','running',active.id);add.run('detached','fixture','detached',active.id);add.run('disabled','fixture','running',disabled.id);add.run('closed','fixture','stopped',closed.id);
  vi.mocked(transport.ensureAccountTransport).mockClear();await restoreActiveAccountTransports();
  expect(transport.ensureAccountTransport).toHaveBeenCalledOnce();expect(transport.ensureAccountTransport).toHaveBeenCalledWith(active.id,expect.objectContaining({username:'ymchen'}));
 });
 it('returns empty status caches without contacting Codex even on repeated or forced HTTP reads',async()=>{
  const e=await create(),read=vi.spyOn(stream,'withCodexConnection');
  for(let n=0;n<3;n++){
   const cards=await app.inject({url:`/api/codex/environments/${encodeURIComponent(e.id)}/reset-credits`,headers:{cookie:cookies.admin}});expect(cards.json()).toMatchObject({resets:null,pending:true});
   const quota=await app.inject({url:`/api/codex/environments/${encodeURIComponent(e.id)}/quota?force=true`,headers:{cookie:cookies.owner}});expect(quota.statusCode).toBe(503);
  }
  expect(read).not.toHaveBeenCalled();
 });
 it('restricts upstream group statistics to administrators and serves cached data',async()=>{
  updateAgentManagement('codex',()=>({defaults:{},providers:[{id:'gateway',name:'Gateway',kind:'responses',enabled:true,fields:{models:['m'],baseUrl:'https://xindu.xyz/v1',envKey:'WALLET_GROUP_TEST'}}]}));
  process.env.WALLET_GROUP_TEST=randomUUID();
  try{
   vi.spyOn(stream,'withCodexConnection').mockImplementation(async callback=>callback(vi.fn(async()=>({account:{type:'apiKey'}})) as any));
   vi.stubGlobal('fetch',vi.fn(async()=>new Response('{"balance":12}')));
   await collectEngineBalance('provider:gateway');const group=cachedEngineBalance('provider:gateway').groupKey;expect(group).toMatch(/^[a-f0-9]{64}$/);vi.mocked(stream.withCodexConnection).mockClear();
   const path=`/api/codex/balance-groups/${group}/insights`;
   expect((await app.inject({url:path,headers:{cookie:cookies.owner}})).statusCode).toBe(403);
   expect((await app.inject({url:path,headers:{cookie:cookies.admin}})).json()).toMatchObject({usage:{partial:true,rows:[]}});
   expect(stream.withCodexConnection).not.toHaveBeenCalled();
  }finally{delete process.env.WALLET_GROUP_TEST;vi.unstubAllGlobals();}
 });
 it('protects usage caches and reset details using the same account visibility boundary',async()=>{
  const e=await create();
  for(const endpoint of ['insights','reset-credits','balance']){
   expect((await app.inject({url:`/api/codex/environments/${encodeURIComponent(e.id)}/${endpoint}`,headers:{cookie:cookies.owner}})).statusCode).toBe(403);
   expect((await app.inject({url:`/api/codex/environments/${encodeURIComponent(e.id)}/${endpoint}`,headers:{cookie:cookies.other}})).statusCode).toBe(404);
   expect((await app.inject({url:`/api/codex/environments/native/${endpoint}`,headers:{cookie:cookies.other}})).statusCode).toBe(404);
  }
  const balance=await app.inject({url:`/api/codex/environments/${encodeURIComponent(e.id)}/balance`,headers:{cookie:cookies.admin}});expect(balance.statusCode).toBe(200);expect(balance.json()).toMatchObject({auth_mode:null,status:'unavailable'});
  const cached=await app.inject({url:`/api/codex/environments/${encodeURIComponent(e.id)}/insights`,headers:{cookie:cookies.admin}});expect(cached.statusCode).toBe(200);expect(cached.json().usage.rows).toEqual([]);
  vi.spyOn(stream,'withCodexConnection').mockImplementation(async callback=>callback(vi.fn(async(method:string)=>method==='account/read'?{account:{type:'chatgpt',email:'fixture@example.invalid'}}:{rateLimitResetCredits:{availableCount:2,credits:null}}) as any));
  await collectAccountStatus(e.id);vi.mocked(stream.withCodexConnection).mockClear();
  const resets=await app.inject({url:`/api/codex/environments/${encodeURIComponent(e.id)}/reset-credits`,headers:{cookie:cookies.admin}});expect(resets.json().resets).toEqual({availableCount:2,credits:null});
  expect(stream.withCodexConnection).not.toHaveBeenCalled();
 });
 it('reads quota through the selected account and denies unassigned, disabled and native environments',async()=>{
  const e=await create();
  const request=vi.fn(async(method:string)=>method==='account/read'?{account:{type:'chatgpt'}}:{rateLimits:{secondary:{usedPercent:30,windowDurationMins:10080}}});
  const read=vi.spyOn(stream,'withCodexConnection').mockImplementation(async callback=>callback(request as any));
  await collectAccountStatus(e.id);read.mockClear();
  const allowed=await app.inject({url:`/api/codex/environments/${encodeURIComponent(e.id)}/quota`,headers:{cookie:cookies.owner}});
  expect(allowed.statusCode).toBe(200);expect(allowed.json().quota.remainingPercent).toBe(70);
  expect(transport.ensureAccountTransport).toHaveBeenCalledWith(e.id,expect.objectContaining({username:'ymchen'}));expect(read).not.toHaveBeenCalled();
  for(const id of [e.id,'missing']){const denied=await app.inject({url:`/api/codex/environments/${encodeURIComponent(id)}/quota`,headers:{cookie:cookies.other}});expect(denied.statusCode).toBe(404);}
  getDb().prepare('UPDATE agent_environments SET enabled=0 WHERE id=?').run(e.id);
  const disabled=await app.inject({url:`/api/codex/environments/${encodeURIComponent(e.id)}/quota`,headers:{cookie:cookies.owner}});expect(disabled.statusCode).toBe(404);expect(read).not.toHaveBeenCalled();
 });
 it('shows native quota to admins but hides an unassigned host account and missing login',async()=>{
  const request=vi.fn(async(method:string)=>method==='account/read'?{account:{type:'chatgpt'}}:{rateLimits:{secondary:{usedPercent:40,windowDurationMins:10080}}});
  const read=vi.spyOn(stream,'withCodexConnection').mockImplementation(async callback=>callback(request as any));
  const hidden=await app.inject({url:'/api/codex/environments/native/quota',headers:{cookie:cookies.other}});
  expect(hidden.json()).toEqual({quota:null,reason:'not_applicable'});expect(read).not.toHaveBeenCalled();
  await collectAccountStatus('native');read.mockClear();
  const allowed=await app.inject({url:'/api/codex/environments/native/quota',headers:{cookie:cookies.admin}});
  expect(allowed.statusCode).toBe(200);expect(allowed.json().quota.remainingPercent).toBe(60);
  request.mockImplementation(async()=>({account:null}) as any);
  await collectAccountStatus('native');read.mockClear();
  const loggedOut=await app.inject({url:'/api/codex/environments/native/quota',headers:{cookie:cookies.admin}});expect(loggedOut.json()).toMatchObject({quota:null,reason:'not_applicable'});
 });
 it('keeps a legacy saved absolute command visible so administrators can correct it',async()=>{
  const environment=await create();
  getDb().prepare('UPDATE agent_environments SET config=? WHERE id=?').run(JSON.stringify({...connection,codexCommand:'/home/fixture/codex --old-flag'}),environment.id);
  const response=await app.inject({url:'/api/codex/environments?management=true',headers:{cookie:cookies.admin}});
  expect(response.statusCode).toBe(200);expect(response.json().environments.find((e:any)=>e.id===environment.id).connection.codexCommand).toContain('--old-flag');
  await expect(saveCodexEnvironment({name:environment.name,connection,allowed_user_ids:[owner.id]},environment.id)).resolves.toMatchObject({connection:{codexCommand:'codex'}});
 });
 it('uses one native and API provider name across configuration and authorized environment lists',async()=>{
  updateAgentManagement('codex',()=>({defaults:{},providers:[{id:'gateway',name:'Old API',kind:'responses',enabled:true,fields:{models:['m'],baseUrl:'https://example.invalid/v1'}}]}));
  await saveCodexEnvironment({name:'Old native',allowed_user_ids:null},'native');
  await saveCodexEnvironment({name:'Old API',allowed_user_ids:null},'provider:gateway');
  renameCodexProvider('native','Native renamed');renameCodexProvider('gateway','API renamed');
  const response=await app.inject({url:'/api/codex/environments',headers:{cookie:cookies.admin}});
  expect(response.json().environments).toEqual(expect.arrayContaining([expect.objectContaining({id:'native',name:'Native renamed'}),expect.objectContaining({id:'provider:gateway',name:'API renamed'})]));
  await saveCodexEnvironment({name:'Native again'},'native');await saveCodexEnvironment({name:'API again'},'provider:gateway');
  expect(visibleCodexEnvironments(admin.id)).toEqual(expect.arrayContaining([expect.objectContaining({id:'native',name:'Native again'}),expect.objectContaining({id:'provider:gateway',name:'API again'})]));
 });
 it('keeps existing native and API Provider access without requiring account login',()=>{
  updateAgentManagement('codex',()=>({defaults:{},providers:[{id:'gateway',name:'API gateway',kind:'responses',enabled:true,fields:{models:['model-a'],baseUrl:'https://example.invalid/v1'}}]}));
  const visible=visibleCodexEnvironments(other.id);expect(visible.map(e=>e.id)).toEqual(['native','provider:gateway']);expect(visible[1].kind).toBe('provider');
 });
 it('shows private accounts to administrators and allowed members while hiding them from other members',async()=>{
  const e=await create();expect(visibleCodexEnvironments(owner.id).some(x=>x.id===e.id)).toBe(true);expect(visibleCodexEnvironments(other.id).some(x=>x.id===e.id)).toBe(false);expect(visibleCodexEnvironments(admin.id).some(x=>x.id===e.id)).toBe(true);
  const r=await app.inject({url:'/api/codex/environments',headers:{cookie:cookies.other}});expect(r.statusCode).toBe(200);expect(r.body).not.toContain('ymchen Codex');expect(r.body).not.toContain('identityFile');
  const management=await app.inject({url:'/api/codex/environments?management=true',headers:{cookie:cookies.admin}});expect(management.statusCode).toBe(200);expect(management.json().environments.some((x:any)=>x.id===e.id)).toBe(true);
 });
 it('rejects environment management from a regular platform account',async()=>{
  const r=await app.inject({method:'POST',url:'/api/codex/environments',headers:{cookie:cookies.owner},payload:{name:'account',connection,allowed_user_ids:[owner.id]}});expect(r.statusCode).toBe(403);
 });
 it('rejects invalid authorization lists and account-wide public access',async()=>{
  await expect(saveCodexEnvironment({name:'x',connection,allowed_user_ids:['unknown']})).rejects.toThrow('不存在');
  await expect(saveCodexEnvironment({name:'x',connection,allowed_user_ids:null})).rejects.toThrow('明确指定');
 });
 it('blocks direct REST calls and session creation by unauthorized regular members',async()=>{
  const e=await create();getDb().prepare("INSERT INTO sessions(id,project_id,task,status,cli_type,created_by_user_id,agent_environment_id) VALUES('s','p','work','failed','codex',?,?)").run(owner.id,e.id);
  for(const [method,path] of [['GET','/api/sessions/s/environments'],['GET',`/api/sessions/s/environments/${encodeURIComponent(e.id)}/models`],['POST','/api/sessions/s/environment']] as const){const r=await app.inject({method,url:path,headers:{cookie:cookies.other},...method==='POST'?{payload:{environment_id:e.id,model:'m',effort:'high'}}:{}});expect(r.statusCode).toBe(403);}
  const r=await app.inject({method:'POST',url:'/api/sessions',headers:{cookie:cookies.other},payload:{project_path:'/tmp/fixture-project',project_id:'p',cli_type:'codex',task:'work',environment_id:e.id}});expect(r.statusCode).toBe(403);
  expect(userCanUseSessionTool(other.id,'s','codex','session')).toBe(false);
 });
 it('allows administrators to select and create sessions with a private account without an explicit grant',async()=>{
  const e=await create();const r=await app.inject({method:'POST',url:'/api/sessions',headers:{cookie:cookies.admin},payload:{project_path:'/tmp/fixture-project',project_id:'p',cli_type:'codex',task:'admin test',environment_id:e.id}});expect(r.statusCode).toBe(200);expect(r.json().session.agent_environment_id).toBe(e.id);
  const list=await app.inject({url:'/api/codex/environments',headers:{cookie:cookies.admin}});expect(list.json().environments.some((x:any)=>x.id===e.id)).toBe(true);
  expect(userCanUseSessionTool(admin.id,r.json().session.id,'codex','session')).toBe(true);
  const invalidated=vi.fn(),stop=watchSessionEnvironment(r.json().session.id,admin.id,invalidated);
  try{await saveCodexEnvironment({name:e.name,allowed_user_ids:[]},e.id);expect(invalidated).not.toHaveBeenCalled();expect(canUseEnvironment('codex',e.id,admin.id)).toBe(true);}finally{stop();}
 });
 it('binds an authorized new tab before any worker is spawned',async()=>{
  const e=await create();const r=await app.inject({method:'POST',url:'/api/sessions',headers:{cookie:cookies.owner},payload:{project_path:'/tmp/fixture-project',project_id:'p',cli_type:'codex',task:'work',environment_id:e.id}});expect(r.statusCode).toBe(200);expect(r.json().session.agent_environment_id).toBe(e.id);
 });
 it('revokes existing tabs immediately and never contacts another account as a fallback',async()=>{
  const e=await create();getDb().prepare("INSERT INTO sessions(id,project_id,task,status,cli_type,created_by_user_id,agent_environment_id) VALUES('s','p','work','failed','codex',?,?)").run(owner.id,e.id);
  const invalidated=vi.fn();const stop=watchSessionEnvironment('s',owner.id,invalidated);
  try{expect(userCanUseSessionTool(owner.id,'s','codex','session')).toBe(true);await saveCodexEnvironment({name:e.name,allowed_user_ids:[]},e.id);expect(invalidated).toHaveBeenCalledOnce();expect(userCanUseSessionTool(owner.id,'s','codex','session')).toBe(false);const r=await app.inject({url:'/api/sessions/s/environments',headers:{cookie:cookies.owner}});expect(r.statusCode).toBe(403);}finally{stop();}
 });
 it('routes two OpenAI accounts by environment identity, even after reading modelProvider=openai',async()=>{
  const a=await create();const b=await saveCodexEnvironment({name:'second',connection:{...connection,username:'xlli'},allowed_user_ids:[other.id]});
  const one='019ff001-1212-7212-8212-121212121211',two='019ff001-1212-7212-8212-121212121212';
  getDb().prepare("INSERT INTO sessions(id,task,cli_type,codex_session_id,agent_environment_id) VALUES('a','x','codex',?,?),('b','x','codex',?,?)").run(one,a.id,two,b.id);
  const engineA=await engineForEnvironment(a.id),engineB=await engineForEnvironment(b.id);
  runInCodexEngine(engineA,()=>rememberCodexThread({id:one,modelProvider:'openai'}));runInCodexEngine(engineB,()=>rememberCodexThread({id:two,modelProvider:'openai'}));
  expect((await engineForThread(one)).environmentId).toBe(a.id);expect((await engineForThread(two)).environmentId).toBe(b.id);expect((await engineForThread(one)).socket).not.toBe((await engineForThread(two)).socket);
 });
 it('does not silently reassign used environments to a different OS account',async()=>{
  const e=await create();getDb().prepare("INSERT INTO sessions(id,task,agent_environment_id) VALUES('s','x',?)").run(e.id);
  await expect(saveCodexEnvironment({name:e.name,connection:{...connection,username:'xlli'}},e.id)).rejects.toThrow('归属');
 });
 it('reports a missing Codex login as a distinct preflight step without trying to log in',async()=>{
  vi.mocked(transport.probeAccountConnection).mockRejectedValueOnce(new transport.AccountConnectionError('codex_authentication','该系统用户尚未登录 Codex，请先运行 codex login'));
  const r=await app.inject({method:'POST',url:'/api/codex/environments/check-connection',headers:{cookie:cookies.admin},payload:connection});expect(r.statusCode).toBe(200);expect(r.json()).toMatchObject({ok:false,checks:[{stage:'codex_authentication',ok:false}]});expect(r.body).toContain('codex login');
 });
 it('encrypts SSH passwords, preserves an unchanged saved password, and never returns it to the browser',async()=>{
  const secret='dummy-ssh-password-for-tests';const e=await saveCodexEnvironment({name:'password',connection:{...connection,authMethod:'password',password:secret},allowed_user_ids:[owner.id]});
  expect(JSON.stringify(e)).not.toContain(secret);expect(e.connection).toMatchObject({authMethod:'password',passwordConfigured:true});expect(e.connection).not.toHaveProperty('password');
  const row=getDb().prepare('SELECT config FROM agent_environments WHERE id=?').get(e.id) as {config:string};expect(row.config).not.toContain(secret);expect(environmentConnection(e).password).toBe(secret);
  const updated=await saveCodexEnvironment({name:'updated',connection:{...e.connection,password:''}},e.id);expect(environmentConnection(updated).password).toBe(secret);
  const api=await app.inject({url:'/api/codex/environments?management=true',headers:{cookie:cookies.admin}});expect(api.body).not.toContain(secret);expect(api.body).not.toContain('encryptedPassword');
  await expect(saveCodexEnvironment({name:'x',connection:{...updated.connection,username:'second',password:''}},e.id)).rejects.toThrow('SSH 登录密码');
 });
 it('validates SSH settings and uses localhost, strict host checking and noninteractive key auth',()=>{
  expect(()=>transport.validateAccountConnection({...connection,username:'user;id'})).toThrow();expect(()=>transport.validateAccountConnection({...connection,port:0})).toThrow();expect(()=>transport.validateAccountConnection({...connection,codexHome:'~/.codex'})).toThrow();
  const args=transport.sshArguments({...connection,identityFile:'/tmp/test-key'});expect(args).toContain('StrictHostKeyChecking=yes');expect(args).toContain('BatchMode=yes');expect(args).toContain('/tmp/test-key');
 });
});
