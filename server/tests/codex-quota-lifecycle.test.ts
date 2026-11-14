import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createTestDatabase} from './helpers/database.js';
import {getDb} from '../src/db/index.js';
import * as stream from '../src/services/agents/codex/stream.js';
import {initAccountStatus,collectAccountStatus,cachedAccountStatus} from '../src/services/agents/codex/account-status.js';
import {readCodexWeeklyQuota} from '../src/services/agents/codex/quota.js';
let fixture:ReturnType<typeof createTestDatabase>;
const request=vi.fn();
beforeEach(()=>{
 fixture=createTestDatabase();initAccountStatus();vi.clearAllMocks();
 request.mockImplementation(async(method:string)=>method==='account/read'?{account:{type:'chatgpt',email:'fixture@example.invalid'}}:{rateLimits:{secondary:{usedPercent:36,windowDurationMins:10080,resetsAt:200}}});
 vi.spyOn(stream,'withCodexConnection').mockImplementation(async callback=>callback(request));
});
afterEach(()=>{fixture.cleanup();vi.restoreAllMocks();vi.useRealTimers();});
it('all readers, including forced refresh and expired cache, share the scheduler snapshot without upstream calls',async()=>{
 await expect(readCodexWeeklyQuota()).rejects.toThrow('尚未取得');expect(request).not.toHaveBeenCalled();
 await collectAccountStatus('native');expect(request).toHaveBeenCalledTimes(2);
 const values=await Promise.all(Array.from({length:10},()=>readCodexWeeklyQuota({force:true})));
 expect(values.every(value=>value.remainingPercent===64)).toBe(true);expect(values[0]).toEqual(cachedAccountStatus('native').quota);
 vi.useFakeTimers();await vi.advanceTimersByTimeAsync(900000);
 expect(await readCodexWeeklyQuota({force:true})).toMatchObject({remainingPercent:64,stale:true});expect(request).toHaveBeenCalledTimes(2);
});
it('returns API authentication as not applicable without fetching rate limits',async()=>{
 request.mockResolvedValueOnce({account:{type:'apiKey'}});await collectAccountStatus('native');
 for(let i=0;i<3;i++)await expect(readCodexWeeklyQuota({force:true})).rejects.toMatchObject({reason:'not_applicable'});
 expect(request).toHaveBeenCalledTimes(1);
});
it('retains successful persisted data across failures and reader reloads',async()=>{
 await collectAccountStatus('native');const original=await readCodexWeeklyQuota();request.mockRejectedValueOnce(Error('offline'));
 await collectAccountStatus('native');expect(await readCodexWeeklyQuota()).toEqual({...original,stale:true});
 expect(getDb().prepare('SELECT checked_at FROM codex_account_status').get()).toEqual({checked_at:original.checkedAt});
});
