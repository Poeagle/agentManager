import * as stream from '../src/services/agents/codex/stream.js';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {createTestDatabase} from './helpers/database.js';
import {closeDb,getDb,initDb} from '../src/db/index.js';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,appendFile,utimes,rm,copyFile,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initAccountUsage,collectAccountUsage,cachedAccountUsage,cachedGroupUsage,backfillUsageHours,startAccountUsage,stopAccountUsage,refreshUsageRules,USAGE_RULE_VERSION} from '../src/services/agents/codex/account-usage.js';
import {accountCommandInput,localCommandInput} from '../src/services/agents/codex/account-transport.js';
vi.mock('../src/services/agents/codex/account-transport.js',async original=>({...await original<typeof import('../src/services/agents/codex/account-transport.js')>(),accountCommandInput:vi.fn(),localCommandInput:vi.fn()}));
import {updateAgentManagement} from '../src/services/agents/management-store.js';
import * as engineBalance from '../src/services/agents/codex/engine-balance.js';
import {initModelPricing,pricingSources,refreshModelPricing} from '../src/services/agents/model-pricing.js';
import {exportUsageCsv,usageCsvPending} from '../src/services/agents/codex/usage-csv-export.js';
import {readUsageCsv,usageCsvDirectory} from '../src/services/agents/codex/usage-csv.js';
import {resolveTargetUsage} from '../src/services/agents/codex/usage-target.js';
import {USAGE_SCAN} from '../src/services/agents/codex/usage-scanner.js';
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
beforeEach(()=>{vi.stubEnv('TZ','UTC');fixture=createTestDatabase();initModelPricing();initAccountUsage();respond();vi.mocked(accountCommandInput).mockImplementation(async(_c,_s,input)=>response(input,[row]));});
afterEach(async()=>{await stopAccountUsage();fixture.cleanup();vi.restoreAllMocks();vi.resetAllMocks();vi.useRealTimers();vi.unstubAllEnvs();});

function runUsageScanner(script: string, input: string): Promise<string> {
 return new Promise((resolve, reject) => {
  const child = execFile('python3', ['-c', script], { maxBuffer: 1024 * 1024 }, (error, output) => error ? reject(error) : resolve(output));
  child.stdin!.end(input);
 });
}

it('matches full-scan deduplication for old aliases, repeated copies, native receipts and unknown tokens', async () => {
 const nativeId = '019ff001-0000-7000-8000-000000000001';
 const home = join(fixture.dir, 'parity-home');
 const path = join(home, 'sessions', `rollout-${nativeId}.jsonl`);
 await mkdir(join(home, 'sessions'), { recursive: true });
 const line = (type: string, payload: object, timestamp = '2026-01-02T00:30:00Z') => JSON.stringify({ type, payload, timestamp }) + '\n';
 const meta = line('session_meta', { id: nativeId, cwd: '/v', model: 'gpt-6.1-sol' });
 const context = line('turn_context', { turn_id: 'legacy-turn' });
 const details: Record<string, number | null> = { input_tokens: 10, cached_input_tokens: 3, output_tokens: 5, reasoning_output_tokens: null, total_tokens: 15 };
 const echo = line('event_msg', { type: 'token_count', info: { total_token_usage: details, last_token_usage: details } });
 const request = (id: string, tier: string, usage = details) => line('token_usage_record', { response_id: id, service_tier: tier, usage });
 const options = { home, mode: 'full', day: '2026-01-02', timezone: 'Asia/Taipei', native_id: nativeId, includeEvents: true, baseline_at: '2026-01-01T00:00:00Z' };
 const scan = async (extra: object) => JSON.parse(await runUsageScanner(USAGE_SCAN, JSON.stringify({ ...options, ...extra })));
 await writeFile(path, meta + context + echo);
 const initial = await scan({});
 const legacyKey = Buffer.from(initial.event_keys['2026-01-02'], 'base64');
 getDb().prepare('INSERT INTO codex_usage_event_ids(account,event_id,day,timezone) VALUES(?,?,?,?)').run('native', legacyKey, '2026-01-02', options.timezone);
 const content = meta + context + request('previously-credited', 'default') + echo + request('new-standard', 'default')
  + request('new-fast', 'priority', { ...details, cached_input_tokens: null }) + request('new-fast', 'priority');
 await writeFile(path, content);
 await mkdir(join(home, 'archived_sessions'), { recursive: true });
 await writeFile(join(home, 'archived_sessions', `rollout-${nativeId}.jsonl`), content);
 const baseline = await scan({ known_events: legacyKey.toString('base64') });
 const bounded = await scan({ target_candidates: true });
 expect(bounded.progress.files_selected).toBe(2);
 expect(bounded.errors).toBe(baseline.errors);
 const optimized = resolveTargetUsage(getDb(), 'native', bounded.candidates);
 expect(optimized).toEqual({ rows: baseline.rows, events: baseline.events, event_keys: baseline.event_keys });
 expect(optimized?.rows).toMatchObject([{ tier: 'default', requests: 1 }, { tier: 'priority', requests: 1, tokens: { cached_input_tokens: null } }]);
});

