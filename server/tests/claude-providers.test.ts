import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createTestDatabase} from './helpers/database.js';
import {getDb} from '../src/db/index.js';
import {createUser} from '../src/auth.js';
import {readAgentManagement} from '../src/services/agents/management-store.js';
import {
  canUseClaudeEnvironment,
  claudeEnvironmentName,
  claudeManagementProviderState,
  claudeProviderForEnvironment,
  createClaudeProvider,
  deleteClaudeProvider,
  detectClaudeProviderModels,
} from '../src/services/agents/claude/providers.js';

let database:ReturnType<typeof createTestDatabase>;
beforeEach(()=>{database=createTestDatabase();});
afterEach(()=>{database.cleanup();vi.unstubAllGlobals();});

const create=(id='gateway')=>createClaudeProvider({
 id,name:'Gateway',kind:'anthropic-compatible',apiKey:'secret-token',
 fields:{baseUrl:'https://gateway.example',models:['claude-a','claude-b'],defaultModel:'claude-a',contextWindow:'200000'},
});

describe('Claude managed providers',()=>{
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
  expect(canUseClaudeEnvironment(id,owner.id)).toBe(true);
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
});
