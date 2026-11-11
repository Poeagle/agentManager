import {execFile} from 'node:child_process';
import {mkdir,writeFile,appendFile,utimes,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createTestDatabase} from './helpers/database.js';
import {getDb} from '../src/db/index.js';
import {initAccountUsage,collectAccountUsage,cachedAccountUsage,cachedGroupUsage,stopAccountUsage} from '../src/services/agents/codex/account-usage.js';
import {localCommandInput} from '../src/services/agents/codex/account-transport.js';
import * as balance from '../src/services/agents/codex/engine-balance.js';
import {usageDay} from '../src/services/agents/codex/usage-time.js';
vi.mock('../src/services/agents/codex/account-transport.js',async original=>({...await original<typeof import('../src/services/agents/codex/account-transport.js')>(),localCommandInput:vi.fn()}));
let fixture:ReturnType<typeof createTestDatabase>,home:string;
const header=(id:string)=>JSON.stringify({type:'session_meta',payload:{id,cwd:'/project',model_provider:'fixture-provider'}})+'\n'+JSON.stringify({type:'turn_context',payload:{turn_id:id,model:'gpt-6.1-sol'}})+'\n';
const record=(at:string,total:number,last:number)=>JSON.stringify({type:'event_msg',timestamp:at,payload:{type:'token_count',info:{total_token_usage:{total_tokens:total},last_token_usage:{input_tokens:last,cached_input_tokens:0,output_tokens:0,reasoning_output_tokens:0,total_tokens:last}}}})+'\n';
async function file(name:string,body:string){const path=join(home,'sessions',name+'.jsonl');await writeFile(path,body);await utimes(path,new Date('2026-11-11T16:30:00Z'),new Date('2026-11-11T16:30:00Z'));return path;}
beforeEach(async()=>{
 vi.stubEnv('TZ','UTC');vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-11T16:34:00Z'));fixture=createTestDatabase();home=join(fixture.dir,'codex');await mkdir(join(home,'sessions'),{recursive:true});vi.stubEnv('CODEX_HOME',home);initAccountUsage();
 vi.mocked(localCommandInput).mockImplementation((script,input)=>new Promise((resolve,reject)=>{const child=execFile('python3',['-c',script],{maxBuffer:1024*1024},(error,out)=>error?reject(error):resolve(out));child.stdin!.end(input);}));
 vi.spyOn(balance,'cachedEngineBalance').mockReturnValue({auth_mode:'api',status:'available',groupKey:'fixture',providerId:'fixture-provider'});
});
afterEach(async()=>{await stopAccountUsage();fixture.cleanup();vi.restoreAllMocks();vi.resetAllMocks();vi.unstubAllEnvs();vi.useRealTimers();});
it('rebins UTC caches at local midnight once, preserves totals and returns to daily incremental collection',async()=>{
 const path=await file('complete',header('turn')+record('2026-11-11T15:59:59Z',100,100)+record('2026-11-11T16:00:00Z',300,200)+record('2026-11-11T16:10:00Z',350,50));
 await collectAccountUsage('native');expect(cachedAccountUsage('native').rows.map(r=>[r.date,r.tokens.total_tokens])).toEqual([['2026-11-11',350]]);
 vi.stubEnv('TZ','Asia/Taipei');expect(cachedAccountUsage('native')).toMatchObject({timezone:'UTC',timezone_pending:'Asia/Taipei'});await collectAccountUsage('native');
 expect(cachedAccountUsage('native')).toMatchObject({timezone:'Asia/Taipei',timezone_pending:null,unassigned:null,rows:[{date:'2026-11-12',tokens:{total_tokens:250}},{date:'2026-11-11',tokens:{total_tokens:100}}]});
 expect(cachedGroupUsage(['native'])).toMatchObject({timezone:'Asia/Taipei',unassigned:null,rows:[{date:'2026-11-12',tokens:{total_tokens:250}},{date:'2026-11-11',tokens:{total_tokens:100}}]});
 expect(cachedGroupUsage(['native'],'hour',true)).toMatchObject({timezone:'Asia/Taipei',rows:[{date:'2026-11-12',hour:'2026-11-12T00:00:00+08:00',tokens:{total_tokens:250}},{date:'2026-11-11',hour:'2026-11-11T23:00:00+08:00',tokens:{total_tokens:100}}]});
 await collectAccountUsage('native');expect(JSON.parse(vi.mocked(localCommandInput).mock.calls.at(-1)![1])).toMatchObject({mode:'daily',day:'2026-11-12',timezone:'Asia/Taipei',rebin:false});
 await appendFile(path,record('2026-11-11T16:35:00Z',375,25));await utimes(path,new Date('2026-11-11T16:35:00Z'),new Date('2026-11-11T16:35:00Z'));await collectAccountUsage('native');expect(cachedAccountUsage('native').rows[0].tokens.total_tokens).toBe(275);
 expect((getDb().prepare('SELECT COUNT(*) n FROM codex_usage_event_ids').get() as {n:number}).n).toBe(4);
});
it('retains disappeared session consumption as unassigned instead of deleting it or guessing a local date',async()=>{
 const a=await file('deleted',header('a')+record('2026-11-11T14:00:00Z',100,100));await file('present',header('b')+record('2026-11-11T16:10:00Z',200,200));await collectAccountUsage('native');await rm(a);vi.stubEnv('TZ','Asia/Taipei');await collectAccountUsage('native');
 expect(cachedAccountUsage('native')).toMatchObject({timezone:'Asia/Taipei',partial:true,rows:[{date:'2026-11-12',tokens:{total_tokens:200}}],unassigned:{requests:1,tokens:{total_tokens:100}}});
 expect(cachedGroupUsage(['native'])).toMatchObject({rows:[{date:'2026-11-12',tokens:{total_tokens:200}}],unassigned:{requests:1,tokens:{total_tokens:100}}});
 await collectAccountUsage('native');expect(cachedAccountUsage('native').unassigned?.tokens.total_tokens).toBe(100);
 await file('deleted',header('a')+record('2026-11-11T14:00:00Z',100,100));await collectAccountUsage('native');expect(cachedAccountUsage('native')).toMatchObject({rows:[{date:'2026-11-12',tokens:{total_tokens:200}}],unassigned:{requests:1,tokens:{total_tokens:100}}});
});
it('reconciles older aggregate-only baselines without fingerprints and never adds their recorded totals twice',async()=>{
 const a=await file('old-deleted',header('a')+record('2026-11-11T14:00:00Z',100,100));await file('old-present',header('b')+record('2026-11-11T16:10:00Z',200,200));await collectAccountUsage('native');
 getDb().exec('DELETE FROM codex_usage_ledger; DELETE FROM codex_usage_event_ids');getDb().prepare('UPDATE codex_usage_events SET event_key=?').run(JSON.stringify(['2026-11-11','/project','gpt-6.1-sol',null]));
 await rm(a);vi.stubEnv('TZ','Asia/Taipei');await collectAccountUsage('native');expect(cachedAccountUsage('native')).toMatchObject({rows:[{date:'2026-11-12',tokens:{total_tokens:200}}],unassigned:{tokens:{total_tokens:100}}});await collectAccountUsage('native');expect(cachedAccountUsage('native').rows[0].tokens.total_tokens).toBe(200);
});
it('rolls back a failed timezone migration and retries while retaining the old cache',async()=>{
 await file('failure',header('a')+record('2026-11-11T16:10:00Z',100,100));await collectAccountUsage('native');vi.stubEnv('TZ','Asia/Taipei');vi.mocked(localCommandInput).mockRejectedValueOnce(Error('unreadable'));
 await collectAccountUsage('native');expect(cachedAccountUsage('native')).toMatchObject({timezone:'UTC',timezone_pending:'Asia/Taipei',rows:[{date:'2026-11-11',tokens:{total_tokens:100}}]});await collectAccountUsage('native');expect(cachedAccountUsage('native')).toMatchObject({timezone:'Asia/Taipei',rows:[{date:'2026-11-12',tokens:{total_tokens:100}}]});
});
it('uses the platform IANA clock for day, month and year boundaries',()=>{
 expect(usageDay(Date.parse('2026-11-11T16:00:00Z'),'Asia/Taipei')).toBe('2026-11-12');expect(usageDay(Date.parse('2026-12-31T16:00:00Z'),'Asia/Taipei')).toBe('2027-01-01');expect(usageDay(Date.parse('2026-11-01T06:30:00Z'),'America/New_York')).toBe('2026-11-01');
});
