import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createTestDatabase} from './helpers/database.js';
import {getDb} from '../src/db/index.js';
import {createUser} from '../src/auth.js';
import {readAgentManagement} from '../src/services/agents/management-store.js';
import {claudeManagement} from '../src/services/agents/claude/management.js';
import {capabilities} from '../src/services/agents/types.js';
import {
  canUseClaudeEnvironment,
  claudeEnvironmentName,
  claudeEnvironmentId,
  claudeManagementProviderState,
  claudeProviderForEnvironment,
  claudeProviderModelsForEnvironment,
  createClaudeProvider,
  deleteClaudeProvider,
  detectClaudeProviderModels,
  nativeClaudeProviderState,
  updateNativeClaudeProvider,
  updateClaudeProvider,
  ensureNativeClaudeProvider,
  persistDetectedClaudeModels,
} from '../src/services/agents/claude/providers.js';

let database:ReturnType<typeof createTestDatabase>;
beforeEach(()=>{database=createTestDatabase();});
afterEach(()=>{database.cleanup();vi.unstubAllGlobals();});

const create=(id='gateway')=>createClaudeProvider({
 id,name:'Gateway',kind:'anthropic-compatible',apiKey:'secret-token',
 fields:{baseUrl:'https://gateway.example',models:['claude-a','claude-b'],defaultModel:'claude-a',contextWindow:'200000'},
});