it('preserves late historical usage across an export failure and restart', async () => {
 vi.useFakeTimers();
 vi.setSystemTime(new Date('2026-01-05T12:00:00Z'));
 const nativeId = '019ff001-0000-7000-8000-000000000002';
 const home = join(fixture.dir, 'late-home');
 const path = join(home, 'sessions', `rollout-${nativeId}.jsonl`);
 vi.stubEnv('CODEX_HOME', home);
 await mkdir(join(home, 'sessions'), { recursive: true });
 const receipt = (id: string, timestamp: string, n: number) => JSON.stringify({ type: 'token_usage_record', timestamp,
  payload: { response_id: id, usage: { input_tokens: n, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: n } } }) + '\n';
 await writeFile(path, JSON.stringify({type:'session_meta',payload:{id:nativeId,cwd:'/late',model:'gpt-6.1-sol'}})+'\n'
  +receipt('old','2026-01-01T12:05:00Z',15)+receipt('today','2026-01-05T12:01:00Z',20));
 vi.mocked(localCommandInput).mockImplementation(runUsageScanner);
 await collectAccountUsage('native');
 const originalCsv = readUsageCsv('native');
 expect(usageCsvPending('native')).toBeUndefined();
 await collectAccountUsage('native', { nativeId });
 expect(JSON.parse(vi.mocked(localCommandInput).mock.calls.at(-1)![1])).toMatchObject({ target_candidates: true });
 expect(JSON.parse(vi.mocked(localCommandInput).mock.calls.at(-1)![1])).not.toHaveProperty('known_events');
 expect(usageCsvPending('native')).toBeUndefined();
 await appendFile(path, receipt('late', '2026-01-01T18:05:00Z', 30));
 await collectAccountUsage('native', { nativeId });
 expect(usageCsvPending('native')).toMatchObject({ from_day: '2026-01-01' });
 expect(readUsageCsv('native')).toEqual(originalCsv);
 const daily = cachedAccountUsage('native').rows;
 const hourly = cachedGroupUsage(['native'], 'hour', true).rows;
 expect(daily.map(row => [row.date, row.tokens.total_tokens])).toEqual([['2026-01-05', 20], ['2026-01-01', 45]]);
 expect(hourly.map(row => row.tokens.total_tokens)).toEqual([20, 30, 15]);
 const root = usageCsvDirectory('native');
 const { rename } = await import('node:fs/promises');
 await rename(root, `${root}.saved`);
 await writeFile(root, 'unavailable destination');
 try {
  expect(() => exportUsageCsv('native')).toThrow();
  expect(usageCsvPending('native')).toMatchObject({ from_day: '2026-01-01' });
 } finally {
  await rm(root);
  await rename(`${root}.saved`, root);
 }
 await rm(path);
 closeDb();
 initDb();
 initAccountUsage();
 expect(usageCsvPending('native')).toMatchObject({ from_day: '2026-01-01' });
 expect(cachedAccountUsage('native').rows).toEqual(daily);
 await collectAccountUsage('native');
 expect(usageCsvPending('native')).toBeUndefined();
 expect(cachedAccountUsage('native').rows).toEqual(daily);
 expect(cachedGroupUsage(['native'], 'hour', true).rows).toEqual(hourly);
});

