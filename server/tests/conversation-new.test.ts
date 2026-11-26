vi.mock('../src/services/agents/codex/account-transport.js',async original=>({...await original<typeof import('../src/services/agents/codex/account-transport.js')>(),ensureAccountTransport:vi.fn(async()=>({socket:'/fake-target',home:'/fake-home'})),closeAccountTransport:vi.fn()}));
vi.mock('../src/services/agents/codex/controls.js',()=>({readModelPreference:vi.fn(()=>null),prepareCodexModelRecovery:vi.fn().mockResolvedValue(undefined),readConversationControls:vi.fn(),validateModelPreference:vi.fn(async(value:unknown)=>value)}));
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('../src/services/agents/codex/terminal-bridge.js',()=>({ensureCodexTerminalBridge:vi.fn(async(path:string)=>path)}));
vi.mock('../src/services/agents/codex/version.js',()=>({prepareCodexReload:vi.fn().mockResolvedValue('0.166.0')}));
vi.mock('../src/services/agents/codex/actions.js',()=>({prepareFreshCodexConversation:vi.fn().mockResolvedValue('019ff001-3333-7333-8333-333333333333'),releaseCodexConversation:vi.fn().mockResolvedValue(undefined),compactCodexConversation:vi.fn().mockResolvedValue(undefined)}));
vi.mock('../src/services/agents/codex/stream.js',()=>({interruptStreamingCodexThread:vi.fn().mockResolvedValue(undefined),withCodexConnection:vi.fn(),submitStreamingCodexInput:vi.fn()}));
vi.mock('child_process',async original=>{
 const actual=await original<typeof import('child_process')>(),{EventEmitter}=await import('events');
 return {...actual,fork:vi.fn(()=>{const worker:any=new EventEmitter();worker.connected=true;worker.exitCode=null;worker.signalCode=null;worker.kill=vi.fn(()=>{worker.connected=false;worker.exitCode=0;queueMicrotask(()=>worker.emit('exit',0));});worker.send=vi.fn((message:any)=>{if(message.type==='spawn')queueMicrotask(()=>worker.emit('message',{type:'ready',pid:90000001}));if(message.type==='kill')worker.kill();});queueMicrotask(()=>worker.emit('message',{type:'worker-ready'}));return worker;})};
});
import {fork} from 'child_process';
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import Fastify from 'fastify';
import * as claudeArchive from '../src/services/agents/claude/archive.js';
import {sessionRoutes} from '../src/routes/sessions.js';
import {getDb} from '../src/db/index.js';
import {config} from '../src/config.js';
import {createTestDatabase} from './helpers/database.js';
import {newSessionConversation,getSession,killSession,compactSessionConversation,purgeSessionRecord} from '../src/services/session-manager.js';
import {prepareFreshCodexConversation,releaseCodexConversation,compactCodexConversation} from '../src/services/agents/codex/actions.js';
import {prepareCodexReload} from '../src/services/agents/codex/version.js';
import {readConversationControls,validateModelPreference} from '../src/services/agents/codex/controls.js';
import {getAgent} from '../src/services/agents/index.js';
import {withCodexConnection,submitStreamingCodexInput} from '../src/services/agents/codex/stream.js';
import {ConversationRetryManager,type AgentRetryObserver,type ConversationRetry} from '../src/services/conversation-retry.js';
import {matchesQuotaHandoff,resumeQuotaFailedTurn} from '../src/services/conversation-quota-handoff.js';
import {initAccountStatus} from '../src/services/agents/codex/account-status.js';
import {parseBriefContext} from '../src/shared/conversation-brief.js';
import * as conversationReader from '../src/services/conversation-reader.js';
import {authHook,createUser,createSession as createAuthSession,setProjectToolAccess} from '../src/auth.js';
import {createSessionRecordDeletionWorker,sessionRecordDeletionState} from '../src/services/session-record-deletion.js';
let cleanup:()=>void;
let historyDir:string;
const defaultFresh='019ff001-3333-7333-8333-333333333333';
const rollout=(id:string)=>join(historyDir,`rollout-${id}.jsonl`);
function startCleanupWorker(){
 const worker=createSessionRecordDeletionWorker(id=>purgeSessionRecord(id,{background:true}),error=>{throw error;});
 worker.wake();
 return worker;
}
const saved={useTmux:config.useTmux,useDtach:config.useDtach},native='019ff001-3434-7434-8434-343434343434';
beforeEach(()=>{vi.useFakeTimers({toFake:['setTimeout','clearTimeout','setInterval','clearInterval']});vi.clearAllMocks();const db=createTestDatabase();cleanup=db.cleanup;vi.stubEnv('CODEX_HOME',db.dir);historyDir=join(db.dir,'sessions');mkdirSync(historyDir);config.useTmux=false;config.useDtach=false;vi.stubEnv('AGENTMANAGER_CODEX_STREAM_SOCKET','/fake');getDb().prepare("INSERT INTO projects(id,name,path) VALUES('new-project','New',?)").run(db.dir);getDb().prepare("INSERT INTO sessions(id,project_id,task,status,mode,cli_type,codex_session_id) VALUES('new-test','new-project','Do not submit old task','running','session','codex',?)").run(native);getDb().prepare("INSERT INTO conversation_attachments(session_id,client_id,input_key,input_text,attachments) VALUES('new-test','attachment','k','text','[]')").run();getDb().prepare("INSERT INTO pty_output(session_id,seq,data) VALUES('new-test',1,'old output')").run();});
afterEach(async()=>{await killSession('new-test');vi.clearAllTimers();vi.useRealTimers();vi.unstubAllEnvs();Object.assign(config,saved);cleanup();});
describe('fresh conversation in the same tab',()=>{
 it('rejects a stale native identity before touching the current conversation',async()=>{
  const result=await newSessionConversation('new-test',undefined,undefined,'replaced-native');
  expect(result.ok).toBe(false);expect(result.error).toContain('原生会话已变化');
  expect(prepareCodexReload).not.toHaveBeenCalled();expect(prepareFreshCodexConversation).not.toHaveBeenCalled();expect(fork).not.toHaveBeenCalled();
  expect(getSession('new-test')?.codex_session_id).toBe(native);
 });
 it('does not replace an expected conversation that started running after the send check',async()=>{
  const runtime=vi.spyOn(getAgent('codex').runtime,'read').mockResolvedValue({state:'running'} as any);
  try{
   const result=await newSessionConversation('new-test',undefined,undefined,native);
   expect(result.ok).toBe(false);expect(result.error).toContain('尚未结束');expect(prepareCodexReload).not.toHaveBeenCalled();expect(fork).not.toHaveBeenCalled();
   expect(getSession('new-test')?.codex_session_id).toBe(native);
  }finally{runtime.mockRestore();}
 });
 it.each(['idle','ready'] as const)('creates a fresh conversation when the expected identity is %s',async state=>{
  const runtime=vi.spyOn(getAgent('codex').runtime,'read').mockResolvedValue({state} as any);
  try{
   const result=await newSessionConversation('new-test',undefined,undefined,native);
   expect(result.ok).toBe(true);expect(getSession('new-test')?.codex_session_id).not.toBe(native);expect(prepareFreshCodexConversation).toHaveBeenCalledOnce();
  }finally{runtime.mockRestore();}
 });
 it('rejects a changed source environment even if its native ID is unchanged',async()=>{
  const adapter=getAgent('codex'),runtime=vi.spyOn(adapter.runtime,'read').mockResolvedValue({state:'idle'} as any);
  const discard=vi.spyOn(adapter.lifecycle,'discardFresh').mockResolvedValue();
  vi.mocked(prepareFreshCodexConversation).mockImplementationOnce(async()=>{getDb().prepare("UPDATE sessions SET agent_environment_id='other' WHERE id='new-test'").run();return '019ff001-3333-7333-8333-333333333333';});
  try{const result=await newSessionConversation('new-test',undefined,undefined,native);expect(result).toMatchObject({ok:false,error:'原会话已变化，未发送简要历史'});expect(discard).toHaveBeenCalledOnce();expect(fork).not.toHaveBeenCalled();}
  finally{getDb().prepare("UPDATE sessions SET agent_environment_id=NULL WHERE id='new-test'").run();runtime.mockRestore();discard.mockRestore();}
 });
 it('returns the new tab through HTTP before purging the old Codex rollout and platform history',async()=>{
  writeFileSync(rollout(native),'{}\n');
  writeFileSync(rollout(defaultFresh),'{}\n');
  getDb().prepare("INSERT INTO tasks(id,title,session_id) VALUES('old-task','Old task','new-test')").run();
  const user=createUser({username:'new-owner',password:'password1',role:'admin'});
  getDb().prepare("UPDATE sessions SET created_by_user_id=? WHERE id='new-test'").run(user.id);
  let releaseUsage!:()=>void;
  const preserve=vi.spyOn(getAgent('codex').statistics.facts!,'preserveAccountUsage')
   .mockReturnValueOnce(new Promise(resolve=>{releaseUsage=resolve;}));
  const app=Fastify();
  app.addHook('onRequest',authHook);
  await app.register(sessionRoutes,{prefix:'/api'});
  try{
   const response=await app.inject({method:'POST',url:'/api/sessions/new-test/new-conversation',payload:{},
    headers:{cookie:`agentmanager_session=${createAuthSession(user.id)}`}});
   expect(response.statusCode).toBe(200);
   const result=response.json();
   expect(result).toMatchObject({ok:true,previous_conversation_deletion:'pending',
    session:{id:'new-test',codex_session_id:defaultFresh,status:'running'}});
   expect(getSession(result.history_id)).toMatchObject({codex_session_id:native,status:'cancelled'});
   expect(sessionRecordDeletionState(result.history_id)).toBe('pending');
   expect(existsSync(rollout(native))).toBe(true);
   releaseUsage();
   await vi.waitFor(()=>expect(getSession(result.history_id)).toBeNull());
   expect(getDb().prepare('SELECT id FROM sessions').all()).toEqual([{id:'new-test'}]);
   expect(getDb().prepare('SELECT session_id FROM conversation_attachments').all()).toEqual([]);
   expect(getDb().prepare('SELECT data FROM pty_output').all()).toEqual([]);
   expect(getDb().prepare("SELECT session_id FROM tasks WHERE id='old-task'").get()).toEqual({session_id:null});
   expect(existsSync(rollout(native))).toBe(false);
   expect(existsSync(rollout(defaultFresh))).toBe(true);
   expect(releaseCodexConversation).toHaveBeenCalledWith(native);
   const worker=vi.mocked(fork).mock.results[0].value as any;
   expect(worker.send).toHaveBeenCalledWith(expect.objectContaining({resumeSessionId:defaultFresh}));
   expect(fork).toHaveBeenCalledTimes(1);
  }finally{releaseUsage();await app.close();preserve.mockRestore();}
 });
 it('purges the original Claude log after the managed replacement is ready',async()=>{
  getDb().prepare("UPDATE sessions SET cli_type='claude',codex_session_id=NULL,claude_session_id=? WHERE id='new-test'").run(native);
  const oldFile=join(historyDir,`${native}.jsonl`),newFile=join(historyDir,`${defaultFresh}.jsonl`);
  writeFileSync(oldFile,'{}\n');
  writeFileSync(newFile,'{}\n');
  vi.spyOn(claudeArchive,'resolveClaudeDir').mockReturnValue(historyDir);
  const adapter=getAgent('claude');
  vi.spyOn(adapter.lifecycle,'preflight').mockResolvedValue(null);
  vi.spyOn(adapter.lifecycle,'prepareFresh').mockResolvedValue(defaultFresh);
  vi.spyOn(adapter.launch,'prepare').mockResolvedValue({nativeId:defaultFresh});
  vi.spyOn(adapter.stream,'observe').mockReturnValue(Object.assign(()=>{}, {respond:()=>{}}));
  const result=await newSessionConversation('new-test');
  expect(result).toMatchObject({ok:true,previous_conversation_deletion:'pending'});
  expect(getSession('new-test')).toMatchObject({native_session_id:defaultFresh,status:'running'});
  expect(existsSync(oldFile)).toBe(true);
  const worker=startCleanupWorker();
  try{
   await vi.waitFor(()=>expect(getSession(result.history_id!)).toBeNull());
   expect(existsSync(oldFile)).toBe(false);
   expect(existsSync(newFile)).toBe(true);
  }finally{await worker.close();}
 });
 it('keeps the old conversation and its attachments in project history after scheduled compaction',async()=>{
  writeFileSync(rollout(native),'{}\n');
  const reader=vi.spyOn(getAgent('codex').runtime,'read').mockResolvedValue({state:'idle'} as any);
  try{
   const result=await newSessionConversation('new-test',undefined,undefined,native,undefined,{preserveHistory:true});
   expect(result).toMatchObject({ok:true,history_id:expect.any(String)});
   expect(getSession('new-test')).toMatchObject({status:'running',codex_session_id:defaultFresh});
   expect(getSession(result.history_id!)).toMatchObject({status:'cancelled',codex_session_id:native});
   expect(sessionRecordDeletionState(result.history_id!)).toBeUndefined();
   expect(getDb().prepare('SELECT session_id FROM conversation_attachments').get()).toEqual({session_id:result.history_id});
   expect(existsSync(rollout(native))).toBe(true);
  }finally{reader.mockRestore();}
 });
 it('restores the original thread, file and attachments if the replacement worker fails',async()=>{
  writeFileSync(rollout(native),'{}\n');
  vi.mocked(fork).mockImplementationOnce(()=>{throw Error('worker failed');});
  expect((await newSessionConversation('new-test')).ok).toBe(false);
  expect(getSession('new-test')).toMatchObject({codex_session_id:native,status:'running',task:'Do not submit old task'});
  expect(getDb().prepare('SELECT session_id FROM conversation_attachments').get()).toEqual({session_id:'new-test'});
  expect(getDb().prepare('SELECT count(*) n FROM sessions').get()).toEqual({n:1});
  expect(existsSync(rollout(native))).toBe(true);
 });
 it('keeps a retryable old record when native deletion fails after the switch',async()=>{
  const purge=vi.spyOn(getAgent('codex').identity,'purgeHistory').mockRejectedValueOnce(Error('filesystem unavailable'));
  const result=await newSessionConversation('new-test');
  expect(result).toMatchObject({ok:true,previous_conversation_deletion:'pending'});
  const worker=startCleanupWorker();
  try{
   await vi.waitFor(()=>expect(sessionRecordDeletionState(result.history_id!)).toBe('failed'));
   expect(purge).toHaveBeenCalledOnce();
   expect(getSession('new-test')).toMatchObject({codex_session_id:defaultFresh,status:'running'});
   expect(getSession(result.history_id!)).toMatchObject({codex_session_id:native,status:'cancelled'});
   await expect(purgeSessionRecord(result.history_id!)).resolves.toEqual({ok:true});
   expect(getSession(result.history_id!)).toBeNull();
  }finally{await worker.close();purge.mockRestore();}
 });
 it('rejects a reused native identity without releasing or deleting the source',async()=>{
  writeFileSync(rollout(native),'{}\n');
  vi.mocked(prepareFreshCodexConversation).mockResolvedValueOnce(native);
  expect(await newSessionConversation('new-test')).toMatchObject({ok:false});
  expect(getSession('new-test')).toMatchObject({codex_session_id:native,status:'running'});
  expect(existsSync(rollout(native))).toBe(true);
  expect(releaseCodexConversation).not.toHaveBeenCalled();
  expect(fork).not.toHaveBeenCalled();
 });
 it('removes recovery preferences for the old conversation',async()=>{
  getDb().prepare("INSERT INTO user_ui_state(user_id,key,value) VALUES('owner','session-control:new-test',?)").run(JSON.stringify({model:'old-model',effort:'high',provider:'old-provider'}));
  const result=await newSessionConversation('new-test');
  expect(result).toMatchObject({ok:true,previous_conversation_deletion:'pending'});
  const worker=startCleanupWorker();
  try{
   await vi.waitFor(()=>expect(getSession(result.history_id!)).toBeNull());
   expect(getDb().prepare("SELECT value FROM user_ui_state WHERE key LIKE 'session-control:%'").all()).toEqual([]);
  }finally{await worker.close();}
 });
 it('retains the running conversation when preparation fails',async()=>{vi.mocked(prepareFreshCodexConversation).mockRejectedValueOnce(Error('prepare failed'));expect(await newSessionConversation('new-test')).toMatchObject({ok:false,error:'prepare failed'});expect(getSession('new-test')).toMatchObject({status:'running',codex_session_id:native});expect(fork).not.toHaveBeenCalled();expect(getDb().prepare('SELECT count(*) n FROM sessions').get()).toEqual({n:1});});
 it('restores adapter-owned settings when preparing the new conversation fails',async()=>{
  const lifecycle=getAgent('codex').lifecycle,previous=lifecycle.freshRollback,restore=vi.fn();
  lifecycle.freshRollback=()=>restore;vi.mocked(prepareFreshCodexConversation).mockRejectedValueOnce(Error('prepare failed'));
  try{expect((await newSessionConversation('new-test')).ok).toBe(false);expect(restore).toHaveBeenCalledOnce();}
  finally{lifecycle.freshRollback=previous;}
 });
 it('validates a fresh model without loading the full session controls view',async()=>{
  const preference={model:'fixture-model',effort:'high'};
  const result=await newSessionConversation('new-test',preference);expect(result.ok).toBe(true);expect(readConversationControls).not.toHaveBeenCalled();expect(validateModelPreference).toHaveBeenCalledWith(preference,true);expect(vi.mocked(prepareFreshCodexConversation).mock.calls[0][3]).toEqual(preference);
 });
 it('does not replace the current session when fresh model validation fails',async()=>{
  vi.mocked(validateModelPreference).mockRejectedValueOnce(Error('invalid model'));
  expect(await newSessionConversation('new-test',{model:'missing',effort:'high'})).toMatchObject({ok:false,error:'invalid model'});expect(prepareFreshCodexConversation).not.toHaveBeenCalled();expect(getSession('new-test')).toMatchObject({status:'running',codex_session_id:native});
 });
 it('keeps the controls fallback for adapters without a static declaration',async()=>{
  const lifecycle=getAgent('codex').lifecycle,previous=lifecycle.supportsFreshModel;
  lifecycle.supportsFreshModel=undefined;vi.mocked(readConversationControls).mockResolvedValueOnce({supports_fresh_model:true} as any);
  try{expect((await newSessionConversation('new-test',{model:'fixture-model',effort:'high'})).ok).toBe(true);expect(readConversationControls).toHaveBeenCalledOnce();}
  finally{lifecycle.supportsFreshModel=previous;}
 });
 it('serializes new and compact requests before affecting runtimes',async()=>{let release!:(v:string)=>void,entered!:()=>void;const ready=new Promise<void>(r=>entered=r);vi.mocked(prepareCodexReload).mockImplementationOnce(()=>new Promise(r=>{release=r;entered();}));const first=newSessionConversation('new-test');await ready;expect((await newSessionConversation('new-test')).ok).toBe(false);expect((await compactSessionConversation('new-test')).ok).toBe(false);release('0.166.0');expect((await first).ok).toBe(true);expect(fork).toHaveBeenCalledTimes(1);});
 it('compacts through the native action without creating or replacing a thread',async()=>{expect((await compactSessionConversation('new-test')).ok).toBe(true);expect(compactCodexConversation).toHaveBeenCalledWith(native);expect(fork).not.toHaveBeenCalled();expect(getSession('new-test')?.codex_session_id).toBe(native);});
});