describe('Claude managed providers',()=>{
 it('presents native Anthropic and managed gateways through the same provider fields',()=>{
  create();
  expect(nativeClaudeProviderState()).toMatchObject({
   id:'anthropic',
   managed:true,
   fields:expect.arrayContaining([
    expect.objectContaining({key:'baseUrl'}),
    expect.objectContaining({key:'envKey'}),
    expect.objectContaining({key:'models'}),
   ]),
  });
  expect(claudeManagementProviderState('gateway')?.fields.map(field=>field.key)).toEqual(
   nativeClaudeProviderState().fields.map(field=>field.key),
  );
 });
 it('stores native Anthropic in the encrypted provider runtime instead of stale LaunchAgent aliases',()=>{
  updateNativeClaudeProvider({
   apiKey:'native-token',
   fields:{
    baseUrl:'https://native.example',
    models:['claude-fable-5','opus','sonnet','haiku'],
    defaultModel:'claude-fable-5',
    contextWindow:'1000000',
   },
  });
  const stored=readAgentManagement('claude').providers.find(provider=>provider.id==='anthropic');
  expect(stored).toMatchObject({fields:{baseUrl:'https://native.example',models:['claude-fable-5','opus','sonnet','haiku'],defaultModel:'claude-fable-5'}});
  expect(nativeClaudeProviderState()).toMatchObject({status:'ready',authentication:{status:'authenticated'}});
  expect(claudeProviderForEnvironment('claude-provider:anthropic')).toMatchObject({authToken:'native-token',defaultModel:'claude-fable-5'});
  expect(ensureNativeClaudeProvider()).toBeUndefined();
 });
 it('stores independent encrypted endpoints and resolves only the bound provider',()=>{
  create();
  const owner=createUser({username:'claude-owner',password:'password1'});
  const id=claudeEnvironmentName('gateway');
  expect(readAgentManagement('claude').providers.find(provider=>provider.id==='gateway')).toMatchObject({
   name:'Gateway',enabled:true,fields:{baseUrl:'https://gateway.example',models:['claude-a','claude-b'],contextWindow:'200000'},
  });
  expect(JSON.stringify(readAgentManagement('claude'))).not.toContain('secret-token');
  expect(claudeProviderForEnvironment(id)).toMatchObject({
   id:'gateway',baseUrl:'https://gateway.example',authToken:'secret-token',defaultModel:'claude-a',contextWindow:200000,
  });
  expect(claudeManagementProviderState('gateway')).toMatchObject({status:'ready',models:['claude-a','claude-b']});
  expect(claudeProviderModelsForEnvironment('claude-provider:gateway')).toEqual(['claude-a','claude-b']);
  expect(canUseClaudeEnvironment(id,owner.id)).toBe(true);
  expect(canUseClaudeEnvironment('',owner.id)).toBe(true);
  expect(canUseClaudeEnvironment('anthropic',owner.id)).toBe(true);
  expect(claudeEnvironmentId('anthropic')).toBe('claude-provider:anthropic');
  expect(claudeEnvironmentId('claude-provider:gateway')).toBe('claude-provider:gateway');
  getDb()
   .prepare(
    "INSERT INTO agent_environment_user_access(environment_id,user_id,allowed) VALUES(?,?,0)",
   )
   .run(id,owner.id);
  expect(canUseClaudeEnvironment(id,owner.id)).toBe(false);
 });
 it('rejects credential mixing and keeps the native environment compatible',()=>{
  create();
  createClaudeProvider({id:'second',name:'Second',apiKey:'second-token',fields:{baseUrl:'https://second.example',models:['model-b']}});
  expect(()=>createClaudeProvider({id:'gateway',apiKey:'duplicate',fields:{baseUrl:'https://duplicate.example',models:['x']}})).toThrow('已存在');
  expect(()=>createClaudeProvider({id:'bad',fields:{baseUrl:'https://bad.example',models:['x']}})).toThrow('API Key');
  expect(()=>createClaudeProvider({id:'bad-url',apiKey:'x',fields:{baseUrl:'file:///tmp/x',models:['x']}})).toThrow('HTTP');
  expect(claudeProviderForEnvironment('anthropic')).toBeNull();
  expect(()=>claudeProviderForEnvironment('provider:other')).toThrow('不是 Claude');
 });
 it('blocks deletion while an active session remains bound',()=>{
  create();
  const owner=createUser({username:'claude-session-owner',password:'password1'});
  getDb().prepare("INSERT INTO sessions(id,task,status,cli_type,agent_environment_id,created_by_user_id) VALUES('bound','Task','running','claude',?,?)").run(claudeEnvironmentName('gateway'),owner.id);
  expect(()=>deleteClaudeProvider('gateway')).toThrow('运行中的 Claude 会话');
 getDb().prepare("UPDATE sessions SET status='completed' WHERE id='bound'").run();
  deleteClaudeProvider('gateway');
  expect(readAgentManagement('claude').providers).toEqual([]);
 });
 it('detects models through the provider protocol without returning error bodies',async()=>{
  create();
  const fetchMock=vi.fn().mockResolvedValue(new Response(JSON.stringify({data:[{id:'claude-a',display_name:'Claude A'},{id:'invalid model'}]}),{status:200}));
  vi.stubGlobal('fetch',fetchMock);
  expect(await detectClaudeProviderModels({providerId:'gateway'})).toEqual([{model:'claude-a',name:'Claude A',description:'由 Claude 兼容网关返回'}]);
  expect(fetchMock).toHaveBeenCalledWith('https://gateway.example/models',expect.objectContaining({headers:expect.objectContaining({Authorization:'Bearer secret-token','anthropic-version':'2023-06-01'})}));
  fetchMock.mockResolvedValueOnce(new Response('private upstream body',{status:502}));
  await expect(detectClaudeProviderModels({providerId:'gateway'})).rejects.toThrow('502');
 });
 it('replaces stale aliases with only models returned by discovery',async()=>{
  create();
  persistDetectedClaudeModels('gateway',[
   {model:'claude-fable-5',name:'Claude Fable'},
   {model:'claude-fable-5-1',name:'Claude Fable 1'},
  ]);
  const provider=readAgentManagement('claude').providers.find(item=>item.id==='gateway');
  expect(provider?.fields).toMatchObject({
   models:['claude-fable-5','claude-fable-5-1'],
   defaultModel:'claude-fable-5',
  });
  expect(provider?.fields.models).not.toContain('grok-4.5');
 });
 it('persists only the gateway catalog for native and custom Provider discovery',async()=>{
  create();
  updateClaudeProvider('gateway',{
   fields:{models:['grok-4.5','opus'],defaultModel:'opus'},
  });
  updateNativeClaudeProvider({
   apiKey:'native-token',
   fields:{baseUrl:'https://native.example',models:['grok-4.5','opus'],defaultModel:'opus'},
  });
  const fetchMock=vi.fn(async (url:string)=>
   new Response(JSON.stringify({data:[
    {id:url.startsWith('https://native.example')?'claude-native':'claude-gateway'},
   ]}),{status:200}),
  );
  vi.stubGlobal('fetch',fetchMock);
  const management=claudeManagement({
   id:'claude',label:'Claude',sessionHost:'managed',
   capabilities:capabilities(['history','runtime','input','stream']),
   presentation:{icon:'claude',color:'#d97757'},
  });

  expect(await management.detectModels?.({providerId:'anthropic'}))
   .toEqual([expect.objectContaining({model:'claude-native'})]);
  expect(nativeClaudeProviderState()).toMatchObject({
   models:['claude-native'],defaultModel:'claude-native',
  });
  expect(await management.detectModels?.({providerId:'gateway'}))
   .toEqual([expect.objectContaining({model:'claude-gateway'})]);
  expect(readAgentManagement('claude').providers.find(item=>item.id==='gateway')?.fields)
   .toMatchObject({models:['claude-gateway'],defaultModel:'claude-gateway'});
  expect(claudeProviderModelsForEnvironment('claude-provider:gateway')).toEqual(['claude-gateway']);
  expect(fetchMock).toHaveBeenCalledTimes(2);
 });
 it('clears a stale catalog when discovery succeeds with no models',()=>{
  create();
  persistDetectedClaudeModels('gateway',[]);
  expect(readAgentManagement('claude').providers[0].fields).toMatchObject({
   models:[],defaultModel:'',
  });
 });
});