it('captures the final Codex request before platform history deletion and retains account consumption',async()=>{
 const native='019ff001-5555-7555-8555-555555555554';
 const root=join(fixture.dir,'codex-home'),directory=join(root,'sessions'),path=join(directory,`rollout-${native}.jsonl`);
 vi.stubEnv('CODEX_HOME',root);
 await mkdir(directory,{recursive:true});
 const line=(type:string,payload:object,timestamp='2026-11-20T00:00:00Z')=>JSON.stringify({type,payload,timestamp})+'\n';
 const usage=(id:string,input:number)=>line('token_usage_record',{turn_id:'turn',response_id:id,
   usage:{input_tokens:input,cached_input_tokens:0,output_tokens:5,reasoning_output_tokens:0,total_tokens:input+5}});
 await writeFile(path,line('session_meta',{id:native,cwd:fixture.dir})+line('event_msg',{type:'task_started',turn_id:'turn'})+usage('first',1024));
 vi.mocked(localCommandInput).mockImplementation((script,input)=>new Promise((resolve,reject)=>{
   const child=execFile('python3',['-c',script],{maxBuffer:1024*1024},(error,out)=>error?reject(error):resolve(out));
   child.stdin!.end(input);
 }));
 await collectAccountUsage('native');
 expect(cachedAccountUsage('native').rows[0].tokens.total_tokens).toBe(1029);
 await appendFile(path,usage('last',2048)+line('event_msg',{type:'task_complete',turn_id:'turn'}));
 const {purgeSessionRecord}=await import('../src/services/session-manager.js');
 getDb().prepare("INSERT INTO sessions(id,task,status,cli_type,codex_session_id) VALUES ('purge-fixture','Test','cancelled','codex',?)").run(native);
 vi.stubEnv('TZ','Asia/Taipei');
 await expect(purgeSessionRecord('purge-fixture')).resolves.toEqual({ok:true});
 await expect(access(path)).rejects.toMatchObject({code:'ENOENT'});
 expect(cachedAccountUsage('native')).toMatchObject({
   timezone:'UTC',timezone_pending:'Asia/Taipei',unassigned:null,rows:[{tokens:{total_tokens:3082}}],
 });
 vi.stubEnv('TZ','UTC');
 await collectAccountUsage('native');
 expect(cachedAccountUsage('native').rows[0]).toMatchObject({credit_coverage:{total:2},tokens:{total_tokens:3082}});
});
it('keeps existing account usage when a targeted flush sees a different history source',async()=>{
 vi.stubEnv('CODEX_HOME',join(fixture.dir,'original'));
 await collectAccountUsage('native');
 const original=cachedAccountUsage('native').rows;
 expect(original[0].tokens.total_tokens).toBe(10);
 vi.stubEnv('CODEX_HOME',join(fixture.dir,'replacement'));
 await expect(collectAccountUsage('native',{nativeId:'target'})).rejects.toThrow('账号历史来源已变化');
 vi.stubEnv('CODEX_HOME',join(fixture.dir,'original'));
 expect(cachedAccountUsage('native').rows).toEqual(original);
});

it('uses the original deduplication scan when the target response exceeds its bound', async () => {
 vi.stubEnv('CODEX_HOME', join(fixture.dir, 'fallback-home'));
 await collectAccountUsage('native');
 const known = getDb().prepare('SELECT event_id FROM codex_usage_event_ids WHERE account=?').get('native') as { event_id: Buffer };
 const scanner = vi.mocked(localCommandInput);
 scanner.mockClear();
 scanner.mockImplementationOnce(async () => JSON.stringify({ candidates_truncated: true }));
 await collectAccountUsage('native', { nativeId: '019ff001-0000-7000-8000-000000000003' });
 expect(scanner).toHaveBeenCalledTimes(2);
 expect(JSON.parse(scanner.mock.calls[0][1])).toMatchObject({ target_candidates: true });
 expect(JSON.parse(scanner.mock.calls[1][1])).toMatchObject({ known_events: known.event_id.toString('base64') });
 expect(cachedAccountUsage('native').rows[0].tokens.total_tokens).toBe(10);
 expect(usageCsvPending('native')).toBeUndefined();
});