describe('environment replacement lifecycle',()=>{
 const fresh='019ff001-4444-7444-8444-444444444444';
 function target(){getDb().prepare("INSERT INTO agent_environments(id,agent_id,name,kind,enabled,config,allowed_user_ids) VALUES('account:fixture','codex','Fixture','account',1,?, '[]')").run(JSON.stringify({username:'fixture',port:22,identityFile:'',codexCommand:'codex',codexHome:''}));}
 it('commits environment and native identity together, keeping source history and attachments',async()=>{
  target();const prepare=vi.fn(async()=>fresh);const result=await newSessionConversation('new-test',undefined,{environmentId:'account:fixture',prepare});
  expect(result.error).toBeUndefined();expect(result).toMatchObject({ok:true});expect(getSession('new-test')).toMatchObject({agent_environment_id:'account:fixture',codex_session_id:fresh,task:'Do not submit old task'});
  expect(getSession(result.history_id!)).toMatchObject({agent_environment_id:null,codex_session_id:native});
  expect(getDb().prepare('SELECT session_id FROM conversation_attachments ORDER BY session_id').all()).toEqual(expect.arrayContaining([{session_id:'new-test'},{session_id:result.history_id}]));
  expect(prepareFreshCodexConversation).not.toHaveBeenCalled();
 });
 it('restores source environment, native identity and attachments when target activation fails',async()=>{
  target();vi.mocked(fork).mockImplementationOnce(()=>{throw Error('target worker unavailable');});
  const result=await newSessionConversation('new-test',undefined,{environmentId:'account:fixture',prepare:async()=>fresh});expect(result.ok).toBe(false);
  expect(getSession('new-test')).toMatchObject({agent_environment_id:null,codex_session_id:native,status:'running'});
  expect(getDb().prepare('SELECT session_id FROM conversation_attachments').all()).toEqual([{session_id:'new-test'}]);
  expect(getDb().prepare('SELECT count(*) n FROM sessions').get()).toEqual({n:1});
 });
});

