import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {createTestDatabase} from './helpers/database.js';
import {getDb} from '../src/db/index.js';
import * as stream from '../src/services/agents/codex/stream.js';
import {initAccountStatus,collectAccountStatus,cachedAccountStatus,startAccountStatus,stopAccountStatus} from '../src/services/agents/codex/account-status.js';
vi.mock('../src/services/agents/codex/environments.js',async original=>({...await original<typeof import('../src/services/agents/codex/environments.js')>(),engineForEnvironment:vi.fn(async(id:string)=>({environmentId:id}))}));
let fixture:ReturnType<typeof createTestDatabase>;
const read=vi.fn();
beforeEach(()=>{vi.clearAllMocks();fixture=createTestDatabase();initAccountStatus();read.mockImplementation(async(method:string)=>method==='account/read'?{account:{type:'chatgpt',email:'fixture@example.invalid',planType:'pro',secret:'never-cache'}}:{rateLimits:{secondary:{usedPercent:30,windowDurationMins:10080,resetsAt:123}},rateLimitResetCredits:{availableCount:2,credits:[{expiresAt:456,grantedAt:123,status:'available',secret:'never-cache'}]}});vi.spyOn(stream,'withCodexConnection').mockImplementation(async callback=>callback(read));});
afterEach(async()=>{await stopAccountStatus();fixture.cleanup();vi.restoreAllMocks();vi.useRealTimers();});
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
it('refreshes only on the five minute schedule, independent of cache reads',async()=>{
 vi.useFakeTimers();startAccountStatus();await vi.advanceTimersByTimeAsync(1000);expect(read).toHaveBeenCalledTimes(2);
 for(let n=0;n<10;n++)cachedAccountStatus('native');await vi.advanceTimersByTimeAsync(299999);expect(read).toHaveBeenCalledTimes(2);
 await vi.advanceTimersByTimeAsync(1);expect(read).toHaveBeenCalledTimes(4);
});