it('reprocesses old Fast metadata on a rule upgrade and preserves data if history is missing',async()=>{
 const home=await mkdtemp(join(tmpdir(),'usage-rule-refresh-'));vi.stubEnv('CODEX_HOME',home);vi.useFakeTimers();vi.setSystemTime(new Date('2026-01-02T12:00:00Z'));
 const entry=(type:string,payload:unknown,timestamp?:string)=>JSON.stringify({type,payload,...timestamp?{timestamp}:{}})+'\n';
 const tokens={input_tokens:100,cached_input_tokens:0,output_tokens:10,reasoning_output_tokens:0,total_tokens:110};
 const path=join(home,'sessions','rollout-fixture.jsonl');
 try{
  await mkdir(join(home,'sessions'));const body=entry('session_meta',{cwd:'/project'})+entry('turn_context',{model:'gpt-6.1-sol'})+entry('event_msg',{type:'thread_settings_applied',thread_settings:{service_tier:'priority'}})+entry('event_msg',{type:'token_count',info:{total_token_usage:tokens,last_token_usage:tokens}},'2026-01-02T11:59:00Z');await writeFile(path,body);
  vi.mocked(localCommandInput).mockImplementation((script,input)=>new Promise((resolve,reject)=>{const child=execFile('python3',['-c',script],{maxBuffer:1024*1024},(error,out)=>error?reject(error):resolve(out));child.stdin!.end(input);}));
  await collectAccountUsage('native');const db=getDb();db.prepare('UPDATE codex_usage_events SET tier=NULL').run();db.prepare('UPDATE codex_usage_dedup_events SET tier=NULL').run();db.prepare('DELETE FROM codex_usage_rule_versions').run();
  const {exportUsageCsv}=await import('../src/services/agents/codex/usage-csv-export.js');exportUsageCsv('native',{rebuild:true});
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
 const sol=r.models.find(m=>m.model==='gpt-6.1-sol')!;expect(sol.tokens.input_tokens).toBe(1000);expect(sol.estimated_credits).toBeCloseTo(0.00825);expect(sol.estimated_usd).toBeCloseTo(0.00033);expect(r.models.find(m=>m.model===null)?.estimated_credits).toBeNull();expect(r.models.find(m=>m.model===null)?.estimated_usd).toBeNull();
 expect(r.models.reduce((n,m)=>n+(m.tokens.total_tokens??0),0)).toBe(r.tokens.total_tokens);
});
it('keeps Credits estimates when an official API tariff is unavailable',async()=>{
 const counters={input_tokens:1000000,cached_input_tokens:900000,output_tokens:1000,reasoning_output_tokens:100,total_tokens:1001000};
 respond([{...row,model:'gpt-6.2-sol',tier:'default',tokens:counters},{...row,model:'gpt-6.2-sol',tier:'priority',tokens:counters},{...row,model:'gpt-6.2-astra',tier:'ultrafast',tokens:counters}]);
 await collectAccountUsage('native');vi.mocked(localCommandInput).mockClear();
 for(let i=0;i<2;i++){
  const result=cachedAccountUsage('native');expect(result.credit_rate_date).toBe('2026-11-22');
  expect(result.rows[0]).toMatchObject({estimated_credits:202.5,credit_coverage:{covered:3,total:3},tokens:{total_tokens:3003000}});
  expect(result.rows[0].estimated_usd).toBeNull();
  expect(result.rows[0].models.find(m=>m.model==='gpt-6.2-sol')?.estimated_credits).toBe(22.5);
  expect(result.rows[0].models.find(m=>m.model==='gpt-6.2-sol')?.estimated_usd).toBeNull();
  expect(result.rows[0].models.find(m=>m.model==='gpt-6.2-astra')?.estimated_usd).toBeNull();
  expect(result.rows[0].models.find(m=>m.model==='gpt-6.2-astra')?.estimated_credits).toBe(180);
 }
 expect(localCommandInput).not.toHaveBeenCalled();
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
 vi.useFakeTimers();respond([]);const quotaRequest=vi.fn(async(method:string)=>method==='account/read'?{account:{type:'chatgpt',email:'fixture@example.invalid'}}:{rateLimits:{secondary:{usedPercent:30,windowDurationMins:10080,resetsAt:Date.now()/1000+604800}}});vi.spyOn(stream,'withCodexConnection').mockImplementation(async callback=>callback(quotaRequest));startAccountUsage();startAccountUsage();await vi.advanceTimersByTimeAsync(1000);expect(localCommandInput).toHaveBeenCalledTimes(1);expect(quotaRequest.mock.calls.filter(([method])=>method==='account/rateLimits/read')).toHaveLength(1);
 await vi.advanceTimersByTimeAsync(299999);expect(localCommandInput).toHaveBeenCalledTimes(1);
 await vi.advanceTimersByTimeAsync(1);expect(localCommandInput).toHaveBeenCalledTimes(2);expect(JSON.parse(vi.mocked(localCommandInput).mock.calls[1][1]).mode).toBe('daily');expect(quotaRequest.mock.calls.filter(([method])=>method==='account/rateLimits/read')).toHaveLength(2);
 const {readUsageCsv}=await import('../src/services/agents/codex/usage-csv.js');expect(readUsageCsv('native')?.quota).toHaveLength(2);
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
it('estimates official DeepSeek usage per request before grouping and skips unknown usage',async()=>{
 vi.useFakeTimers();vi.stubEnv('TZ','Asia/Shanghai');vi.setSystemTime(new Date('2026-11-19T12:00:00Z'));
 const origin='https://api.deepseek.com',groupKey=createHash('sha256').update(origin).digest('hex');
 const provider=(id:string)=>({id,name:id,kind:'responses',enabled:true,fields:{codexHome:'/tmp/deepseek-cost-'+id,models:['deepseek-flash'],baseUrl:id==='proxy'?'https://example.invalid':origin}});
 updateAgentManagement('codex',()=>({defaults:{},providers:['a','b','proxy'].map(provider)}));
 vi.spyOn(engineBalance,'cachedEngineBalance').mockImplementation(id=>({auth_mode:'api',status:'available',groupKey:id==='provider:proxy'?'proxy':groupKey,origin:id==='provider:proxy'?'https://example.invalid':origin,providerId:'ds'}));
 const usage={input_tokens:1000000,cached_input_tokens:500000,output_tokens:100000,total_tokens:1100000,reasoning_output_tokens:50000};
 const event=(key:string,at:string|null,model='deepseek-flash')=>({key:key.repeat(64),day:'2026-11-19',at,cwd:'/project',model,tier:null,provider:'ds',tokens:usage});
 const peak=event('a','2026-11-19T01:00:00Z'),offPeak=event('b','2026-11-19T04:00:00Z');
 respond([],{events:[peak,offPeak,event('c',null),event('d','2026-11-19T01:00:00Z','deepseek-v4-pro')]});
 await collectAccountUsage('provider:a');
 respond([],{events:[peak]});await collectAccountUsage('provider:b');
 respond([],{events:[peak]});await collectAccountUsage('provider:proxy');
 const report=cachedGroupUsage(['provider:a','provider:b']);
 expect(report).toMatchObject({api_pricing:{currency:'CNY',today:{coverage:{covered:3,total:4},partial:true}},rows:[{requests:4,api_cost:{coverage:{covered:3,total:4}}}]});
 const flash=report.rows[0].models.find(model=>model.model==='deepseek-flash')!;
 expect(flash.api_cost).toMatchObject({amount:2.73,coverage:{covered:2,total:3},breakdown:{input:1.5,cache:0.03}});
 expect(flash.api_cost?.breakdown?.output).toBeCloseTo(1.2,10);
 expect(flash.api_cost?.breakdown?.reasoning).toBeCloseTo(0.6,10);
 expect(report.rows[0].api_cost?.amount).toBeCloseTo(10.08,10);
 expect(cachedGroupUsage(['provider:proxy'])).not.toHaveProperty('api_pricing');
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
 expect(JSON.parse(vi.mocked(localCommandInput).mock.calls.at(-1)![1])).toMatchObject({mode:'catchup',since_day:'2026-01-01'});expect(cachedAccountUsage('native').rows.map(r=>r.tokens.total_tokens)).toEqual([10,10,10]);
 await collectAccountUsage('native');expect(cachedAccountUsage('native').rows.map(r=>r.tokens.total_tokens)).toEqual([10,10,10]);
});

it('retains the recovery checkpoint across partial scans and resumes without counting recovered requests twice',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));respond([row]);await collectAccountUsage('native');
 vi.setSystemTime(new Date('2026-01-04T12:00:00Z'));respond([{...row,day:'2026-01-02'}],{partial:true,errors:1});await collectAccountUsage('native');
 expect(getDb().prepare('SELECT last_day FROM codex_usage_ledger').get()).toEqual({last_day:'2026-01-01'});
 respond([{...row,day:'2026-01-02'},{...row,day:'2026-01-03'}]);await collectAccountUsage('native');
 expect(JSON.parse(vi.mocked(localCommandInput).mock.calls.at(-1)![1])).toMatchObject({mode:'catchup',since_day:'2026-01-01'});
 expect(cachedAccountUsage('native').rows.map(r=>r.tokens.total_tokens)).toEqual([10,10,10]);
 expect(getDb().prepare('SELECT last_day FROM codex_usage_ledger').get()).toEqual({last_day:'2026-01-04'});
});

