import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdirSync,writeFileSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {createTestDatabase} from './helpers/database.js';
import {getDb} from '../src/db/index.js';
import {createUser} from '../src/auth.js';
import {scheduleCodexStreamingUpgrade,stopCodexStreamingUpgrades} from '../src/services/agents/codex/streaming-upgrade.js';
import * as manager from '../src/services/session-manager.js';
import * as stream from '../src/services/agents/codex/stream.js';
import * as runtime from '../src/services/agents/codex/runtime.js';
let cleanup:()=>void,file:string;
const native='019ff001-1234-7234-8234-123456789abf';
beforeEach(()=>{const test=createTestDatabase();cleanup=test.cleanup;vi.stubEnv('CODEX_HOME',test.dir);vi.stubEnv('AGENTMANAGER_CODEX_STREAM_SOCKET','/tmp/upgrade-test.sock');mkdirSync(join(test.dir,'sessions'));file=join(test.dir,'sessions',`rollout-${native}.jsonl`);writeFileSync(file,'native log\n');const owner=createUser({username:'upgrade-admin',password:'password1',role:'admin'});getDb().prepare("INSERT INTO sessions(id,task,status,cli_type,codex_session_id,created_by_user_id) VALUES('upgrade','test','running','codex',?,?)").run(native,owner.id);});
afterEach(()=>{stopCodexStreamingUpgrades();vi.restoreAllMocks();vi.unstubAllEnvs();cleanup();});
it('waits for native completion, coalesces requests and upgrades once without polling',async()=>{
 const state=vi.spyOn(runtime,'readCodexRuntime').mockResolvedValue({state:'running'} as any),upgrade=vi.spyOn(manager,'ensureCodexConversationStreaming').mockResolvedValue(true),rpc=vi.spyOn(stream,'withCodexConnection').mockImplementation(async action=>action(async()=>({thread:{status:{type:'notLoaded'}}}),{userAgent:null}));
 expect(await scheduleCodexStreamingUpgrade('upgrade')).toBe(true);expect(await scheduleCodexStreamingUpgrade('upgrade')).toBe(true);await new Promise(resolve=>setTimeout(resolve,850));expect(upgrade).not.toHaveBeenCalled();expect(rpc).not.toHaveBeenCalled();
 state.mockResolvedValue({state:'idle'} as any);appendFileSync(file,'task_complete\n');await vi.waitFor(()=>expect(upgrade).toHaveBeenCalledExactlyOnceWith('upgrade'),{timeout:2000});appendFileSync(file,'later\n');await new Promise(resolve=>setTimeout(resolve,850));expect(upgrade).toHaveBeenCalledTimes(1);
});
it('does not restart a thread already connected by another client or a closed session',async()=>{
 vi.spyOn(runtime,'readCodexRuntime').mockResolvedValue({state:'idle'} as any);const upgrade=vi.spyOn(manager,'ensureCodexConversationStreaming').mockResolvedValue(true),rpc=vi.spyOn(stream,'withCodexConnection').mockImplementation(async action=>action(async()=>({thread:{status:{type:'idle'}}}),{userAgent:null}));
 await scheduleCodexStreamingUpgrade('upgrade');await vi.waitFor(()=>expect(rpc).toHaveBeenCalledOnce(),{timeout:2000});expect(upgrade).not.toHaveBeenCalled();
 await scheduleCodexStreamingUpgrade('upgrade');getDb().prepare("UPDATE sessions SET status='cancelled' WHERE id='upgrade'").run();await new Promise(resolve=>setTimeout(resolve,850));expect(upgrade).not.toHaveBeenCalled();expect(rpc).toHaveBeenCalledOnce();
});