it('creates an empty conversation in the selected account without copying old attachments',async()=>{
 const user=createUser({username:'brief-owner',password:'password1',role:'admin'}).id;
 getDb().prepare('UPDATE sessions SET created_by_user_id=? WHERE id=?').run(user,'new-test');
 getDb().prepare("INSERT INTO agent_environments(id,agent_id,name,kind,enabled,config,allowed_user_ids) VALUES('account:brief','codex','Brief','account',1,?, '[]')").run(JSON.stringify({username:'fixture',port:22,identityFile:'',codexCommand:'codex',codexHome:''}));
 const adapter=getAgent('codex'),runtime=vi.spyOn(adapter.runtime,'read').mockResolvedValue({state:'idle'} as any);
 const prepare=vi.spyOn(adapter.lifecycle,'prepareFreshInEnvironment').mockResolvedValue('019ff001-4444-7444-8444-444444444444');
 try{
  const preference={model:'fixture-model',effort:'high'};
  const result=await newSessionConversation('new-test',preference,undefined,native,'account:brief');
  expect(result).toMatchObject({ok:true});expect(prepare).toHaveBeenCalledOnce();
  expect(prepare.mock.calls[0][1]).toBe('account:brief');expect(prepare.mock.calls[0][3]).toEqual(preference);
  expect(getSession('new-test')?.agent_environment_id).toBe('account:brief');
  expect(result).toMatchObject({previous_conversation_deletion:'pending'});
  expect(getSession(result.history_id!)).toMatchObject({native_session_id:native,agent_environment_id:null});
  const worker=startCleanupWorker();
  try{
   await vi.waitFor(()=>expect(getSession(result.history_id!)).toBeNull());
   expect(getDb().prepare('SELECT id FROM sessions').all()).toEqual([{id:'new-test'}]);
   expect(getDb().prepare('SELECT session_id FROM conversation_attachments').all()).toEqual([]);
  }finally{await worker.close();}
 }finally{runtime.mockRestore();prepare.mockRestore();}
});

