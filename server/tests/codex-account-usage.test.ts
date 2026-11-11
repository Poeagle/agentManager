import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {createTestDatabase} from './helpers/database.js';
import {getDb} from '../src/db/index.js';
import {initAccountUsage,collectAccountUsage,cachedAccountUsage} from '../src/services/agents/codex/account-usage.js';
import {accountCommandInput,localCommandInput} from '../src/services/agents/codex/account-transport.js';
vi.mock('../src/services/agents/codex/account-transport.js',async original=>({...await original<typeof import('../src/services/agents/codex/account-transport.js')>(),accountCommandInput:vi.fn(),localCommandInput:vi.fn()}));
let fixture:ReturnType<typeof createTestDatabase>;
const result={changes:[['/fixture/file.jsonl',{offset:10}]],events:[{key:'event',timestamp:'2026-01-01T23:00:00Z',cwd:'/project',tokens:{total_tokens:10,input_tokens:10,cached_input_tokens:null,output_tokens:0,reasoning_output_tokens:null}}],partial:false,errors:0};
beforeEach(()=>{fixture=createTestDatabase();initAccountUsage();vi.mocked(localCommandInput).mockResolvedValue(JSON.stringify(result));vi.mocked(accountCommandInput).mockResolvedValue(JSON.stringify(result));});
afterEach(()=>{fixture.cleanup();vi.resetAllMocks();});
it('returns registered project names with credit totals and explicit estimate coverage',async()=>{
 getDb().prepare("INSERT INTO projects(id,name,path) VALUES('usage-project','Usage Project','/project')").run();
 vi.mocked(localCommandInput).mockResolvedValueOnce(JSON.stringify({...result,events:[{...result.events[0],model:'gpt-6.1-sol',tier:'default',cwd:'/project/src',tokens:{total_tokens:1100000,input_tokens:1000000,cached_input_tokens:500000,output_tokens:100000,reasoning_output_tokens:50000}}]}));
 await collectAccountUsage('native');
 expect(cachedAccountUsage('native').rows[0]).toMatchObject({project_name:'Usage Project',cwd:'/project/src',estimated_credits:51.25,credit_coverage:{covered:1,total:1}});
});
it('persists cursors atomically and deduplicates replayed records across restarts',async()=>{
 await collectAccountUsage('native');await collectAccountUsage('native');initAccountUsage();
 expect(cachedAccountUsage('native').rows).toMatchObject([{date:'2026-01-01',cwd:'/project',tokens:{total_tokens:10,input_tokens:10,cached_input_tokens:null,output_tokens:0,reasoning_output_tokens:null}}]);
 expect(JSON.parse(vi.mocked(localCommandInput).mock.calls[1][1]).cursors['/fixture/file.jsonl'].offset).toBe(10);
 vi.mocked(localCommandInput).mockRejectedValueOnce(Error('denied'));await collectAccountUsage('native');
 expect(cachedAccountUsage('native')).toMatchObject({partial:true,error:'采集失败，保留上次成功数据'});expect(cachedAccountUsage('native').rows[0].tokens.total_tokens).toBe(10);
});
it('uses each account SSH connection and keeps identical event keys isolated by account',async()=>{
 for(const id of ['a','b'])getDb().prepare("INSERT INTO agent_environments(id,agent_id,name,kind,enabled,config,allowed_user_ids) VALUES(?,'codex',?,'account',1,?,'[]')").run(id,id,JSON.stringify({username:id,port:22,codexCommand:'codex',codexHome:'/home/'+id+'/.codex',identityFile:''}));
 await collectAccountUsage('a');await collectAccountUsage('b');
 expect(accountCommandInput).toHaveBeenCalledWith(expect.objectContaining({username:'a'}),expect.any(String),expect.stringContaining('/home/a/.codex'));
 expect(accountCommandInput).toHaveBeenCalledWith(expect.objectContaining({username:'b'}),expect.any(String),expect.stringContaining('/home/b/.codex'));
 expect(cachedAccountUsage('a').rows[0].tokens.total_tokens).toBe(10);expect(cachedAccountUsage('b').rows[0].tokens.total_tokens).toBe(10);
});
