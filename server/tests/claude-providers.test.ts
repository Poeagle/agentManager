import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createTestDatabase} from './helpers/database.js';
import {getDb} from '../src/db/index.js';
import {createUser} from '../src/auth.js';
import {readAgentManagement,updateAgentManagement} from '../src/services/agents/management-store.js';
import {claudeManagement} from '../src/services/agents/claude/management.js';
import {capabilities} from '../src/services/agents/types.js';
import {modelRate} from '../src/services/agents/provider-pricing.js';
import {
  canUseClaudeEnvironment,
  claudeEnvironmentName,
  claudeEnvironmentId,
  claudeProviderEnvironment,
  claudeManagementProviderState,
  claudeProviderForEnvironment,
  claudeProviderModelsForEnvironment,
  claudeRuntimeProvider,
  createClaudeProvider,
  deleteClaudeProvider,
  detectClaudeProviderModels,
  nativeClaudeProviderState,
  verifyAndCreateClaudeProvider,
  updateNativeClaudeProvider,
  updateClaudeProvider,
  ensureNativeClaudeProvider,
  modelSupportsAdaptiveThinking,
  persistDetectedClaudeModels,
} from '../src/services/agents/claude/providers.js';

let database:ReturnType<typeof createTestDatabase>;
beforeEach(()=>{database=createTestDatabase();});
afterEach(()=>{database.cleanup();vi.unstubAllGlobals();});

