import {it,expect,beforeEach,afterEach} from 'vitest';
import {createTestDatabase} from './helpers/database.js';
import {encodeCsv,decodeCsv,publishUsageCsv,readUsageCsv,usageCsvDirectory,csvUsageBreakdown} from '../src/services/agents/codex/usage-csv.js';
import {writeFileSync,readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
let fixture:ReturnType<typeof createTestDatabase>;beforeEach(()=>fixture=createTestDatabase());afterEach(()=>fixture.cleanup());
it('roundtrips paths and metadata without losing commas, quotes, newlines, nulls or zero',()=>{
 const rows=[['/a,b/"c"\nfile',null,0,{input_tokens:123}]];expect(decodeCsv(encodeCsv(['path','model','quota','tokens'],rows))).toEqual(rows);expect(()=>decodeCsv('x\n"broken')).toThrow();
});
it('atomically replaces daily files while preserving history across a rollover and restart',()=>{
 const history=[['2026-01-01','2026-01-01T10:00:00Z','/p','model','fast',{total_tokens:10},1,'session']];
 publishUsageCsv('account',{day:'2026-01-01',timezone:'UTC',current:history,history:[],quota:[]});
 expect(readUsageCsv('account')?.current).toEqual(history);
 // An interrupted writer cannot change the published generation.
 writeFileSync(join(usageCsvDirectory('account'),'interrupted.tmp'),'partial');expect(readUsageCsv('account')?.current).toEqual(history);
 publishUsageCsv('account',{day:'2026-01-02',timezone:'UTC',current:[],history,quota:[]});expect(readUsageCsv('account')).toMatchObject({day:'2026-01-02',current:[],history});
 publishUsageCsv('account',{day:'2026-01-02',timezone:'UTC',current:[],history,quota:[]});expect(readdirSync(usageCsvDirectory('account')).filter(f=>f.endsWith('.csv')).length).toBeLessThanOrEqual(8);
});
it('detects corruption rather than publishing silently changed usage',()=>{
 publishUsageCsv('a',{day:'2026-01-01',timezone:'UTC',current:[],history:[],quota:[]});const dir=usageCsvDirectory('a'),file=readdirSync(dir).find(f=>f.startsWith('hourly-'))!;writeFileSync(join(dir,file),'broken');expect(()=>readUsageCsv('a')).toThrow('checksum');publishUsageCsv('a',{day:'2026-01-01',timezone:'UTC',current:[],history:[],quota:[]});expect(readUsageCsv('a')?.history).toEqual([]);
});
it('migrates precise hourly usage, preserves speed and session, and rolls today into history',async()=>{
 const {vi}=await import('vitest');const {getDb}=await import('../src/db/index.js');const {initAccountUsage}=await import('../src/services/agents/codex/account-usage.js');const {exportUsageCsv}=await import('../src/services/agents/codex/usage-csv-export.js');
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-01-02T12:00:00Z'));initAccountUsage();const db=getDb();const tokens={input_tokens:100,cached_input_tokens:20,output_tokens:10,total_tokens:110,reasoning_output_tokens:0,requests:1,_timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,_session:'session'};
 try{
 db.prepare('INSERT INTO codex_usage_events VALUES(?,?,?,?,?,?,?)').run('a','aggregate','2026-01-02','/project','gpt-6.1-sol','fast',JSON.stringify(tokens));db.prepare('INSERT INTO codex_usage_dedup_events(account,event_key,day,cwd,model,tier,tokens,hour,at) VALUES(?,?,?,?,?,?,?,?,?)').run('a','event','2026-01-02','/project','gpt-6.1-sol','fast',JSON.stringify(tokens),'2026-01-02T10:00:00+00:00','2026-01-02T10:02:00Z');
 db.prepare("UPDATE codex_usage_dedup_events SET provider='api-provider' WHERE account='a'").run();exportUsageCsv('a');expect(readUsageCsv('a')?.current).toHaveLength(1);expect(readUsageCsv('a')?.current[0][8]).toBe('api-provider');vi.setSystemTime(new Date('2026-01-03T12:00:00Z'));exportUsageCsv('a');const snapshot=readUsageCsv('a')!;expect(snapshot.current).toEqual([]);expect(snapshot.history).toHaveLength(1);expect(snapshot.history[0][1]).toBe('2026-01-02T10:00:00+00:00');expect(snapshot.history[0][4]).toBe('fast');expect(snapshot.history[0][7]).toBe('session');expect(snapshot.history[0][8]).toBe('api-provider');expect(snapshot.history[0][5]).toMatchObject({total_tokens:110});db.prepare('DELETE FROM codex_usage_dedup_events WHERE account=?').run('a');db.prepare('DELETE FROM codex_usage_events WHERE account=?').run('a');exportUsageCsv('a');expect(readUsageCsv('a')?.history).toEqual(snapshot.history);
 }finally{vi.useRealTimers();}
});
it('archives 100000 requests into bounded hourly rows with conserved totals',async()=>{
 const {getDb}=await import('../src/db/index.js');const {initAccountUsage}=await import('../src/services/agents/codex/account-usage.js');const {exportUsageCsv}=await import('../src/services/agents/codex/usage-csv-export.js');initAccountUsage();const db=getDb();
 db.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<100000) INSERT INTO codex_usage_dedup_events(account,event_key,day,cwd,model,tier,tokens,hour,at) SELECT 'perf',printf('%064x',n),'2025-01-01','/p'||(n%10),'gpt-6.1-sol',NULL,'{"input_tokens":10,"cached_input_tokens":0,"output_tokens":1,"total_tokens":11,"reasoning_output_tokens":0}',printf('2025-01-01T%02d:00:00+00:00',n%24),'2025-01-01T00:01:00Z' FROM seq`).run();
 const start=performance.now();exportUsageCsv('perf');const snapshot=readUsageCsv('perf')!;expect(snapshot.current).toEqual([]);expect(snapshot.history.length).toBeLessThanOrEqual(240);expect(snapshot.history.reduce((n,r)=>n+(r[5] as any).total_tokens,0)).toBe(1100000);console.log(`CSV archive: 100000 requests in ${Math.round(performance.now()-start)}ms`);
},30000);
it('keeps a validated previous generation available for recovery',()=>{
 const snapshot={day:'2026-01-01',timezone:'UTC',current:[],history:[],quota:[],observed:[['2025-01-01T00:00:00+00:00',1]]};publishUsageCsv('backup',snapshot);publishUsageCsv('backup',{...snapshot,day:'2026-01-02',history:[['2026-01-01',null,'/p',null,null,{total_tokens:1},1,null]]});
 const root=usageCsvDirectory('backup'),manifest=JSON.parse(requireRead(join(root,'manifest.json')));writeFileSync(join(root,manifest.files.history),'bad');expect(()=>readUsageCsv('backup')).toThrow();expect(readUsageCsv('backup',true)?.observed).toEqual(snapshot.observed);
});
function requireRead(path:string){return readFileSync(path,'utf8');}

it('rejects a stale checkpoint after an interrupted database-to-file publication',()=>{
 publishUsageCsv('checkpoint',{day:'2026-01-01',timezone:'UTC',checkpoint:'old',current:[],history:[],quota:[]});expect(csvUsageBreakdown('checkpoint','new','UTC')).toBeNull();expect(csvUsageBreakdown('checkpoint','old','Asia/Taipei')).toBeNull();expect(csvUsageBreakdown('checkpoint','old','UTC')).toEqual([]);
});
it('keeps archived observed hours visible after raw samples have expired',async()=>{
 const {initAccountUsage,cachedAccountUsage}=await import('../src/services/agents/codex/account-usage.js');initAccountUsage();const timezone=Intl.DateTimeFormat().resolvedOptions().timeZone;
 publishUsageCsv('native',{day:'2026-01-02',timezone,current:[],history:[],quota:[],observed:[['2025-01-01T00:00:00+00:00',2]]});expect(cachedAccountUsage('native').quota_hours).toEqual([{hour:'2025-01-01T00:00:00+00:00',quota:2}]);
});

it('revisits the closing day when a midnight quota interval becomes eligible on the following scan',async()=>{
 const {vi}=await import('vitest');const {getDb}=await import('../src/db/index.js');
 const {initAccountUsage}=await import('../src/services/agents/codex/account-usage.js');
 const {initAccountStatus}=await import('../src/services/agents/codex/account-status.js');
 const {exportUsageCsv}=await import('../src/services/agents/codex/usage-csv-export.js');
 vi.useFakeTimers();vi.stubEnv('TZ','UTC');vi.setSystemTime(new Date('2026-01-02T23:59:00Z'));initAccountUsage();initAccountStatus();const db=getDb();
 try{
  const usage=(n:number)=>JSON.stringify({input_tokens:n,cached_input_tokens:0,output_tokens:0,reasoning_output_tokens:0,total_tokens:n,requests:1});
  const add=(day:string,at:string,n:number)=>{db.prepare('INSERT INTO codex_usage_dedup_events(account,event_key,day,cwd,model,tier,tokens,hour,at) VALUES(?,?,?,?,?,?,?,?,?)').run('midnight',day,day,'/p','gpt-6.1-sol',null,usage(n),day+'T'+(day.endsWith('02')?'23':'00')+':00:00+00:00',at);db.prepare('INSERT INTO codex_usage_events VALUES(?,?,?,?,?,?,?)').run('midnight',day,day,'/p','gpt-6.1-sol',null,usage(n));};
  const sample=(at:string,used:number)=>db.prepare('INSERT INTO codex_quota_samples VALUES(?,?,?,?,?,?)').run('midnight','identity','fixture@example.invalid',at,2000000000,used);
  db.prepare('INSERT INTO codex_account_status(account,identity) VALUES(?,?)').run('midnight','identity');
  db.prepare('INSERT INTO codex_quota_samples VALUES(?,?,?,?,?,?)').run('midnight','old-identity','fixture@example.invalid','2026-01-02T23:55:00Z',2000000000,80);
  sample('2026-01-02T23:53:00Z',10);sample('2026-01-02T23:58:00Z',11);add('2026-01-02','2026-01-02T23:59:00Z',100);
  db.prepare('INSERT OR REPLACE INTO codex_usage_scan_boundary VALUES(?,?)').run('midnight','2026-01-02T23:59:00Z');exportUsageCsv('midnight');
  expect(readUsageCsv('midnight')?.observed).toEqual([['2026-01-02T23:00:00+00:00',1]]);
  vi.setSystemTime(new Date('2026-01-03T00:03:00Z'));sample('2026-01-03T00:03:00Z',15);add('2026-01-03','2026-01-03T00:01:00Z',300);
  db.prepare('INSERT OR REPLACE INTO codex_usage_scan_boundary VALUES(?,?)').run('midnight','2026-01-03T00:02:00Z');exportUsageCsv('midnight');
  const history=readUsageCsv('midnight')!.history;expect(history).toHaveLength(1);
  vi.setSystemTime(new Date('2026-01-03T00:08:00Z'));db.prepare('INSERT OR REPLACE INTO codex_usage_scan_boundary VALUES(?,?)').run('midnight','2026-01-03T00:08:00Z');
  for(let i=0;i<2;i++){exportUsageCsv('midnight');expect(readUsageCsv('midnight')?.observed).toEqual([['2026-01-02T23:00:00+00:00',2],['2026-01-03T00:00:00+00:00',3]]);expect(readUsageCsv('midnight')?.history).toEqual(history);}
  vi.setSystemTime(new Date('2026-01-04T00:08:00Z'));exportUsageCsv('midnight');expect(readUsageCsv('midnight')?.observed).toEqual([['2026-01-02T23:00:00+00:00',2],['2026-01-03T00:00:00+00:00',3]]);
 }finally{vi.useRealTimers();vi.unstubAllEnvs();}
});