it('estimates Codex account USD from official per-request API context bands',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-22T23:00:00Z'));
 initModelPricing();
 const pricing=`### Standard pricing data
| gpt-6.2-sol | $2 | $10 | $0.10 | $2.50 | $5 | $4 | $15 | $0.20 |

Long context: >272K input tokens.`;
 await refreshModelPricing(async url=>String(url)===pricingSources.openai?new Response(pricing):new Response('',{status:404}));
 const requestTokens=[
  {input_tokens:200000,cached_input_tokens:190000,output_tokens:1000,reasoning_output_tokens:100,total_tokens:201000},
  {input_tokens:300000,cached_input_tokens:280000,output_tokens:2000,reasoning_output_tokens:500,total_tokens:302000},
 ];
 const events=requestTokens.map((tokens,index)=>({
  key:(index?'b':'a').repeat(64),day:'2026-11-22',hour:`2026-11-22T${index?'12':'11'}:00:00+00:00`,
  at:`2026-11-22T${index?'12':'11'}:30:00.000Z`,cwd:'/project',model:'gpt-6.2-sol',tier:'standard',provider:null,tokens,
 }));
 const combined={input_tokens:500000,cached_input_tokens:470000,output_tokens:3000,reasoning_output_tokens:600,total_tokens:503000};
 respond([{day:'2026-11-22',cwd:'/project/src',model:'gpt-6.2-sol',tier:'standard',requests:2,tokens:combined}],{events});
 await collectAccountUsage('native');
 const result=cachedAccountUsage('native').rows[0],model=result.models[0];
 expect(result.tokens).toMatchObject({input_tokens:500000,cached_input_tokens:470000,output_tokens:3000});
 expect(model.estimated_usd).toBeCloseTo(0.215,10);
 expect(model).toMatchObject({usd_coverage:{covered:2,total:2},usd_breakdown:{input:0.1,cache:0.075,output:0.04,reasoning:0.0085}});
});

