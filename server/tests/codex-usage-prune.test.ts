import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createTestDatabase} from './helpers/database.js';
import {getDb} from '../src/db/index.js';
import {initAccountUsage,cachedAccountUsage,collectAccountUsage,stopAccountUsage,USAGE_RULE_VERSION} from '../src/services/agents/codex/account-usage.js';
import {initAccountStatus} from '../src/services/agents/codex/account-status.js';
import {exportUsageCsv} from '../src/services/agents/codex/usage-csv-export.js';
import {pruneUsageCsvDuplicates} from '../src/services/agents/codex/usage-csv-prune.js';
import {usageAggregates,aggregateKey} from '../src/services/agents/codex/usage-aggregates.js';
import {publishUsageCsv,readUsageCsv,usageCsvDirectory} from '../src/services/agents/codex/usage-csv.js';
import {assertUsageRebuildPreserves} from '../src/services/agents/codex/usage-rule-guard.js';
import * as transport from '../src/services/agents/codex/account-transport.js';
let fixture:ReturnType<typeof createTestDatabase>,source:string;
const checked='2026-01-05T12:00:00.000Z';
const counters=(n:number)=>({input_tokens:n,cached_input_tokens:0,output_tokens:0,reasoning_output_tokens:0,total_tokens:n});
function add(day:string,n:number,unknown=false,legacy=false){
 const db=getDb(),tokens={...counters(n),cached_input_tokens:unknown?null:0},row={day,cwd:'/p',model:'gpt-6.1-sol',tier:null};
 const key=aggregateKey(row,tokens),id=createHash('sha256').update(day+String(n)).digest('hex');
 db.prepare('INSERT INTO codex_usage_events VALUES(?,?,?,?,?,?,?)').run('native',legacy?'legacy':key,day,row.cwd,row.model,null,JSON.stringify({...tokens,requests:1}));
 db.prepare('INSERT INTO codex_usage_dedup_events(account,event_key,day,cwd,model,tier,tokens,hour,at) VALUES(?,?,?,?,?,?,?,?,?)').run('native',id,day,row.cwd,row.model,null,JSON.stringify({...tokens,_timezone:'UTC'}),day+'T12:00:00+00:00',day+'T12:01:00Z');
 db.prepare('INSERT INTO codex_usage_event_ids(account,event_id,day,timezone) VALUES(?,?,?,?)').run('native',Buffer.from(id,'hex'),day,'UTC');
 return {...row,tokens,key:id,aggregate:key};
}
function mirror(){
 const history=usageAggregates('native').map(row=>[row.day,row.day+'T12:00:00+00:00',row.cwd,row.model,row.tier,counters(JSON.parse(row.tokens).total_tokens),JSON.parse(row.tokens).requests,null,null]);
 publishUsageCsv('native',{day:'2026-01-05',timezone:'UTC',checkpoint:checked,source,current:[],history,quota:[]});
}
beforeEach(()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date(checked));vi.stubEnv('TZ','UTC');fixture=createTestDatabase();vi.stubEnv('CODEX_HOME',join(fixture.dir,'home'));initAccountUsage();initAccountStatus();const db=getDb();source=JSON.stringify(['native',process.env.CODEX_HOME]);
 db.prepare('INSERT INTO codex_usage_sources VALUES(?,?)').run('native',source);
 db.prepare('INSERT INTO codex_usage_status VALUES(?,?,NULL,0)').run('native',checked);
 db.prepare('INSERT INTO codex_usage_ledger(account,baseline_at,last_day,timezone) VALUES(?,NULL,?,?)').run('native','2026-01-05','UTC');
 db.prepare('INSERT INTO codex_usage_snapshots VALUES(?,1)').run('native');db.prepare('INSERT INTO codex_usage_dedup_status(account,ready,hour_backfilled) VALUES(?,1,1)').run('native');
 db.prepare("INSERT INTO codex_usage_rule_versions(account,version,state) VALUES(?,?,'ready')").run('native',USAGE_RULE_VERSION);
});
afterEach(async()=>{await stopAccountUsage();fixture.cleanup();vi.restoreAllMocks();vi.useRealTimers();vi.unstubAllEnvs();});
it('removes verified cold summaries without changing reports, preserves live days and supports repeated exports and rule rebuilds',()=>{
 const events=[add('2026-01-01',100),add('2026-01-04',200),add('2026-01-05',300)];const before=cachedAccountUsage('native');
 exportUsageCsv('native');expect(getDb().prepare('SELECT day FROM codex_usage_events ORDER BY day').all()).toEqual([{day:'2026-01-04'},{day:'2026-01-05'}]);
 expect(cachedAccountUsage('native').rows).toEqual(before.rows);expect(usageAggregates('native')).toHaveLength(3);
 expect(()=>assertUsageRebuildPreserves(getDb(),'native',events,500000)).not.toThrow();
 exportUsageCsv('native');exportUsageCsv('native',{rebuild:true});expect(cachedAccountUsage('native').rows).toEqual(before.rows);expect(getDb().prepare('SELECT COUNT(*) n FROM codex_usage_archived_aggregates').get()).toEqual({n:1});
});
it.each(['checkpoint','source','timezone','corrupt','projection','counter'] as const)('does not delete anything when %s verification fails',kind=>{
 add('2026-01-01',100);mirror();const db=getDb();
 if(kind==='checkpoint')db.prepare('UPDATE codex_usage_status SET checked_at=?').run('2026-01-05T12:05:00Z');
 if(kind==='source')db.prepare('UPDATE codex_usage_sources SET identity=?').run('changed');
 if(kind==='timezone')db.prepare('UPDATE codex_usage_ledger SET timezone=?').run('Asia/Taipei');
 if(kind==='projection')db.prepare('DELETE FROM codex_usage_dedup_events').run();
 if(kind==='counter')db.prepare("UPDATE codex_usage_events SET tokens=json_set(tokens,'$.total_tokens',101)").run();
 if(kind==='corrupt'){const dir=usageCsvDirectory('native'),manifest=JSON.parse(readFileSync(join(dir,'manifest.json'),'utf8'));writeFileSync(join(dir,manifest.files.history),'bad');}
 expect(pruneUsageCsvDuplicates('native')).toBe(0);expect(db.prepare('SELECT COUNT(*) n FROM codex_usage_events').get()).toEqual({n:1});
});
it('keeps historical data available after CSV corruption and repairs the archive from retained request identities',()=>{
 add('2026-01-01',100);const before=cachedAccountUsage('native').rows;exportUsageCsv('native');const dir=usageCsvDirectory('native'),manifest=JSON.parse(readFileSync(join(dir,'manifest.json'),'utf8'));writeFileSync(join(dir,manifest.files.history),'bad');
 expect(cachedAccountUsage('native').rows).toEqual(before);exportUsageCsv('native',{rebuild:true});expect(readUsageCsv('native')?.history).toHaveLength(1);expect(cachedAccountUsage('native').rows).toEqual(before);
});
it('preserves unknown counters and retains legacy summaries that lack a canonical recoverable identity',()=>{
 add('2026-01-01',100,true);add('2026-01-02',200,false,true);const before=cachedAccountUsage('native').rows;exportUsageCsv('native');
 expect(getDb().prepare('SELECT event_key FROM codex_usage_events').all()).toEqual([{event_key:'legacy'}]);expect(cachedAccountUsage('native').rows).toEqual(before);expect(usageAggregates('native').find(row=>row.day==='2026-01-01')?.tokens).toContain('"cached_input_tokens":null');
});
it('adds a late recovered request to a previously pruned day without replacing or duplicating its old total',async()=>{
 add('2026-01-01',100);exportUsageCsv('native');getDb().prepare('UPDATE codex_usage_dedup_status SET ready=0').run();const key='b'.repeat(64),tokens=counters(50);
 vi.spyOn(transport,'localCommandInput').mockImplementation(async(_script,input)=>JSON.stringify({...JSON.parse(input),rows:[{day:'2026-01-01',cwd:'/p',model:'gpt-6.1-sol',tier:null,tokens,requests:1}],event_keys:{'2026-01-01':Buffer.from(key,'hex').toString('base64')},events:[{key,day:'2026-01-01',cwd:'/p',model:'gpt-6.1-sol',tier:null,tokens,hour:'2026-01-01T12:00:00+00:00',at:'2026-01-01T12:02:00Z'}],events_truncated:false,partial:false,errors:0}));
 await collectAccountUsage('native');expect(cachedAccountUsage('native').rows[0].tokens.total_tokens).toBe(150);expect(readUsageCsv('native')?.history.reduce((sum,row)=>sum+(row[5] as ReturnType<typeof counters>).total_tokens,0)).toBe(150);expect(getDb().prepare('SELECT COUNT(*) n FROM codex_usage_events').get()).toEqual({n:0});
});