it('rejects an unauthorized target account before preparing a conversation',async()=>{
 const user=createUser({username:'brief-member',password:'password1'}).id;
 getDb().prepare('UPDATE sessions SET created_by_user_id=? WHERE id=?').run(user,'new-test');
 getDb().prepare("INSERT INTO agent_environments(id,agent_id,name,kind,enabled,config,allowed_user_ids) VALUES('account:private','codex','Private','account',1,'{}','[]')").run();
 const prepare=vi.spyOn(getAgent('codex').lifecycle,'prepareFreshInEnvironment');
 try{
  const result=await newSessionConversation('new-test',undefined,undefined,native,'account:private');
  expect(result.ok).toBe(false);expect(prepare).not.toHaveBeenCalled();
  expect(getSession('new-test')).toMatchObject({codex_session_id:native,agent_environment_id:null});
 }finally{prepare.mockRestore();}
});

it('restores the source binding and discards the target if target startup fails',async()=>{
 const user=createUser({username:'brief-rollback',password:'password1',role:'admin'}).id;
 getDb().prepare('UPDATE sessions SET created_by_user_id=? WHERE id=?').run(user,'new-test');
 getDb().prepare("INSERT INTO agent_environments(id,agent_id,name,kind,enabled,config,allowed_user_ids) VALUES('account:rollback','codex','Rollback','account',1,?, '[]')").run(JSON.stringify({username:'fixture',port:22,identityFile:'',codexCommand:'codex',codexHome:''}));
 const adapter=getAgent('codex'),runtime=vi.spyOn(adapter.runtime,'read').mockResolvedValue({state:'idle'} as any);
 const prepare=vi.spyOn(adapter.lifecycle,'prepareFreshInEnvironment').mockResolvedValue('019ff001-4444-7444-8444-444444444444');
 const discard=vi.spyOn(adapter.lifecycle,'discardFresh').mockResolvedValue();
 vi.mocked(fork).mockImplementationOnce(()=>{throw Error('target startup failed');});
 try{
  const result=await newSessionConversation('new-test',undefined,undefined,native,'account:rollback');
  expect(result.ok).toBe(false);expect(discard).toHaveBeenCalledOnce();
  expect(getSession('new-test')).toMatchObject({codex_session_id:native,agent_environment_id:null});
  expect(getDb().prepare('SELECT session_id FROM conversation_attachments').all()).toEqual([{session_id:'new-test'}]);
 }finally{runtime.mockRestore();prepare.mockRestore();discard.mockRestore();}
});

