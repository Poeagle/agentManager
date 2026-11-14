import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {createTestDatabase} from './helpers/database.js';
import {getDb} from '../src/db/index.js';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,appendFile,utimes,rm,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initAccountUsage,collectAccountUsage,cachedAccountUsage,cachedGroupUsage,backfillUsageHours,startAccountUsage,stopAccountUsage,refreshUsageRules,USAGE_RULE_VERSION} from '../src/services/agents/codex/account-usage.js';
import {accountCommandInput,localCommandInput} from '../src/services/agents/codex/account-transport.js';
vi.mock('../src/services/agents/codex/account-transport.js',async original=>({...await original<typeof import('../src/services/agents/codex/account-transport.js')>(),accountCommandInput:vi.fn(),localCommandInput:vi.fn()}));
import {updateAgentManagement} from '../src/services/agents/management-store.js';
import * as engineBalance from '../src/services/agents/codex/engine-balance.js';
let fixture:ReturnType<typeof createTestDatabase>;
const tokens={total_tokens:10,input_tokens:10,cached_input_tokens:null,output_tokens:0,reasoning_output_tokens:null};
const row={day:'2026-01-01',cwd:'/project',model:null,tier:null,requests:1,tokens};
it('recovers recorded hours from real history while retaining unknown deleted history',async()=>{
 const home=await mkdtemp(join(tmpdir(),'usage-hours-')),old=process.env.CODEX_HOME,oldZone=process.env.TZ;process.env.CODEX_HOME=home;process.env.TZ='UTC';
 const header=JSON.stringify({type:'session_meta',payload:{id:'hour-session',cwd:'/project'}})+'\n';
 const turn=(id:string,time:string,total:number,last:number)=>JSON.stringify({type:'turn_context',payload:{turn_id:id,model:'gpt-6.1-sol'}})+'\n'+JSON.stringify({type:'event_msg',timestamp:time,payload:{type:'token_count',info:{total_token_usage:{total_tokens:total},last_token_usage:{...tokens,input_tokens:last,total_tokens:last}}}})+'\n';
 try{
  await mkdir(join(home,'sessions'));const path=join(home,'sessions','sample.jsonl');await writeFile(path,header+turn('a','2026-01-01T01:12:00Z',10,10)+turn('b','2026-01-01T02:03:00Z',30,20));
  vi.mocked(localCommandInput).mockImplementation((script,input)=>new Promise((resolve,reject)=>{const child=execFile('python3',['-c',script],{maxBuffer:1024*1024},(error,out)=>error?reject(error):resolve(out));child.stdin!.end(input);}));
  await collectAccountUsage('native');const original=cachedAccountUsage('native').rows[0].tokens.total_tokens;expect(original).toBe(30);
  getDb().prepare('UPDATE codex_usage_dedup_events SET hour=NULL WHERE account=?').run('native');
  await backfillUsageHours('native');const hours=cachedGroupUsage(['native'],'hour',true);
  expect(hours.partial).toBe(false);expect(hours.rows.map(r=>[r.hour,r.tokens.total_tokens])).toEqual([['2026-01-01T02:00:00+00:00',20],['2026-01-01T01:00:00+00:00',10]]);
  expect(cachedAccountUsage('native').rows[0].tokens.total_tokens).toBe(original);
  await collectAccountUsage('native',{rebuild:true});expect(cachedAccountUsage('native').rows[0].tokens.total_tokens).toBe(30);expect(cachedGroupUsage(['native'],'hour',true).rows).toHaveLength(2);
  getDb().prepare('UPDATE codex_usage_dedup_status SET ready=0 WHERE account=?').run('native');await collectAccountUsage('native');
  expect(getDb().prepare('SELECT ready FROM codex_usage_dedup_status WHERE account=?').get('native')).toEqual({ready:1});expect(cachedAccountUsage('native').rows[0].tokens.total_tokens).toBe(30);
  await appendFile(path,JSON.stringify({type:'event_msg',timestamp:'2026-01-01T03:00:00Z',payload:{type:'token_count',info:{total_token_usage:{},last_token_usage:{}}}})+'\n');
  await collectAccountUsage('native',{rebuild:true});expect(cachedAccountUsage('native')).toMatchObject({initialized:true,partial:true,rows:[{tokens:{total_tokens:30}}]});
  await utimes(path,new Date('2026-01-01T00:00:00Z'),new Date('2026-01-01T00:00:00Z'));await collectAccountUsage('native');expect(cachedAccountUsage('native')).toMatchObject({partial:true,error:'部分记录不可读取或缺少统计字段'});
  const realScanner=vi.mocked(localCommandInput).getMockImplementation()!;vi.mocked(localCommandInput).mockRejectedValueOnce(Error('fixture read failure'));
  await expect(collectAccountUsage('native',{rebuild:true})).rejects.toThrow('保留上次成功数据');expect(cachedAccountUsage('native').rows[0].tokens.total_tokens).toBe(30);vi.mocked(localCommandInput).mockImplementation(realScanner);
  getDb().prepare('UPDATE codex_usage_dedup_events SET hour=NULL WHERE account=?').run('native');getDb().prepare('UPDATE codex_usage_dedup_status SET hour_backfilled=0 WHERE account=?').run('native');await rm(path);
  await backfillUsageHours('native');expect(cachedGroupUsage(['native'],'hour',true)).toMatchObject({partial:true,rows:[{hour:null,tokens:{total_tokens:30}}]});expect(cachedAccountUsage('native').rows[0].tokens.total_tokens).toBe(30);
  await collectAccountUsage('native',{rebuild:true});expect(cachedAccountUsage('native').rows).toEqual([]);
 }finally{if(old===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=old;if(oldZone===undefined)delete process.env.TZ;else process.env.TZ=oldZone;await rm(home,{recursive:true,force:true});}
});
function response(input:string,rows:any[],options:Record<string,unknown>={}){
 const request=JSON.parse(input),known=Buffer.from(request.known_events||'','base64'),seen=new Set<string>();for(let i=0;i<known.length;i+=32)seen.add(known.subarray(i,i+32).toString('hex'));
 const eventKeys:Record<string,Buffer[]>={},fresh=rows.filter(r=>{const keys=Array.from({length:r.requests},(_,i)=>createHash('sha256').update(JSON.stringify([r,i])).digest());if(keys.every(k=>seen.has(k.toString('hex'))))return false;(eventKeys[r.day]??=[]).push(...keys);return true;});
 return JSON.stringify({...request,rows:fresh,event_keys:Object.fromEntries(Object.entries(eventKeys).map(([day,keys])=>[day,Buffer.concat(keys).toString('base64')])),events:[],events_truncated:false,partial:false,errors:0,...options});
}
function respond(rows:any[]=[row],options:Record<string,unknown>={}){vi.mocked(localCommandInput).mockImplementation(async(_script,input)=>response(input,rows,options));}
beforeEach(()=>{vi.stubEnv('TZ','UTC');fixture=createTestDatabase();initAccountUsage();respond();vi.mocked(accountCommandInput).mockImplementation(async(_c,_s,input)=>response(input,[row]));});
afterEach(async()=>{await stopAccountUsage();fixture.cleanup();vi.restoreAllMocks();vi.resetAllMocks();vi.useRealTimers();vi.unstubAllEnvs();});
it('reprocesses old Fast metadata on a rule upgrade and preserves data if history is missing',async()=>{
 const home=await mkdtemp(join(tmpdir(),'usage-rule-refresh-'));vi.stubEnv('CODEX_HOME',home);vi.useFakeTimers();vi.setSystemTime(new Date('2026-01-02T12:00:00Z'));
 const entry=(type:string,payload:unknown,timestamp?:string)=>JSON.stringify({type,payload,...timestamp?{timestamp}:{}})+'\n';
 const tokens={input_tokens:100,cached_input_tokens:0,output_tokens:10,reasoning_output_tokens:0,total_tokens:110};
 const path=join(home,'sessions','rollout-fixture.jsonl');
 try{
  await mkdir(join(home,'sessions'));const body=entry('session_meta',{cwd:'/project'})+entry('turn_context',{model:'gpt-6.1-sol'})+entry('event_msg',{type:'thread_settings_applied',thread_settings:{service_tier:'priority'}})+entry('event_msg',{type:'token_count',info:{total_token_usage:tokens,last_token_usage:tokens}},'2026-01-02T11:59:00Z');await writeFile(path,body);
  vi.mocked(localCommandInput).mockImplementation((script,input)=>new Promise((resolve,reject)=>{const child=execFile('python3',['-c',script],{maxBuffer:1024*1024},(error,out)=>error?reject(error):resolve(out));child.stdin!.end(input);}));
  await collectAccountUsage('native');const db=getDb();db.prepare('UPDATE codex_usage_events SET tier=NULL').run();db.prepare('UPDATE codex_usage_dedup_events SET tier=NULL').run();db.prepare('DELETE FROM codex_usage_rule_versions').run();
  const before=cachedAccountUsage('native');expect(before.partial).toBe(true);const old=before.rows[0].estimated_credits!;
  await appendFile(path,'{broken}\n');
  await refreshUsageRules('native');const updated=cachedAccountUsage('native');expect(updated.rows[0].estimated_credits).toBeCloseTo(old*2.5);expect(updated.rows[0].tokens.total_tokens).toBe(110);expect(updated.partial).toBe(true);expect(updated.error).toContain('部分记录不可读取');expect(db.prepare('SELECT version,state FROM codex_usage_rule_versions').get()).toEqual({version:USAGE_RULE_VERSION,state:'ready_partial'});await writeFile(path,body);await utimes(path,new Date('2026-01-02T12:00:00Z'),new Date('2026-01-02T12:00:00Z'));await collectAccountUsage('native');expect(db.prepare('SELECT partial FROM codex_usage_status').get()).toEqual({partial:0});expect(cachedAccountUsage('native').partial).toBe(true);
  db.prepare('DELETE FROM codex_usage_rule_versions').run();db.prepare("UPDATE codex_usage_dedup_events SET tokens=json_set(tokens,'$.input_tokens',101)").run();await refreshUsageRules('native');expect(cachedAccountUsage('native').error).toContain('归属或 Token 与缓存不一致');expect(cachedAccountUsage('native').rows[0].tokens.total_tokens).toBe(110);
  db.prepare("UPDATE codex_usage_dedup_events SET tokens=json_set(tokens,'$.input_tokens',100)").run();db.prepare('DELETE FROM codex_usage_rule_versions').run();await rm(path);await refreshUsageRules('native');const retained=cachedAccountUsage('native');expect(retained.rows[0].tokens.total_tokens).toBe(110);expect(retained.rows[0].estimated_credits).toBeCloseTo(old*2.5);expect(retained.partial).toBe(true);expect(retained.error).toContain('部分历史请求无法从原始文件中找到');
 }finally{await rm(home,{recursive:true,force:true});}
});
it('returns hourly usage beyond the old 200000-event limit without truncation',()=>{
 const db=getDb();db.prepare('INSERT OR REPLACE INTO codex_usage_snapshots VALUES(?,1)').run('native');
 db.prepare('INSERT OR REPLACE INTO codex_usage_status VALUES(?,?,?,?)').run('native','2026-01-01T03:00:00Z',null,0);
 db.prepare('INSERT OR REPLACE INTO codex_usage_dedup_status(account,ready,hour_backfilled) VALUES(?,1,1)').run('native');
 const payload=JSON.stringify({...tokens,_timezone:'UTC'});
 db.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<200001)
 INSERT INTO codex_usage_dedup_events(account,event_key,day,cwd,model,tier,provider,tokens,hour)
 SELECT 'native',printf('%064x',n),'2026-01-01','/project',NULL,NULL,NULL,?,'2026-01-01T01:00:00+00:00' FROM seq`).run(payload);
 const result=cachedGroupUsage(['native'],'hour',true);expect(result.rows).toHaveLength(1);expect(result.rows[0].requests).toBe(200001);expect(result.rows[0].tokens.total_tokens).toBe(2000010);
},60000);
it('groups model usage across speeds while retaining unknown models and exact totals',async()=>{
 const token=(input:number,cached:number)=>({input_tokens:input,cached_input_tokens:cached,output_tokens:0,reasoning_output_tokens:0,total_tokens:input});
 respond([{...row,model:'gpt-6.1-sol',tier:'default',tokens:token(100,50)},{...row,model:'gpt-6.1-sol',tier:'fast',tokens:token(900,900)},{...row,model:'gpt-6.1-terra',tokens:token(100,0)},{...row,tokens:token(0,0)}]);
 await collectAccountUsage('native');
 const r=cachedAccountUsage('native').rows[0];expect(r.tokens.input_tokens).toBe(1100);expect(r.tokens.cached_input_tokens).toBe(950);expect(r.models).toHaveLength(3);
 const sol=r.models.find(m=>m.model==='gpt-6.1-sol')!;expect(sol.tokens.input_tokens).toBe(1000);expect(sol.estimated_credits).toBeCloseTo(0.00825);expect(r.models.find(m=>m.model===null)?.estimated_credits).toBeNull();
 expect(r.models.reduce((n,m)=>n+(m.tokens.total_tokens??0),0)).toBe(r.tokens.total_tokens);
});
it('performs one full scan, then adds only new request identities and preserves absent sessions and historical days',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-01-02T12:00:00Z'));
 respond([row,{...row,day:'2026-01-02'}]);await collectAccountUsage('native');
 expect(JSON.parse(vi.mocked(localCommandInput).mock.calls[0][1])).toMatchObject({mode:'full',day:'2026-01-02'});
 respond([{...row,day:'2026-01-02',tokens:{...tokens,total_tokens:20}}]);await collectAccountUsage('native');initAccountUsage();await collectAccountUsage('native');
 expect(vi.mocked(localCommandInput)).toHaveBeenCalledTimes(3);const input=JSON.parse(vi.mocked(localCommandInput).mock.calls[2][1]);expect(input.mode).toBe('daily');expect(input).not.toHaveProperty('cursors');
 expect(cachedAccountUsage('native').rows.map(r=>[r.date,r.tokens.total_tokens])).toEqual([['2026-01-02',30],['2026-01-01',10]]);
 respond([]);await collectAccountUsage('native');expect(cachedAccountUsage('native').rows.map(r=>r.date)).toEqual(['2026-01-02','2026-01-01']);expect(cachedAccountUsage('native').rows[0].tokens.total_tokens).toBe(30);
});
it('retains multiple sessions in the same project/model while another session grows, and survives service restarts',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-01-02T12:00:00Z'));const a={...row,day:'2026-01-02',tokens:{...tokens,total_tokens:100}},b={...row,day:'2026-01-02',tokens:{...tokens,total_tokens:200}};
 // Each fixture row represents a distinct native request even when it shares a group.
 respond([a,b]);await collectAccountUsage('native');expect(cachedAccountUsage('native').rows[0].tokens.total_tokens).toBe(300);
 initAccountUsage();respond([b,{...b,tokens:{...tokens,total_tokens:50}}]);await Promise.all([collectAccountUsage('native'),collectAccountUsage('native')]);expect(cachedAccountUsage('native').rows[0].tokens.total_tokens).toBe(350);
 await collectAccountUsage('native');expect(cachedAccountUsage('native').rows[0].tokens.total_tokens).toBe(350);
 vi.setSystemTime(new Date('2026-01-03T12:00:00Z'));respond([]);await collectAccountUsage('native');expect(cachedAccountUsage('native').rows[0].tokens.total_tokens).toBe(350);
});
it('closes the previous UTC day once after midnight, then returns to today-only collection',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-01-01T23:58:00Z'));respond([row]);await collectAccountUsage('native');
 vi.setSystemTime(new Date('2026-01-02T00:03:00Z'));respond([{...row,tokens:{...tokens,total_tokens:5}},{...row,day:'2026-01-02',tokens:{...tokens,total_tokens:20}}]);await collectAccountUsage('native');
 expect(JSON.parse(vi.mocked(localCommandInput).mock.calls.at(-1)![1]).days).toEqual(['2026-01-01','2026-01-02']);expect(cachedAccountUsage('native').rows.map(r=>[r.date,r.tokens.total_tokens])).toEqual([['2026-01-02',20],['2026-01-01',15]]);
 respond([]);await collectAccountUsage('native');expect(JSON.parse(vi.mocked(localCommandInput).mock.calls.at(-1)![1]).days).toEqual(['2026-01-02']);expect(cachedAccountUsage('native').rows[1].tokens.total_tokens).toBe(15);
});
it('commits identities and aggregates atomically and rejects missing or duplicated identity packets',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
 await collectAccountUsage('native');const before=cachedAccountUsage('native').rows;const amount=(getDb().prepare('SELECT COUNT(*) n FROM codex_usage_event_ids').get() as {n:number}).n;
 respond([row],{event_keys:null});await collectAccountUsage('native');expect(cachedAccountUsage('native').rows).toEqual(before);
 const duplicate=Buffer.alloc(32,1);respond([{...row,requests:2}],{event_keys:{[row.day]:Buffer.concat([duplicate,duplicate]).toString('base64')}});await collectAccountUsage('native');expect(cachedAccountUsage('native').rows).toEqual(before);expect((getDb().prepare('SELECT COUNT(*) n FROM codex_usage_event_ids').get() as {n:number}).n).toBe(amount);
});
it('retains actual JSONL requests after deletion, archive/copy, compaction and New Conversation without replaying old counters',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-01-02T14:00:00Z'));const home=await mkdtemp(join(tmpdir(),'usage-retention-'));
 const record=(stamp:string,total:number,last:number)=>JSON.stringify({type:'event_msg',timestamp:stamp,payload:{type:'token_count',info:{total_token_usage:{total_tokens:total},last_token_usage:{...tokens,total_tokens:last,input_tokens:last}}}})+'\n';
 const header=(id:string,turn:string)=>JSON.stringify({type:'session_meta',payload:{id,cwd:'/project'}})+'\n'+JSON.stringify({type:'turn_context',payload:{turn_id:turn,model:'gpt-6.1-sol'}})+'\n';
 const a=join(home,'sessions','a.jsonl'),b=join(home,'sessions','b.jsonl'),fresh=join(home,'sessions','fresh.jsonl');
 const today=new Date('2026-01-02T15:00:00Z');
 try{
  await mkdir(join(home,'sessions'));await mkdir(join(home,'archived_sessions'));await writeFile(a,header('a','turn-a')+record('2026-01-02T12:00:00Z',100,100));await writeFile(b,header('b','turn-b')+record('2026-01-02T12:00:00Z',200,200));
  vi.mocked(localCommandInput).mockImplementation((script,input)=>new Promise((resolve,reject)=>{const child=execFile('python3',['-c',script],{maxBuffer:1024*1024},(error,out)=>error?reject(error):resolve(out));child.stdin!.end(JSON.stringify({...JSON.parse(input),home}));}));
  await collectAccountUsage('native');expect(cachedAccountUsage('native').rows[0].tokens.total_tokens).toBe(300);
  await rm(a);await appendFile(b,record('2026-01-02T13:00:00Z',250,50));await utimes(b,today,today);await collectAccountUsage('native');expect(cachedAccountUsage('native').rows[0].tokens.total_tokens).toBe(350);
  await copyFile(b,join(home,'archived_sessions','copy.jsonl'));await utimes(join(home,'archived_sessions','copy.jsonl'),today,today);
  await appendFile(b,JSON.stringify({type:'compacted',payload:{replacement_history:[{type:'message',role:'user',content:[]}]}})+'\n'+record('2026-01-02T13:30:00Z',275,25));await utimes(b,today,today);
  // New uses a fresh native turn: identical clocks/counters still represent an independent request.
  await writeFile(fresh,header('fresh','fresh-turn')+record('2026-01-02T13:30:00Z',25,25));await utimes(fresh,today,today);initAccountUsage();await collectAccountUsage('native');expect(cachedAccountUsage('native').rows[0].tokens.total_tokens).toBe(400);
  // A compacted/rebuilt file can replay the latest snapshot with a fresh record timestamp.
  await writeFile(b,header('b','turn-b')+record('2026-01-02T13:31:00Z',275,25));await utimes(b,today,today);await collectAccountUsage('native');expect(cachedAccountUsage('native').rows[0].tokens.total_tokens).toBe(400);
 }finally{await rm(home,{recursive:true,force:true});}
});
it('preserves legacy aggregate baselines and keeps their timestamp boundary fixed after migration',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-01-02T12:00:00Z'));respond([{...row,day:'2026-01-02'}]);await collectAccountUsage('native');
 getDb().exec('DELETE FROM codex_usage_ledger; DELETE FROM codex_usage_event_ids;');vi.setSystemTime(new Date('2026-01-02T13:00:00Z'));respond([]);await collectAccountUsage('native');expect(JSON.parse(vi.mocked(localCommandInput).mock.calls.at(-1)![1]).baseline_at).toBe('2026-01-02T12:00:00.000Z');expect(cachedAccountUsage('native').rows[0].tokens.total_tokens).toBe(10);
 vi.setSystemTime(new Date('2026-01-02T14:00:00Z'));await collectAccountUsage('native');expect(JSON.parse(vi.mocked(localCommandInput).mock.calls.at(-1)![1]).baseline_at).toBe('2026-01-02T12:00:00.000Z');
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
it('keeps known Credits and request coverage when a later request has missing Token fields',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));const complete={...row,model:'gpt-6.1-sol',tokens:{input_tokens:100,cached_input_tokens:50,output_tokens:10,reasoning_output_tokens:0,total_tokens:110}};respond([complete]);await collectAccountUsage('native');const credits=cachedAccountUsage('native').rows[0].estimated_credits;
 respond([{...complete,tokens:{...complete.tokens,input_tokens:null,total_tokens:20}}]);await collectAccountUsage('native');const result=cachedAccountUsage('native').rows[0];expect(result.tokens.total_tokens).toBe(130);expect(result.estimated_credits).toBe(credits);expect(result.credit_coverage).toEqual({covered:1,total:2});expect(result.models[0].estimated_credits).toBe(credits);
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
it('preserves provider consumption when unrelated Engines are added and upgrades the old source signature without clearing history',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));const provider=(id:string)=>({id,name:id,kind:'responses',enabled:true,fields:{codexHome:'/tmp/usage-isolated-'+id,models:['m'],baseUrl:'https://example.invalid/v1'}});
 updateAgentManagement('codex',()=>({defaults:{},providers:[provider('a')]}));await collectAccountUsage('provider:a');
 getDb().prepare('UPDATE codex_usage_sources SET identity=? WHERE account=?').run(JSON.stringify(['provider','/tmp/usage-isolated-a',[['provider:a','/tmp/usage-isolated-a',null]]]),'provider:a');
 updateAgentManagement('codex',()=>({defaults:{},providers:[provider('a'),provider('b')]}));respond([]);await collectAccountUsage('provider:a');expect(JSON.parse(vi.mocked(localCommandInput).mock.calls.at(-1)![1]).mode).toBe('daily');expect(cachedAccountUsage('provider:a').rows[0].tokens.total_tokens).toBe(10);
});
it('merges distinct provider histories while counting a copied session event only once',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
 const provider=(id:string)=>({id,name:id,kind:'responses',enabled:true,fields:{codexHome:'/tmp/group-fixture-'+id,models:['m'],baseUrl:'https://example.invalid/v1'}});
 vi.spyOn(engineBalance,'cachedEngineBalance').mockReturnValue({auth_mode:'api',status:'available',groupKey:'same',providerId:'same'});
 updateAgentManagement('codex',()=>({defaults:{},providers:[provider('a'),provider('b')]}));
 const event={key:'a'.repeat(64),day:'2026-01-01',cwd:'/project',model:null,tier:null,provider:'same',tokens};
 respond([row],{events:[event]});await collectAccountUsage('provider:a');
 respond([row],{events:[event,{...event,key:'b'.repeat(64)},{...event,key:'c'.repeat(64),provider:'another-upstream'}]});await collectAccountUsage('provider:b');
 expect(cachedGroupUsage(['provider:a','provider:b'])).toMatchObject({partial:false,rows:[{date:'2026-01-01',cwd:'/project',requests:2,tokens:{total_tokens:20}}]});
 const conflict={...event,tokens:{...tokens,total_tokens:15}};respond([row],{events:[conflict,{...event,key:'b'.repeat(64)}]});await collectAccountUsage('provider:b');
 expect(cachedGroupUsage(['provider:a','provider:b'])).toMatchObject({partial:true,rows:[{requests:1,tokens:{total_tokens:10}}]});
});
it('retains upstream group consumption when sessions disappear and bridges legacy fingerprint aliases safely',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
 const provider=(id:string)=>({id,name:id,kind:'responses',enabled:true,fields:{codexHome:'/tmp/group-retain-'+id,models:['m'],baseUrl:'https://example.invalid/v1'}});
 vi.spyOn(engineBalance,'cachedEngineBalance').mockReturnValue({auth_mode:'api',status:'available',groupKey:'same',providerId:'same'});updateAgentManagement('codex',()=>({defaults:{},providers:[provider('a'),provider('b')]}));
 const event={key:'a'.repeat(64),day:'2026-01-01',cwd:'/project',model:null,tier:null,provider:'same',tokens};respond([row],{events:[event]});await collectAccountUsage('provider:a');
 respond([row],{events:[{...event,key:'b'.repeat(64),legacy_key:event.key}]});await collectAccountUsage('provider:b');expect(cachedGroupUsage(['provider:a','provider:b']).rows[0].tokens.total_tokens).toBe(10);
 respond([]);await collectAccountUsage('provider:a');await collectAccountUsage('provider:b');expect(cachedGroupUsage(['provider:a','provider:b']).rows[0].tokens.total_tokens).toBe(10);
 respond([],{events:[{...event,key:'c'.repeat(64),legacy_key:event.key}]});await collectAccountUsage('provider:b');expect(cachedGroupUsage(['provider:a','provider:b'])).toMatchObject({partial:true,rows:[{requests:2,tokens:{total_tokens:20}}]});
});
it('catches up readable historical days after a multi-day shutdown without duplicate counts',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));respond([row]);await collectAccountUsage('native');
 vi.setSystemTime(new Date('2026-01-04T12:00:00Z'));respond([row,{...row,day:'2026-01-02'},{...row,day:'2026-01-03'}]);await collectAccountUsage('native');
 expect(JSON.parse(vi.mocked(localCommandInput).mock.calls.at(-1)![1]).mode).toBe('full');expect(cachedAccountUsage('native').rows.map(r=>r.tokens.total_tokens)).toEqual([10,10,10]);
 await collectAccountUsage('native');expect(cachedAccountUsage('native').rows.map(r=>r.tokens.total_tokens)).toEqual([10,10,10]);
});