const create=(id='gateway')=>createClaudeProvider({
 id,name:'Gateway',kind:'anthropic-compatible',apiKey:'secret-token',
 fields:{baseUrl:'https://gateway.example',models:['claude-a','claude-b'],defaultModel:'claude-a',contextWindow:'200000'},
});
it('keeps bracketed models and exposes official Claude Code routing controls',()=>{
  createClaudeProvider({
    id:'deepseek',apiKey:'secret',
    fields:{
      baseUrl:'https://api.deepseek.com/anthropic',
      models:['deepseek-flash[1m]','deepseek-flash'],
      defaultModel:'deepseek-flash[1m]',
      haikuModel:'deepseek-flash',
      subagentModel:'deepseek-flash',
      effort:'max',
      autoCompactWindow:'786432',
    },
  });
  const provider=claudeProviderForEnvironment('claude-provider:deepseek')!;
  expect(provider).toMatchObject({
    models:['deepseek-flash[1m]','deepseek-flash'],
    defaultModel:'deepseek-flash[1m]',
    haikuModel:'deepseek-flash',
    subagentModel:'deepseek-flash',
    effort:'max',
    autoCompactWindow:786432,
  });
  expect(claudeProviderEnvironment(provider,provider.defaultModel)).toMatchObject({
    ANTHROPIC_BASE_URL:'https://api.deepseek.com/anthropic',
    ANTHROPIC_MODEL:'deepseek-flash[1m]',
    ANTHROPIC_DEFAULT_OPUS_MODEL:'deepseek-flash[1m]',
    ANTHROPIC_DEFAULT_SONNET_MODEL:'deepseek-flash[1m]',
    ANTHROPIC_DEFAULT_HAIKU_MODEL:'deepseek-flash',
    CLAUDE_CODE_SUBAGENT_MODEL:'deepseek-flash',
    CLAUDE_CODE_EFFORT_LEVEL:'max',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW:'786432',
  });
  expect(claudeManagementProviderState('deepseek')?.providerOptions).toMatchObject({
   haikuModel:'deepseek-flash',
   subagentModel:'deepseek-flash',
   effort:'max',
   autoCompactWindow:'786432',
  });
});
it('verifies a manually entered model against Claude Messages before saving the provider',async()=>{
  const response=(model:string,status=200)=>new Response(JSON.stringify(status===200?{model}:{error:{type:'not_found_error'}}),{status,headers:{'content-type':'application/json'}});
  const fetchMock=vi.fn().mockResolvedValue(response('deepseek-chat'));
  vi.stubGlobal('fetch',fetchMock);
  await verifyAndCreateClaudeProvider({
    id:'deepseek',apiKey:'secret',
    fields:{baseUrl:'https://api.deepseek.com/anthropic',models:['deepseek-chat'],defaultModel:'deepseek-chat'},
  });
  expect(fetchMock).toHaveBeenCalledWith(
    'https://api.deepseek.com/anthropic/v1/messages',
    expect.objectContaining({method:'POST',body:expect.stringContaining('"model":"deepseek-chat"')}),
  );
  expect(claudeProviderForEnvironment('claude-provider:deepseek')).toMatchObject({models:['deepseek-chat'],defaultModel:'deepseek-chat'});
});
it('does not save a Claude Provider whose model cannot serve Anthropic Messages',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('',{status:404})));
  await expect(verifyAndCreateClaudeProvider({
    id:'deepseek',apiKey:'secret',
    fields:{baseUrl:'https://api.deepseek.com/anthropic',models:['deepseek-chat'],defaultModel:'deepseek-chat'},
  })).rejects.toThrow('不能用于 Claude Code');
  expect(readAgentManagement('claude').providers).toEqual([]);
});
it('keeps a valid configuration when an ambiguous provider preflight fails',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('network timeout')));
  await expect(claudeManagement({id:'claude',label:'Claude'} as any).createProvider({
    id:'deepseek',apiKey:'secret',
    fields:{baseUrl:'https://api.deepseek.com/anthropic',models:['deepseek-chat'],defaultModel:'deepseek-chat'},
  })).rejects.toThrow('配置已保存，可稍后重新测试连接');
  expect(claudeProviderForEnvironment('claude-provider:deepseek')).toMatchObject({models:['deepseek-chat']});
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
   expect.arrayContaining(nativeClaudeProviderState().fields.map(field=>field.key)),
  );
   expect(claudeManagementProviderState('gateway')?.fields).toContainEqual(
    expect.objectContaining({key:'adaptiveThinking',type:'toggle'}),
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
 it('applies row edits to the stored native gateway without replacing its credentials or settings',()=>{
  updateNativeClaudeProvider({apiKey:'native-token',fields:{
   baseUrl:'https://native.example',models:['claude-a','claude-b'],defaultModel:'claude-a',contextWindow:'1000000',
  }});
  updateNativeClaudeProvider({fields:{providerRateMultiplier:'1.2'}});
  updateNativeClaudeProvider({fields:{defaultModel:'claude-b'}});
  expect(()=>updateNativeClaudeProvider({fields:{defaultModel:'other-model'}})).toThrow('默认模型必须来自已选模型');
  const provider=claudeProviderForEnvironment('claude-provider:anthropic')!;
  expect(provider).toMatchObject({authToken:'native-token',baseUrl:'https://native.example',contextWindow:1000000,defaultModel:'claude-b'});
  expect(modelRate(provider.billingFields,'claude-a')).toBe(1.2);
  expect(modelRate(provider.billingFields,'claude-b')).toBe(1.2);
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
   id:'gateway',baseUrl:'https://gateway.example',authToken:'secret-token',defaultModel:'claude-a',adaptiveThinking:false,contextWindow:200000,
  });
  expect(claudeManagementProviderState('gateway')).toMatchObject({status:'ready',models:['claude-a','claude-b']});
  expect(claudeProviderModelsForEnvironment('claude-provider:gateway')).toEqual(['claude-a','claude-b']);
  expect(canUseClaudeEnvironment(id,owner.id)).toBe(true);
  expect(canUseClaudeEnvironment('',owner.id)).toBe(true);
  updateNativeClaudeProvider({apiKey:'fixture-native-token',fields:{baseUrl:'https://native.example',models:['sonnet'],defaultModel:'sonnet'}});
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
 it('marks Claude adaptive-thinking models without guessing unrelated model families',async()=>{
  create();
  updateClaudeProvider('gateway',{
   fields:{
    models:['claude-sonnet-5-5','claude-opus-4-8','claude-haiku-5-5','grok-4.6','claude-sonnet-4-5'],
    defaultModel:'claude-sonnet-5-5',
    adaptiveThinking:true,
   },
  });
  expect(modelSupportsAdaptiveThinking('claude-sonnet-5-5')).toBe(true);
  expect(modelSupportsAdaptiveThinking('claude-sonnet-4-6')).toBe(true);
  expect(modelSupportsAdaptiveThinking('claude-opus-4-8')).toBe(true);
  expect(modelSupportsAdaptiveThinking('claude-haiku-5-5')).toBe(true);
  expect(modelSupportsAdaptiveThinking('claude-sonnet-4-5')).toBe(false);
  expect(modelSupportsAdaptiveThinking('grok-4.6')).toBe(false);
  expect(claudeProviderForEnvironment('claude-provider:gateway')).toMatchObject({
   adaptiveThinking:true,
  });
  const {claudeProviderEnvironment}=await import('../src/services/agents/claude/providers.js');
  expect(claudeProviderEnvironment(claudeProviderForEnvironment('claude-provider:gateway'),'claude-sonnet-5-5')).toMatchObject({
   ANTHROPIC_MODEL:'claude-sonnet-5-5',
   CLAUDE_CODE_SUBAGENT_MODEL:'claude-sonnet-5-5',
   CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL:'claude-sonnet-5-5',
   ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES:'adaptive_thinking',
   ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES:'adaptive_thinking',
   ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES:'adaptive_thinking',
  });
 });
 it('infers adaptive thinking for an existing provider that predates the field',()=>{
  create();
  updateClaudeProvider('gateway',{
   fields:{
    models:['claude-sonnet-5-5'],
    defaultModel:'claude-sonnet-5-5',
   },
  });
  const stored=readAgentManagement('claude').providers.find(provider=>provider.id==='gateway')!;
  delete (stored.fields as Record<string,unknown>).adaptiveThinking;
  updateAgentManagement('claude',value=>({
   ...value,
   providers:value.providers.map(provider=>provider.id==='gateway'?stored:provider),
  }));
  expect(claudeProviderForEnvironment('claude-provider:gateway')).toMatchObject({
   adaptiveThinking:true,
  });
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
  const fetchMock=vi.fn().mockResolvedValue(new Response(JSON.stringify({data:[{id:'claude-a',display_name:'Claude A',context_window:500000,capabilities:{image_input:{supported:true}}},{id:'invalid model'}]}),{status:200}));
  vi.stubGlobal('fetch',fetchMock);
  const [model]=await detectClaudeProviderModels({providerId:'gateway'});
  expect(model).toMatchObject({model:'claude-a',name:'Claude A',description:'由 Claude 兼容网关返回',context_window:500000,input_modalities:['text','image']});
  updateClaudeProvider('gateway',{fields:{contextWindow:'',modelCapabilities:JSON.stringify({'claude-a':model})}});
  const saved=claudeProviderForEnvironment('claude-provider:gateway');
  expect(claudeProviderEnvironment(saved,'claude-a')?.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('500000');
  expect(claudeProviderEnvironment(saved,'claude-b')?.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();
  updateClaudeProvider('gateway',{fields:{baseUrl:'https://other.example'}});
  expect(claudeProviderEnvironment(claudeProviderForEnvironment('claude-provider:gateway'),'claude-a')?.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();
  expect(fetchMock).toHaveBeenCalledWith('https://gateway.example/models',expect.objectContaining({headers:expect.objectContaining({Authorization:'Bearer secret-token','anthropic-version':'2023-06-01'})}));
  fetchMock.mockResolvedValueOnce(new Response('private upstream body',{status:502}));
  await expect(detectClaudeProviderModels({providerId:'gateway'})).rejects.toThrow('502');
 });
it('falls back from a Claude prefix to its origin model catalog without naming a vendor',async()=>{
 create();
 const fetchMock=vi.fn(async(url:string)=>url.endsWith('/anthropic/models')
  ? new Response('',{status:404})
  : new Response(JSON.stringify({data:[{id:'deepseek-flash[1m]'},{id:'deepseek-flash'}]}),{status:200,headers:{'content-type':'application/json'}}));
 vi.stubGlobal('fetch',fetchMock);
 expect(await detectClaudeProviderModels({endpoint:'https://api.deepseek.com/anthropic',apiKey:'token'})).toMatchObject([
  {model:'deepseek-flash[1m]',name:'deepseek-flash[1m]',description:'由 Claude 兼容网关返回'},
  {model:'deepseek-flash',name:'deepseek-flash',description:'由 Claude 兼容网关返回'},
 ]);
 expect(fetchMock.mock.calls.map(([url])=>String(url))).toEqual([
  'https://api.deepseek.com/anthropic/models',
  'https://api.deepseek.com/models',
 ]);
});
it('isolates two Provider bindings that share a native ID, owner and project',()=>{
  createClaudeProvider({id:'deepseek',name:'DeepSeek',apiKey:'deepseek-token',fields:{baseUrl:'https://api.deepseek.com/anthropic',models:['deepseek-flash[1m]'],defaultModel:'deepseek-flash[1m]'}});
  createClaudeProvider({id:'other',name:'Other',apiKey:'other-token',fields:{baseUrl:'https://other.example',models:['other-model'],defaultModel:'other-model'}});
  const deepseek=claudeRuntimeProvider({agent_environment_id:'claude-provider:deepseek'},undefined,{materializeNative:false})!;
  const other=claudeRuntimeProvider({agent_environment_id:'claude-provider:other'},undefined,{materializeNative:false})!;
  expect(claudeProviderEnvironment(deepseek,deepseek.defaultModel)).toMatchObject({
    ANTHROPIC_BASE_URL:'https://api.deepseek.com/anthropic',
    ANTHROPIC_MODEL:'deepseek-flash[1m]',
  });
  expect(claudeProviderEnvironment(other,other.defaultModel)).toMatchObject({
    ANTHROPIC_BASE_URL:'https://other.example',
    ANTHROPIC_MODEL:'other-model',
  });
  expect(deepseek.authToken).not.toBe(other.authToken);
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