it('does not replace a conversation that starts running while the target is prepared',async()=>{
 const user=createUser({username:'brief-race',password:'password1',role:'admin'}).id;
 getDb().prepare('UPDATE sessions SET created_by_user_id=? WHERE id=?').run(user,'new-test');
 getDb().prepare("INSERT INTO agent_environments(id,agent_id,name,kind,enabled,config,allowed_user_ids) VALUES('account:race','codex','Race','account',1,?, '[]')").run(JSON.stringify({username:'fixture',port:22,identityFile:'',codexCommand:'codex',codexHome:''}));
 const adapter=getAgent('codex'),runtime=vi.spyOn(adapter.runtime,'read').mockResolvedValueOnce({state:'idle'} as any).mockResolvedValueOnce({state:'running'} as any);
 const prepare=vi.spyOn(adapter.lifecycle,'prepareFreshInEnvironment').mockResolvedValue('019ff001-4444-7444-8444-444444444444');
 const discard=vi.spyOn(adapter.lifecycle,'discardFresh').mockResolvedValue();
 try{
  const result=await newSessionConversation('new-test',undefined,undefined,native,'account:race');
  expect(result).toMatchObject({ok:false,error:'准备期间原会话开始运行，未发送简要历史'});
  expect(discard).toHaveBeenCalledOnce();expect(getSession('new-test')?.codex_session_id).toBe(native);expect(fork).not.toHaveBeenCalled();
 }finally{runtime.mockRestore();prepare.mockRestore();discard.mockRestore();}
});