it('prices mixed Standard and Fast Luna requests at their respective OpenAI context rates',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-24T12:00:00Z'));
 initModelPricing();
 const pricing=`### Standard pricing data
| gpt-6-luna | $0.10 | $0.50 | $0.01 | $0.125 | $0.25 | $0.20 | $0.75 | $0.02 |

### Fast pricing data
| gpt-6-luna | $0.20 | $1.00 | $0.02 | $0.25 | $0.50 | $0.40 | $1.50 | $0.04 |

Long context: >272K input tokens.`;
 await refreshModelPricing(async url=>String(url)===pricingSources.openai?new Response(pricing):new Response('',{status:404}));
 const short={input_tokens:200000,cached_input_tokens:190000,output_tokens:1000,reasoning_output_tokens:100,total_tokens:201000};
 const long={input_tokens:300000,cached_input_tokens:280000,output_tokens:2000,reasoning_output_tokens:500,total_tokens:302000};
 const requests=[{tier:'default',tokens:short},{tier:'fast',tokens:long},{tier:'priority',tokens:short}];
 const events=requests.map((request,index)=>({
  key:String(index+1).repeat(64),day:'2026-11-24',hour:'2026-11-24T11:00:00+00:00',
  at:`2026-11-24T11:0${index}:00.000Z`,cwd:'/project',model:'gpt-6-luna',provider:null,...request,
 }));
 respond(requests.map(request=>({day:'2026-11-24',cwd:'/project',model:'gpt-6-luna',requests:1,...request})),{events});
 await collectAccountUsage('native');
 const row=cachedAccountUsage('native').rows[0],model=row.models[0];
 expect(row.estimated_usd).toBeCloseTo(0.0324,10);
 expect(model.usd_coverage).toEqual({covered:3,total:3});
 expect(model.tokens).toMatchObject({input_tokens:700000,output_tokens:4000});
 for(const [field,value] of Object.entries({input:0.011,cache:0.0169,output:0.0045,reasoning:0.0009}))
  expect(model.usd_breakdown?.[field as keyof NonNullable<typeof model.usd_breakdown>]).toBeCloseTo(value,10);
});

