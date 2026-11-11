import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'crypto';
import {mkdtempSync,rmSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import {createTestDatabase} from './helpers/database.js';
import {updateAgentManagement} from '../src/services/agents/management-store.js';
import * as stream from '../src/services/agents/codex/stream.js';
import * as transport from '../src/services/agents/codex/account-transport.js';
import {initEngineBalance,collectEngineBalance,cachedEngineBalance} from '../src/services/agents/codex/engine-balance.js';
vi.mock('../src/services/agents/codex/environments.js',async original=>({...await original<typeof import('../src/services/agents/codex/environments.js')>(),engineForEnvironment:vi.fn(async(id:string)=>({environmentId:id}))}));
describe('engine balance snapshots',()=>{
 let db:ReturnType<typeof createTestDatabase>;
 let home:string,oldHome:string|undefined;
 beforeEach(()=>{oldHome=process.env.CODEX_HOME;home=mkdtempSync(join(tmpdir(),'engine-balance-'));process.env.CODEX_HOME=home;db=createTestDatabase();initEngineBalance();updateAgentManagement('codex',()=>({defaults:{},providers:[{id:'one',name:'One',kind:'responses',enabled:true,fields:{baseUrl:'https://sub.wanzhao.top/v1',models:['m'],envKey:'FIXTURE_WALLET_KEY'}},{id:'two',name:'Two',kind:'responses',enabled:true,fields:{baseUrl:'https://xindu.xyz/v1',models:['m'],envKey:'FIXTURE_WALLET_KEY'}}]}));process.env.FIXTURE_WALLET_KEY=randomUUID();vi.spyOn(stream,'withCodexConnection').mockImplementation(async callback=>callback(vi.fn(async()=>({account:{type:'apiKey'}})) as any));});
 afterEach(()=>{delete process.env.FIXTURE_WALLET_KEY;if(oldHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=oldHome;rmSync(home,{recursive:true,force:true});vi.unstubAllGlobals();vi.restoreAllMocks();db.cleanup();});
 it('coalesces concurrent collection, isolates engines and makes cache reads inert',async()=>{
  const fetch=vi.fn(async(url:URL)=>new Response(JSON.stringify({balance:url.hostname==='xindu.xyz'?9:6,usage:{today:{actual_cost:2}}})));vi.stubGlobal('fetch',fetch);
  expect(cachedEngineBalance('provider:one').auth_mode).toBeNull();
  await Promise.all([collectEngineBalance('provider:one'),collectEngineBalance('provider:one'),collectEngineBalance('provider:two')]);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(cachedEngineBalance('provider:one')).toMatchObject({auth_mode:'api',amount:6,todayActualCost:2,status:'available'});
  expect(cachedEngineBalance('provider:two')).toMatchObject({auth_mode:'api',amount:9,status:'available'});
  for(let i=0;i<3;i++)cachedEngineBalance('provider:one');expect(fetch).toHaveBeenCalledTimes(2);
 });
 it('keeps the prior snapshot stale on errors and discards it when credentials change',async()=>{
  const fetch=vi.fn().mockResolvedValueOnce(new Response('{"balance":7}')).mockResolvedValueOnce(new Response('',{status:401}));vi.stubGlobal('fetch',fetch);
  await collectEngineBalance('provider:one');const checkedAt=cachedEngineBalance('provider:one').checkedAt;
  await collectEngineBalance('provider:one');expect(cachedEngineBalance('provider:one')).toMatchObject({amount:7,status:'stale',error:'unauthorized',checkedAt});
  process.env.FIXTURE_WALLET_KEY=randomUUID();expect(cachedEngineBalance('provider:one')).toMatchObject({auth_mode:null,status:'unavailable'});
 });
 it('recognizes an account from the runtime without calling a wallet service',async()=>{
  vi.mocked(stream.withCodexConnection).mockImplementation(async callback=>callback(vi.fn(async()=>({account:{type:'chatgpt'}})) as any));
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);await collectEngineBalance('provider:one');
  expect(cachedEngineBalance('provider:one')).toMatchObject({auth_mode:'account',status:'unsupported'});expect(fetch).not.toHaveBeenCalled();
 });
 it('recognizes a host API key from runtime and reads its own configured wallet',async()=>{
  vi.spyOn(transport,'localCommandInput').mockResolvedValue(JSON.stringify({base:'https://sub.wanzhao.top/v1',key:randomUUID()}));
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('{"balance":12}')));
  await collectEngineBalance('native');expect(cachedEngineBalance('native')).toMatchObject({auth_mode:'api',status:'available',amount:12});
 });
 it('uses the live native provider URL and reads the key without requiring TOML support',async()=>{
  vi.mocked(stream.withCodexConnection).mockImplementation(async callback=>callback(vi.fn(async(method:string)=>method==='account/read'?{account:{type:'apiKey'}}:{config:{model_provider:'wz',model_providers:{wz:{base_url:'https://sub.wanzhao.top/v1'}}}}) as any));
  const command=vi.spyOn(transport,'localCommandInput').mockResolvedValue(JSON.stringify({key:randomUUID()}));
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('{"balance":12}')));
  await collectEngineBalance('native');expect(cachedEngineBalance('native')).toMatchObject({auth_mode:'api',providerId:'wz',status:'available',amount:12,origin:'https://sub.wanzhao.top'});
  expect(JSON.parse(command.mock.calls[0][1] as string)).toMatchObject({runtime_provider:'wz'});
  expect(command.mock.calls[0][0]).not.toMatch(/^import .*tomllib/m);
 });
 it('uses the active runtime provider authentication even when an OAuth account also exists',async()=>{
  vi.mocked(stream.withCodexConnection).mockImplementation(async callback=>callback(vi.fn(async(method:string)=>method==='account/read'?{account:{type:'chatgpt'}}:{config:{model_provider:'one',model_providers:{one:{env_key:'FIXTURE_WALLET_KEY'}}}}) as any));
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('{"balance":8}')));await collectEngineBalance('provider:one');
  expect(cachedEngineBalance('provider:one')).toMatchObject({auth_mode:'api',status:'available',amount:8});
 });
});
