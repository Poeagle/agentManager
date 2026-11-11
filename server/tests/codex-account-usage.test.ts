import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {createTestDatabase} from './helpers/database.js';
import {getDb} from '../src/db/index.js';
import {initAccountUsage,collectAccountUsage,cachedAccountUsage,cachedGroupUsage,startAccountUsage,stopAccountUsage} from '../src/services/agents/codex/account-usage.js';
import {accountCommandInput,localCommandInput} from '../src/services/agents/codex/account-transport.js';
import {updateAgentManagement} from '../src/services/agents/management-store.js';
vi.mock('../src/services/agents/codex/account-transport.js',async original=>({...await original<typeof import('../src/services/agents/codex/account-transport.js')>(),accountCommandInput:vi.fn(),localCommandInput:vi.fn()}));
let fixture:ReturnType<typeof createTestDatabase>;
const tokens={total_tokens:10,input_tokens:10,cached_input_tokens:null,output_tokens:0,reasoning_output_tokens:null};
const row={day:'2026-01-01',cwd:'/project',model:null,tier:null,requests:1,tokens};
function respond(rows:any[]=[row],options:Record<string,unknown>={}){vi.mocked(localCommandInput).mockImplementation(async(_script,input)=>JSON.stringify({...JSON.parse(input),rows,events:[],events_truncated:false,partial:false,errors:0,...options}));}
beforeEach(()=>{fixture=createTestDatabase();initAccountUsage();respond();vi.mocked(accountCommandInput).mockImplementation(async(_c,_s,input)=>JSON.stringify({...JSON.parse(input),rows:[row],events:[],events_truncated:false,partial:false,errors:0}));});
afterEach(async()=>{await stopAccountUsage();fixture.cleanup();vi.resetAllMocks();vi.useRealTimers();});
it('groups model usage across speeds while retaining unknown models and exact totals',async()=>{
 const token=(input:number,cached:number)=>({input_tokens:input,cached_input_tokens:cached,output_tokens:0,reasoning_output_tokens:0,total_tokens:input});
 respond([{...row,model:'gpt-6.1-sol',tier:'default',tokens:token(100,50)},{...row,model:'gpt-6.1-sol',tier:'fast',tokens:token(900,900)},{...row,model:'gpt-6.1-terra',tokens:token(100,0)},{...row,tokens:token(0,0)}]);
 await collectAccountUsage('native');
 const r=cachedAccountUsage('native').rows[0];expect(r.tokens.input_tokens).toBe(1100);expect(r.tokens.cached_input_tokens).toBe(950);expect(r.models).toHaveLength(3);
 const sol=r.models.find(m=>m.model==='gpt-6.1-sol')!;expect(sol.tokens.input_tokens).toBe(1000);expect(sol.estimated_credits).toBeCloseTo(0.007125);expect(r.models.find(m=>m.model===null)?.estimated_credits).toBeNull();
 expect(r.models.reduce((n,m)=>n+(m.tokens.total_tokens??0),0)).toBe(r.tokens.total_tokens);
});
it('performs one full scan, then atomically replaces today without adding duplicates or changing historical days',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-01-02T12:00:00Z'));
 respond([row,{...row,day:'2026-01-02'}]);await collectAccountUsage('native');
 expect(JSON.parse(vi.mocked(localCommandInput).mock.calls[0][1])).toMatchObject({mode:'full',day:'2026-01-02'});
 respond([{...row,day:'2026-01-02',tokens:{...tokens,total_tokens:20}}]);await collectAccountUsage('native');initAccountUsage();await collectAccountUsage('native');
 expect(vi.mocked(localCommandInput)).toHaveBeenCalledTimes(3);const input=JSON.parse(vi.mocked(localCommandInput).mock.calls[2][1]);expect(input.mode).toBe('daily');expect(input).not.toHaveProperty('cursors');
 expect(cachedAccountUsage('native').rows.map(r=>[r.date,r.tokens.total_tokens])).toEqual([['2026-01-02',20],['2026-01-01',10]]);
 respond([]);await collectAccountUsage('native');expect(cachedAccountUsage('native').rows.map(r=>r.date)).toEqual(['2026-01-01']);
});
it('retains the last snapshot on failure or invalid response and retries the full baseline when uninitialized',async()=>{
 vi.mocked(localCommandInput).mockRejectedValueOnce(Error('denied'));await collectAccountUsage('native');expect(cachedAccountUsage('native').initialized).toBe(false);
 await collectAccountUsage('native');expect(JSON.parse(vi.mocked(localCommandInput).mock.calls[1][1]).mode).toBe('full');
 respond([],{day:'wrong'});await collectAccountUsage('native');
 expect(cachedAccountUsage('native')).toMatchObject({initialized:true,partial:true,error:'采集失败，保留上次成功数据'});expect(cachedAccountUsage('native').rows[0].tokens.total_tokens).toBe(10);
});
it('schedules one pass every five minutes without batch loops',async()=>{
 vi.useFakeTimers();respond([]);startAccountUsage();await vi.advanceTimersByTimeAsync(1000);expect(localCommandInput).toHaveBeenCalledTimes(1);
 await vi.advanceTimersByTimeAsync(299999);expect(localCommandInput).toHaveBeenCalledTimes(1);
 await vi.advanceTimersByTimeAsync(1);expect(localCommandInput).toHaveBeenCalledTimes(2);expect(JSON.parse(vi.mocked(localCommandInput).mock.calls[1][1]).mode).toBe('daily');
});
it('aborts the active file scan during shutdown and preserves the cache',async()=>{
 let signal:AbortSignal|undefined;
 vi.mocked(localCommandInput).mockImplementationOnce(async(_script,_input,options)=>new Promise((_resolve,reject)=>{signal=options?.signal;signal?.addEventListener('abort',()=>reject(Error('aborted')),{once:true});}));
 const task=collectAccountUsage('native');await Promise.resolve();await stopAccountUsage();await task;expect(signal?.aborted).toBe(true);expect(cachedAccountUsage('native').initialized).toBe(false);
});
it('returns project names, credit totals and request-weighted coverage from aggregated counters',async()=>{
 getDb().prepare("INSERT INTO projects(id,name,path) VALUES('usage-project','Usage Project','/project')").run();
 respond([{...row,model:'gpt-6.1-sol',tier:'default',cwd:'/project/src',requests:17,tokens:{total_tokens:1100000,input_tokens:1000000,cached_input_tokens:500000,output_tokens:100000,reasoning_output_tokens:50000}}]);await collectAccountUsage('native');
 expect(cachedAccountUsage('native').rows[0]).toMatchObject({project_name:'Usage Project',cwd:'/project/src',estimated_credits:51.25,credit_coverage:{covered:17,total:17}});
});
it('isolates accounts through their SSH connection and resets the baseline after account-source changes',async()=>{
 for(const id of ['a','b'])getDb().prepare("INSERT INTO agent_environments(id,agent_id,name,kind,enabled,config,allowed_user_ids) VALUES(?,'codex',?,'account',1,?,'[]')").run(id,id,JSON.stringify({username:id,port:22,codexCommand:'codex',codexHome:'/home/'+id+'/.codex',identityFile:''}));
 await collectAccountUsage('a');await collectAccountUsage('b');
 for(const id of ['a','b'])expect(accountCommandInput).toHaveBeenCalledWith(expect.objectContaining({username:id}),expect.any(String),expect.stringContaining('/home/'+id+'/.codex'),expect.objectContaining({timeoutMs:300000}));
 expect(cachedAccountUsage('a').rows[0].tokens.total_tokens).toBe(10);expect(cachedAccountUsage('b').rows[0].tokens.total_tokens).toBe(10);
 getDb().prepare("UPDATE agent_environments SET config=? WHERE id='a'").run(JSON.stringify({username:'a',port:22,codexCommand:'codex',codexHome:'/new-home',identityFile:''}));expect(cachedAccountUsage('a').rows).toEqual([]);await collectAccountUsage('a');expect(JSON.parse(vi.mocked(accountCommandInput).mock.calls.at(-1)![2]).mode).toBe('full');
});
it('collects a distinct provider history but refuses a shared directory and invalidates its old snapshot',async()=>{
 const provider=(id:string,home:string)=>({id,name:id,kind:'responses',enabled:true,fields:{codexHome:home,models:['m'],baseUrl:'https://example.invalid/v1'}});
 updateAgentManagement('codex',()=>({defaults:{},providers:[provider('a','/tmp/isolated-usage-a')]}));
 await collectAccountUsage('provider:a');expect(cachedAccountUsage('provider:a').rows).toHaveLength(1);
 expect(JSON.parse(vi.mocked(localCommandInput).mock.calls.at(-1)![1]).home).toBe('/tmp/isolated-usage-a');
 updateAgentManagement('codex',()=>({defaults:{},providers:[provider('a','/tmp/isolated-usage-a'),provider('b','/tmp/isolated-usage-a')]}));
 expect(cachedAccountUsage('provider:a').rows).toEqual([]);vi.mocked(localCommandInput).mockClear();
 await collectAccountUsage('provider:a');expect(localCommandInput).not.toHaveBeenCalled();expect(cachedAccountUsage('provider:a')).toMatchObject({partial:true,error:expect.stringContaining('共用'),rows:[]});
});
it('merges distinct provider histories while counting a copied session event only once',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
 const provider=(id:string)=>({id,name:id,kind:'responses',enabled:true,fields:{codexHome:'/tmp/group-fixture-'+id,models:['m'],baseUrl:'https://example.invalid/v1'}});
 updateAgentManagement('codex',()=>({defaults:{},providers:[provider('a'),provider('b')]}));
 const event={key:'a'.repeat(64),day:'2026-01-01',cwd:'/project',model:null,tier:null,tokens};
 respond([row],{events:[event]});await collectAccountUsage('provider:a');
 respond([row],{events:[event,{...event,key:'b'.repeat(64)}]});await collectAccountUsage('provider:b');
 expect(cachedGroupUsage(['provider:a','provider:b'])).toMatchObject({partial:false,rows:[{date:'2026-01-01',cwd:'/project',requests:2,tokens:{total_tokens:20}}]});
 const conflict={...event,tokens:{...tokens,total_tokens:15}};respond([row],{events:[conflict,{...event,key:'b'.repeat(64)}]});await collectAccountUsage('provider:b');
 expect(cachedGroupUsage(['provider:a','provider:b'])).toMatchObject({partial:true,rows:[{requests:1,tokens:{total_tokens:10}}]});
});