it('resumes the latest quota failure on the backup account after native queue consumption',async()=>{
 const db=getDb(),adapter=getAgent('codex'),owner=createUser({username:'quota-owner',password:'password1',role:'admin'}).id;
 const target='account:quota-backup',queuedClient='queued-client',latestTurn='quota-follow-up';
 db.prepare("UPDATE sessions SET created_by_user_id=? WHERE id='new-test'").run(owner);
 db.prepare("UPDATE projects SET owner_id=? WHERE id='new-project'").run(owner);
 setProjectToolAccess({projectId:'new-project',userId:owner,canSession:true,canTerminal:true,sessionClients:['codex'],grantedBy:owner});
 db.prepare("INSERT INTO agent_environments(id,agent_id,name,kind,enabled,config,allowed_user_ids) VALUES(?,'codex','Backup','account',1,?, '[]')")
   .run(target,JSON.stringify({username:'quota-backup',port:22,codexHome:'/fixture/backup'}));
 initAccountStatus();
 const sample=db.prepare('INSERT INTO codex_account_status(account,identity,data,checked_at) VALUES(?,?,?,?)');
 const reset=Date.now()/1000+3600;
 sample.run('native',JSON.stringify(['native',process.env.CODEX_HOME]),JSON.stringify({account:{email:'depleted@example.invalid'},windows:[{usedPercent:100,resetsAt:reset}]}),new Date().toISOString());
 sample.run(target,JSON.stringify(['quota-backup','/fixture/backup']),JSON.stringify({account:{email:'funded@example.invalid'},windows:[{usedPercent:38,resetsAt:reset}]}),new Date().toISOString());
 db.prepare('INSERT INTO agent_queued_inputs VALUES(?,?,?,?)').run('codex','/fake',native,queuedClient);
 writeFileSync(rollout(native),'{}\n');
 const originalError={codexErrorInfo:'usageLimitExceeded',message:"You've hit your usage limit."};
 const latest={id:latestTurn,status:'failed',error:originalError,items:[{type:'userMessage',clientId:queuedClient}]};
 let firstRead=true;
 vi.mocked(withCodexConnection).mockImplementation(action=>action(async method=>{
   if(method==='thread/read')return {thread:{status:{type:'systemError'}}};
   if(method==='thread/queue/list')return {data:[]};
   if(method==='thread/turns/list'){
     const turn=firstRead?{...latest,error:undefined}:latest;
     firstRead=false;
     return {data:[turn]};
   }
   throw Error(method);
 },{userAgent:null}));
 vi.mocked(submitStreamingCodexInput).mockResolvedValue(true);
 const runtime=vi.spyOn(adapter.runtime,'read').mockResolvedValue({state:'failed'} as Awaited<ReturnType<typeof adapter.runtime.read>>);
 const prepare=vi.spyOn(adapter.lifecycle,'prepareFreshInEnvironment').mockResolvedValue(defaultFresh);
 const history=vi.spyOn(conversationReader,'readConversation').mockResolvedValue({available:true,has_more:false,reset:false,generation:'source',
   messages:[{id:'queued-user',role:'user',text:'执行已排队的检查',timestamp:null,turn_id:latestTurn,client_id:queuedClient}],statistics:[],metadata:null,cache_drops:[]});
 let onFailure:Parameters<AgentRetryObserver>[2];
 const retries=new ConversationRetryManager(db,{
   allowed:(id,_user,expected)=>getSession(id)?.codex_session_id===expected,
   observe:(_id,_emit,callback)=>{onFailure=callback;return Object.assign(()=>{}, {respond:()=>{}});},
   quotaHandoff:{matches:(id,error)=>matchesQuotaHandoff(getSession(id)!,error),run:resumeQuotaFailedTurn},
 });
 try{
  retries.monitor('new-test',owner,native);
  onFailure!(latestTurn,originalError,false);
  onFailure!(latestTurn,originalError,false);
  const row=()=>db.prepare('SELECT data FROM conversation_retries WHERE root_turn_id=?').get(latestTurn) as {data:string};
  await vi.waitFor(()=>expect(JSON.parse(row().data).status).toBe('succeeded'),{timeout:3000});
  const job:ConversationRetry=JSON.parse(row().data);
  expect(getSession('new-test')).toMatchObject({codex_session_id:defaultFresh,agent_environment_id:target,status:'running'});
  expect(db.prepare('SELECT status,agent_environment_id FROM sessions WHERE codex_session_id=?').get(native)).toEqual({status:'cancelled',agent_environment_id:null});
  expect(db.prepare('SELECT 1 FROM agent_queued_inputs').all()).toEqual([]);
  expect(existsSync(rollout(native))).toBe(true);
  expect(prepare).toHaveBeenCalledOnce();
  expect(submitStreamingCodexInput).toHaveBeenCalledExactlyOnceWith(defaultFresh,expect.any(String),job.client_id,undefined,expect.any(Function),undefined,true);
  expect(parseBriefContext(vi.mocked(submitStreamingCodexInput).mock.calls[0][1])).toMatchObject({
    context:{turns:[{input:'执行已排队的检查'}]},input:expect.stringContaining('避免重复执行'),
  });
 }finally{retries.close();history.mockRestore();runtime.mockRestore();prepare.mockRestore();}
});
