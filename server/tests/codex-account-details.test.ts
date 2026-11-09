import Fastify,{type FastifyInstance} from 'fastify';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createTestDatabase} from './helpers/database.js';
import {createUser,createSession,authHook} from '../src/auth.js';
import {saveCodexEnvironment,getCodexEnvironment} from '../src/services/agents/codex/environments.js';
import {codexEnvironmentRoutes} from '../src/routes/codex-environments.js';
const state=vi.hoisted(()=>({command:vi.fn(),local:vi.fn(),rpc:vi.fn(),models:vi.fn()}));
vi.mock('../src/services/agents/codex/account-transport.js',async original=>({...await original<typeof import('../src/services/agents/codex/account-transport.js')>(),accountCommand:state.command,localCommandInput:state.local,ensureAccountTransport:vi.fn(async()=>({socket:'/fixture/socket',home:'/fixture/user/.codex'})),closeAccountTransport:vi.fn(async()=>{})}));
vi.mock('../src/services/agents/codex/native-engine.js',async original=>({...await original<typeof import('../src/services/agents/codex/native-engine.js')>(),inspectNativeCodexEngine:()=>({pid:456})}));
vi.mock('../src/services/agents/codex/controls.js',()=>({readEngineModelsForEnvironment:state.models}));
vi.mock('../src/services/agents/codex/stream.js',()=>({withCodexConnection:async(action:any)=>action(state.rpc)}));
let db:ReturnType<typeof createTestDatabase>,app:FastifyInstance,id:string,adminCookie:string,memberCookie:string;
beforeEach(async()=>{
 vi.clearAllMocks();db=createTestDatabase();const admin=createUser({username:'details-admin',password:'password1',role:'admin'}),member=createUser({username:'details-member',password:'password1'});adminCookie='agentmanager_session='+createSession(admin.id);memberCookie='agentmanager_session='+createSession(member.id);
 id=(await saveCodexEnvironment({name:'Selected account',connection:{username:'fixture_user',codexCommand:'codex'},allowed_user_ids:[member.id]})).id;
 state.command.mockResolvedValue(JSON.stringify({executable:'/fixture/user/bin/codex',version:'codex-cli 0.fixture',home:'/fixture/user/.codex',pid:123,config:{path:'/fixture/user/.codex/config.toml',exists:true},settings:{model:'fixture-model',model_provider:'openai',model_reasoning_effort:'high',api_key:'DO_NOT_RETURN_CONFIG_SECRET'},secret:'DO_NOT_RETURN_METADATA_SECRET'}));
 state.local.mockImplementation(()=>state.command());
 state.rpc.mockResolvedValue({account:{type:'chatgpt',email:'fixture@example.invalid',planType:'fixture-plan',accessToken:'DO_NOT_RETURN_AUTH_SECRET'}});state.models.mockResolvedValue([{model:'fixture-model',name:'Fixture model',description:'Selected account model',efforts:[],defaultEffort:'high'}]);
 app=Fastify();app.addHook('onRequest',authHook);await app.register(codexEnvironmentRoutes,{prefix:'/api'});
});
afterEach(async()=>{await app.close();db.cleanup();});
describe('selected system-user Codex account details',()=>{
 it('returns live identity, version, resolved paths, public defaults and models without auth or configuration secrets',async()=>{
  const r=await app.inject({url:'/api/codex/environments/'+encodeURIComponent(id)+'/details',headers:{cookie:adminCookie}});expect(r.statusCode).toBe(200);
  expect(r.json().details).toMatchObject({id,version:'codex-cli 0.fixture',home:'/fixture/user/.codex',authentication:{status:'authenticated',email:'fixture@example.invalid',plan:'fixture-plan'},settings:{model:'fixture-model',model_provider:'openai'},engine:{state:'connected',pid:123},models:[{model:'fixture-model'}]});
  expect(r.body).not.toContain('DO_NOT_RETURN');expect(r.body).not.toContain('accessToken');expect(state.models).toHaveBeenCalledWith(id,true);expect(state.rpc).toHaveBeenCalledWith('account/read',{});expect(state.rpc.mock.calls.map(call=>call[0])).not.toContain('turn/start');
 });
 it('provides the same native account details and redacts identity for unprivileged settings readers',async()=>{
  const adminResult=await app.inject({url:'/api/codex/environments/native/details',headers:{cookie:adminCookie}});expect(adminResult.statusCode).toBe(200);expect(adminResult.json().details).toMatchObject({id:'native',authentication:{email:'fixture@example.invalid',plan:'fixture-plan'},engine:{pid:456},models:[{model:'fixture-model'}]});
  expect(state.models).toHaveBeenCalledWith('native',true);expect(adminResult.body).not.toContain('DO_NOT_RETURN');
  const memberResult=await app.inject({url:'/api/codex/environments/native/details',headers:{cookie:memberCookie}});expect(memberResult.statusCode).toBe(200);expect(memberResult.json().details.authentication).toMatchObject({email:null,plan:null});expect(memberResult.body).not.toContain('fixture@example.invalid');
 });
 it('requires settings permission even when a member can use the account',async()=>{
  const r=await app.inject({url:'/api/codex/environments/'+encodeURIComponent(id)+'/details',headers:{cookie:memberCookie}});expect(r.statusCode).toBe(403);expect(state.command).not.toHaveBeenCalled();expect(state.rpc).not.toHaveBeenCalled();
 });
 it('reports a connection failure without altering or deleting the saved Provider',async()=>{
  state.command.mockRejectedValueOnce(Object.assign(Error('目标用户的 Codex 安装无法读取'),{stage:'codex_executable'}));
  const r=await app.inject({url:'/api/codex/environments/'+encodeURIComponent(id)+'/details',headers:{cookie:adminCookie}});expect(r.statusCode).toBe(409);expect(r.json()).toMatchObject({stage:'codex_executable',error:'目标用户的 Codex 安装无法读取'});expect(getCodexEnvironment(id).name).toBe('Selected account');
 });
});
