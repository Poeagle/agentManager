import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {createTestDatabase} from './helpers/database.js';
import {getDb} from '../src/db/index.js';
import * as stream from '../src/services/agents/codex/stream.js';
import {initAccountStatus,collectAccountStatus,cachedAccountStatus,stopAccountStatus} from '../src/services/agents/codex/account-status.js';
vi.mock('../src/services/agents/codex/environments.js',async original=>({...await original<typeof import('../src/services/agents/codex/environments.js')>(),engineForEnvironment:vi.fn(async(id:string)=>({environmentId:id}))}));
let fixture:ReturnType<typeof createTestDatabase>;
const read=vi.fn();
beforeEach(()=>{vi.clearAllMocks();fixture=createTestDatabase();initAccountStatus();read.mockImplementation(async(method:string)=>method==='account/read'?{account:{type:'chatgpt',email:'fixture@example.invalid',planType:'pro',secret:'never-cache'}}:{rateLimits:{secondary:{usedPercent:30,windowDurationMins:10080,resetsAt:123}},rateLimitResetCredits:{availableCount:2,credits:[{expiresAt:456,grantedAt:123,status:'available',secret:'never-cache'}]}});vi.spyOn(stream,'withCodexConnection').mockImplementation(async callback=>callback(read));});
afterEach(async()=>{
 const usage=await import('../src/services/agents/codex/account-usage.js');
 await usage.stopAccountUsage();
 await stopAccountStatus();
 fixture.cleanup();
 vi.restoreAllMocks();
 vi.unstubAllEnvs();
 vi.useRealTimers();
});
it('keeps all cache reads inert, and sanitizes a shared quota/reset snapshot after one background collection',async()=>{
 for(let n=0;n<5;n++)expect(cachedAccountStatus('native')).toMatchObject({quota:null,resets:null,pending:true});expect(read).not.toHaveBeenCalled();
 await Promise.all([collectAccountStatus('native'),collectAccountStatus('native')]);expect(read).toHaveBeenCalledTimes(2);
 for(let n=0;n<5;n++)expect(cachedAccountStatus('native')).toMatchObject({pending:false,quota:{remainingPercent:70},resets:{availableCount:2,credits:[{expiresAt:456,grantedAt:123,status:'available'}]}});
 expect(read).toHaveBeenCalledTimes(2);expect((getDb().prepare('SELECT data FROM codex_account_status').get() as any).data).not.toContain('never-cache');
});
it('retains successful data on failures, marks it stale and replaces it when logged out',async()=>{
 await collectAccountStatus('native');const checked=cachedAccountStatus('native').checked_at;
 read.mockRejectedValueOnce(Error('private failure'));await collectAccountStatus('native');expect(cachedAccountStatus('native')).toMatchObject({checked_at:checked,stale:true,quota:{remainingPercent:70,stale:true},resets:{availableCount:2},error:'账号状态采集失败，保留上次成功数据'});
 read.mockResolvedValueOnce({account:null});await collectAccountStatus('native');expect(cachedAccountStatus('native')).toMatchObject({reason:'not_applicable',quota:null,resets:null});
});
it('never refreshes on cache reads, even after the five minute interval',async()=>{
 vi.useFakeTimers();await collectAccountStatus('native');expect(read).toHaveBeenCalledTimes(2);
 await vi.advanceTimersByTimeAsync(900000);
 for(let n=0;n<10;n++)expect(cachedAccountStatus('native').stale).toBe(true);
 expect(read).toHaveBeenCalledTimes(2);
});
it('records bounded weekly samples without persisting unrelated account fields',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
 read.mockImplementation(async(method:string)=>method==='account/read'?{account:{type:'chatgpt',email:'fixture@example.invalid',secret:'never-cache'}}:{rateLimits:{secondary:{usedPercent:30,windowDurationMins:10080,resetsAt:Date.parse('2026-01-08T00:00:00Z')/1000}}});
 await collectAccountStatus('native');vi.advanceTimersByTime(300000);await collectAccountStatus('native');
 const samples=getDb().prepare('SELECT * FROM codex_quota_samples').all();expect(samples).toHaveLength(2);expect(JSON.stringify(samples)).not.toContain('never-cache');
});
it('allocates the observed quota by each model’s displayed USD amount after both collectors finish',async()=>{
 const {initAccountUsage,cachedAccountUsage,cachedGroupUsage}=await import('../src/services/agents/codex/account-usage.js');initAccountUsage();
 const {initModelPricing,pricingSources,refreshModelPricing}=await import('../src/services/agents/model-pricing.js');
 vi.stubEnv('TZ','UTC');
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
 initModelPricing();
 const prices=`### Standard pricing data
| gpt-6.1-sol | $2 | $10 | $0.10 |
| gpt-6-luna | $0.10 | $0.50 | $0.01 |

### Fast pricing data
| gpt-6-luna | $0.20 | $1.00 | $0.02 |`;
 await refreshModelPricing(async url=>String(url)===pricingSources.openai?new Response(prices):new Response(null,{status:404}));
 let used=10;read.mockImplementation(async(method:string)=>method==='account/read'?{account:{type:'chatgpt',email:'fixture@example.invalid'}}:{rateLimits:{secondary:{usedPercent:used,windowDurationMins:10080,resetsAt:Date.parse('2026-01-08T00:00:00Z')/1000}}});
 await collectAccountStatus('native');vi.advanceTimersByTime(300000);used=12;await collectAccountStatus('native');
 const db=getDb(),tokens=JSON.stringify({input_tokens:100,cached_input_tokens:0,output_tokens:0,reasoning_output_tokens:0,total_tokens:100,requests:1});
 db.prepare('INSERT INTO codex_usage_events VALUES(?,?,?,?,?,?,?)').run('native','aggregate','2026-01-01','/project','gpt-6.1-sol',null,tokens);
 db.prepare('INSERT INTO codex_usage_dedup_events(account,event_key,day,cwd,model,tier,tokens,hour,at) VALUES(?,?,?,?,?,?,?,?,?)').run('native','event','2026-01-01','/project','gpt-6.1-sol',null,tokens,'2026-01-01T00:00:00+00:00','2026-01-01T00:02:00+00:00');
 db.prepare('INSERT INTO codex_usage_events VALUES(?,?,?,?,?,?,?)').run('native','aggregate-fast','2026-01-01','/project','gpt-6-luna','priority',tokens);
 db.prepare('INSERT INTO codex_usage_dedup_events(account,event_key,day,cwd,model,tier,tokens,hour,at) VALUES(?,?,?,?,?,?,?,?,?)').run('native','event-fast','2026-01-01','/project','gpt-6-luna','priority',tokens,'2026-01-01T00:00:00+00:00','2026-01-01T00:03:00+00:00');
 db.prepare('INSERT INTO codex_usage_status VALUES(?,?,?,?)').run('native','2026-01-01T00:06:00.000Z',null,0);
 db.prepare('INSERT INTO codex_usage_scan_boundary VALUES(?,?)').run('native','2026-01-01T00:06:00.000Z');
 db.prepare('INSERT INTO codex_usage_snapshots VALUES(?,1)').run('native');db.prepare('INSERT INTO codex_usage_dedup_status(account,ready) VALUES(?,1)').run('native');
 const accountUsage=cachedAccountUsage('native');
 expect(accountUsage.quota_hours).toEqual([{hour:'2026-01-01T00:00:00+00:00',quota:2}]);
 for(const usage of [accountUsage,cachedGroupUsage(['native'],'hour',true)]){
  const models=usage.rows[0].models;
  expect(models.find(model=>model.model==='gpt-6.1-sol')?.actual_quota).toBeCloseTo(20/11,10);
  expect(models.find(model=>model.model==='gpt-6-luna')?.actual_quota).toBeCloseTo(2/11,10);
 }
 db.prepare('UPDATE codex_usage_status SET partial=1,error=? WHERE account=?').run('部分记录不可读取或缺少统计字段','native');
 const partial=cachedAccountUsage('native');expect(partial.partial).toBe(true);
 expect(partial.rows[0].models.find(model=>model.model==='gpt-6.1-sol')?.actual_quota).toBeCloseTo(20/11,10);
});