it('keeps itemized Codex account costs aligned with short and long context requests',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-22T23:00:00Z'));
 initModelPricing();
 const pricing=`### Standard pricing data
| gpt-6.2-sol | $2 | $10 | $0.10 | $2.50 | $5 | $4 | $15 | $0.20 |

Long context: >272K input tokens.`;
 await refreshModelPricing(async url=>String(url)===pricingSources.openai?new Response(pricing):new Response('',{status:404}));
 const short={input_tokens:200000,cached_input_tokens:190000,output_tokens:1000,reasoning_output_tokens:100,total_tokens:201000};
 const long={input_tokens:300000,cached_input_tokens:280000,output_tokens:2000,reasoning_output_tokens:500,total_tokens:302000};
 const events=[short,long].map((tokens,index)=>({
  key:(index?'b':'a').repeat(64),day:'2026-11-22',hour:'2026-11-22T02:00:00+00:00',
  at:`2026-11-22T02:0${index+1}:00.000Z`,cwd:'/project/src',model:'gpt-6.2-sol',tier:'standard',provider:null,tokens,
 }));
 const combined={input_tokens:500000,cached_input_tokens:470000,output_tokens:3000,reasoning_output_tokens:600,total_tokens:503000};
 respond([{day:'2026-11-22',cwd:'/project/src',model:'gpt-6.2-sol',tier:'standard',requests:2,tokens:combined}],{events});
 await collectAccountUsage('native');
 const result=cachedAccountUsage('native').rows[0],model=result.models[0];
 expect(model.usd_breakdown).toEqual({
  input:0.1,cache:0.075,output:0.04,reasoning:0.0085,
 });
 const itemized={
  input:model.usd_breakdown!.input+model.usd_breakdown!.cache,
  cached:model.usd_breakdown!.cache,
  uncached:model.usd_breakdown!.input,
  reasoning:model.usd_breakdown!.reasoning,
  output:model.usd_breakdown!.output,
  total:model.estimated_usd,
 };
 for(const [key,value] of Object.entries({input:0.175,cached:0.075,uncached:0.1,reasoning:0.0085,output:0.04,total:0.215}))
  expect(itemized[key as keyof typeof itemized]).toBeCloseTo(value,10);
});

it.each([
 ['deepseek-v4.1-flash',1.82,2,8,false],
 ['deepseek-v4.1-flash',1.82,2,8,true],
 ['claude-sonnet-5-5',2.05,2,10,false],
])('prices %s through its own official API catalog (alias row: $alias)',async(model,expected,input,output,alias)=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-23T01:30:00Z'));
 initModelPricing();
 const openai='### Standard pricing data\n| gpt-6.2-sol | $2 | $10 | $0.10 | $2.50 | $5 | $4 | $15 | $0.20 |\n\nLong context: >272K input tokens.';
 const deepseek=`| 模型 | 模型 | 模型 | deepseek-flash(1) |
| 模型版本 | 模型版本 | 模型版本 | DeepSeek-V4.1-Flash-1017 |
| 价格(2) | 输入（缓存命中） | 高峰时段 | 0.04元 |
| 价格(2) | 输入（缓存命中） | 空闲时段 | 0.02元 |
| 价格(2) | 输入（缓存未命中） | 高峰时段 | ${input}元 |
| 价格(2) | 输入（缓存未命中） | 空闲时段 | ${input/2}元 |
| 价格(2) | 百万tokens输出 | 高峰时段 | ${output}元 |
| 价格(2) | 百万tokens输出 | 空闲时段 | ${output/2}元 |

北京时间周一至周五（不含中国法定节假日）9:00 - 12:00、14:00 - 18:00 为高峰时段。${alias?`
旧模型名 \`deepseek-v4.1-flash\` 按 Flash 价格计费。`:''}`;
 const claude=`| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
| Claude Sonnet 5.5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.10 / MTok | $10 / MTok |`;
 const documents:Record<string,string>={[pricingSources.openai]:openai,[pricingSources.deepseek]:deepseek,[pricingSources.claude]:claude};
 await refreshModelPricing(async url=>new Response(documents[String(url)]??'',{status:documents[String(url)]?200:404}));
 const counters={input_tokens:1000000,cached_input_tokens:500000,output_tokens:100000,reasoning_output_tokens:50000,total_tokens:1100000};
 const event={key:'d'.repeat(64),day:'2026-11-23',hour:'2026-11-23T01:00:00+00:00',at:'2026-11-23T01:30:00.000Z',cwd:'/project',model,tier:'standard',provider:null,tokens:counters};
 respond([{day:'2026-11-23',cwd:'/project',model,tier:'standard',requests:1,at:event.at,tokens:counters}],{events:[event]});
 await collectAccountUsage('native');
 expect(cachedAccountUsage('native').rows[0].models[0]).toMatchObject({estimated_usd:expected,usd_coverage:{covered:1,total:1}});
});

it('prices official models used through an API Provider without inventing unknown model costs',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-23T01:30:00Z'));
 initModelPricing();
 const pricing=`| 模型 | 模型 | 模型 | deepseek-flash(1) |