it('uses the most constrained live window and chooses an enabled, distinct account without fetching quota',async()=>{
 const {codexAccountRemaining,alternateCodexAccount}=await import('../src/services/agents/codex/account-status.js');
 const {createUser}=await import('../src/auth.js');
 const owner=createUser({username:'quota-test',password:'test-password',role:'admin'});
 const context={session:{agent_environment_id:null},actorUserId:owner.id} as import('../src/services/agents/types.js').AgentContext;
 vi.useFakeTimers();
 vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
 vi.stubEnv('CODEX_HOME',fixture.dir);
 try {
  const db=getDb(),future=Date.now()/1000+3600;
  const row=db.prepare('INSERT INTO agent_environments(id,agent_id,name,kind,enabled,config,allowed_user_ids) VALUES(?,?,?, ?,?,?,?)');
  const sample=db.prepare('INSERT INTO codex_account_status(account,identity,data,checked_at,error) VALUES(?,?,?,?,NULL)');
  sample.run('native',JSON.stringify(['native',fixture.dir]),JSON.stringify({account:{email:'source@example.invalid'},windows:[{usedPercent:100,resetsAt:future},{usedPercent:25,resetsAt:future}]}),new Date().toISOString());
  function add(id:string,email:string,used:number,reset:number,enabled=true,age=0){
   const home=`/home/${id}/.codex`;
   row.run(`account:${id}`,'codex',id,'account',Number(enabled),JSON.stringify({host:'127.0.0.1',username:id,codexHome:home,port:22,authMethod:'key'}),'[]');
   sample.run(`account:${id}`,JSON.stringify([id,home]),JSON.stringify({account:{email},windows:[{usedPercent:used,resetsAt:reset}]}),new Date(Date.now()-age).toISOString());
  }
  add('same','SOURCE@example.invalid',0,future);
  add('expired','expired@example.invalid',0,Date.now()/1000-1);
  add('stale','stale@example.invalid',0,future,true,601000);
  add('disabled','disabled@example.invalid',0,future,false);
  add('full','full@example.invalid',100,future);
  add('lower','lower@example.invalid',55,future);
  add('backup','backup@example.invalid',25,future);
  expect(codexAccountRemaining(context)).toBe(0);
  expect(alternateCodexAccount(context)).toEqual({id:'account:backup',label:'backup'});
  expect(read).not.toHaveBeenCalled();
 } finally {vi.unstubAllEnvs();}
});