| 模型版本 | 模型版本 | 模型版本 | DeepSeek-V4.1-Flash-1017 |
| 价格(2) | 输入（缓存命中） | 高峰时段 | 0.04元 |
| 价格(2) | 输入（缓存命中） | 空闲时段 | 0.02元 |
| 价格(2) | 输入（缓存未命中） | 高峰时段 | 2元 |
| 价格(2) | 输入（缓存未命中） | 空闲时段 | 1元 |
| 价格(2) | 百万tokens输出 | 高峰时段 | 8元 |
| 价格(2) | 百万tokens输出 | 空闲时段 | 4元 |

北京时间周一至周五（不含中国法定节假日）9:00 - 12:00、14:00 - 18:00 为高峰时段。`;
 await refreshModelPricing(async url=>String(url)===pricingSources.deepseek?new Response(pricing):new Response('',{status:404}));
 const provider={id:'xindu',name:'xindu',kind:'responses',enabled:true,fields:{codexHome:'/tmp/provider-official-cost',models:['deepseek-v4.1-flash','private-model'],baseUrl:'https://xindu.example/v1'}};
 updateAgentManagement('codex',()=>({defaults:{},providers:[provider]}));
 const tokens={input_tokens:1000000,cached_input_tokens:500000,output_tokens:100000,reasoning_output_tokens:0,total_tokens:1100000};
 const official={key:'e'.repeat(64),day:'2026-11-23',hour:'2026-11-23T01:00:00+00:00',at:'2026-11-23T01:30:00.000Z',cwd:'/project',model:'deepseek-v4.1-flash',tier:'default',provider:null,tokens};
 const unknown={...official,key:'f'.repeat(64),model:'private-model'};
 respond([
  {...official,requests:1},
  {...unknown,requests:1},
 ],{events:[official,unknown]});
 await collectAccountUsage('provider:xindu');
 const result=cachedAccountUsage('provider:xindu').rows[0],models=new Map(result.models.map(model=>[model.model,model]));
 expect(models.get('deepseek-v4.1-flash')).toMatchObject({estimated_usd:1.82,usd_coverage:{covered:1,total:1}});
 expect(models.get('private-model')).toMatchObject({estimated_usd:null,usd_coverage:{covered:0,total:1}});
});

it('prices a known gateway model through the provider multiplier in API usage',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-23T01:30:00Z'));
 initModelPricing();
 const pricing=`| 模型 | 模型 | 模型 | deepseek-flash(1) |
| 模型版本 | 模型版本 | 模型版本 | DeepSeek-V4.1-Flash-1017 |
| 价格(2) | 输入（缓存命中） | 高峰时段 | 0.04元 |
| 价格(2) | 输入（缓存命中） | 空闲时段 | 0.02元 |
| 价格(2) | 输入（缓存未命中） | 高峰时段 | 2元 |
| 价格(2) | 输入（缓存未命中） | 空闲时段 | 1元 |
| 价格(2) | 百万tokens输出 | 高峰时段 | 8元 |
| 价格(2) | 百万tokens输出 | 空闲时段 | 4元 |

北京时间周一至周五（不含中国法定节假日）9:00 - 12:00、14:00 - 18:00 为高峰时段。`;
 await refreshModelPricing(async url=>String(url)===pricingSources.deepseek?new Response(pricing):new Response('',{status:404}));
 const provider={id:'xindu',name:'xindu',kind:'responses',enabled:true,fields:{codexHome:'/tmp/provider-multiplier-cost',models:['deepseek-v4.1-flash'],baseUrl:'https://xindu.example/v1',providerRateMultiplier:'0.25'}};
 updateAgentManagement('codex',()=>({defaults:{},providers:[provider]}));
 const tokens={input_tokens:1000000,cached_input_tokens:500000,output_tokens:100000,reasoning_output_tokens:0,total_tokens:1100000};
 const event={key:'a'.repeat(64),day:'2026-11-23',hour:'2026-11-23T01:00:00+00:00',at:'2026-11-23T01:30:00.000Z',cwd:'/project',model:'deepseek-v4.1-flash',tier:'default',provider:'xindu',tokens};
 respond([],{events:[event]});
 await collectAccountUsage('provider:xindu');
 const model=cachedAccountUsage('provider:xindu').rows[0].models[0];
 expect(model.api_cost).toMatchObject({amount:0.455,coverage:{covered:1,total:1}});
 expect(model.api_cost?.breakdown?.input).toBeCloseTo(0.25,10);
 expect(model.api_cost?.breakdown?.cache).toBeCloseTo(0.005,10);
 expect(model.api_cost?.breakdown?.output).toBeCloseTo(0.2,10);
});
