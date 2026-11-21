vi.mock('../src/services/agents/codex/account-transport.js',async original=>({...await original<typeof import('../src/services/agents/codex/account-transport.js')>(),ensureAccountTransport:vi.fn(async()=>({socket:'/fake-target',home:'/fake-home'})),closeAccountTransport:vi.fn()}));
vi.mock('../src/services/agents/codex/controls.js',()=>({readModelPreference:vi.fn(()=>null),prepareCodexModelRecovery:vi.fn().mockResolvedValue(undefined),readConversationControls:vi.fn(),validateModelPreference:vi.fn(async(value:unknown)=>value)}));
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('../src/services/agents/codex/terminal-bridge.js',()=>({ensureCodexTerminalBridge:vi.fn(async(path:string)=>path)}));
vi.mock('../src/services/agents/codex/version.js',()=>({prepareCodexReload:vi.fn().mockResolvedValue('0.166.0')}));
vi.mock('../src/services/agents/codex/actions.js',()=>({prepareFreshCodexConversation:vi.fn().mockResolvedValue('019ff001-3333-7333-8333-333333333333'),releaseCodexConversation:vi.fn().mockResolvedValue(undefined),compactCodexConversation:vi.fn().mockResolvedValue(undefined)}));
vi.mock('../src/services/agents/codex/stream.js',()=>({interruptStreamingCodexThread:vi.fn().mockResolvedValue(undefined)}));
vi.mock('child_process',async original=>{
 const actual=await original<typeof import('child_process')>(),{EventEmitter}=await import('events');
 return {...actual,fork:vi.fn(()=>{const worker:any=new EventEmitter();worker.connected=true;worker.exitCode=null;worker.signalCode=null;worker.kill=vi.fn(()=>{worker.connected=false;worker.exitCode=0;queueMicrotask(()=>worker.emit('exit',0));});worker.send=vi.fn((message:any)=>{if(message.type==='spawn')queueMicrotask(()=>worker.emit('message',{type:'ready',pid:90000001}));if(message.type==='kill')worker.kill();});queueMicrotask(()=>worker.emit('message',{type:'worker-ready'}));return worker;})};
});
import {fork} from 'child_process';
import {getDb} from '../src/db/index.js';
import {config} from '../src/config.js';
import {createTestDatabase} from './helpers/database.js';
import {newSessionConversation,getSession,killSession,compactSessionConversation} from '../src/services/session-manager.js';
import {prepareFreshCodexConversation,releaseCodexConversation,compactCodexConversation} from '../src/services/agents/codex/actions.js';
import {prepareCodexReload} from '../src/services/agents/codex/version.js';
import {readConversationControls,validateModelPreference} from '../src/services/agents/codex/controls.js';
import {getAgent} from '../src/services/agents/index.js';
import {createUser} from '../src/auth.js';
let cleanup:()=>void;
const saved={useTmux:config.useTmux,useDtach:config.useDtach},native='019ff001-3434-7434-8434-343434343434';
beforeEach(()=>{vi.useFakeTimers({toFake:['setTimeout','clearTimeout','setInterval','clearInterval']});vi.clearAllMocks();const db=createTestDatabase();cleanup=db.cleanup;config.useTmux=false;config.useDtach=false;vi.stubEnv('AGENTMANAGER_CODEX_STREAM_SOCKET','/fake');getDb().prepare("INSERT INTO projects(id,name,path) VALUES('new-project','New',?)").run(db.dir);getDb().prepare("INSERT INTO sessions(id,project_id,task,status,mode,cli_type,codex_session_id) VALUES('new-test','new-project','Do not submit old task','running','session','codex',?)").run(native);getDb().prepare("INSERT INTO conversation_attachments(session_id,client_id,input_key,input_text,attachments) VALUES('new-test','attachment','k','text','[]')").run();getDb().prepare("INSERT INTO pty_output(session_id,seq,data) VALUES('new-test',1,'old output')").run();});
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
 it('creates a fresh conversation when the expected identity is still idle',async()=>{
  const runtime=vi.spyOn(getAgent('codex').runtime,'read').mockResolvedValue({state:'idle'} as any);
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
 it('preserves history and attachments under a history row, replaces only native id and resumes without submitting old task',async()=>{
  const result=await newSessionConversation('new-test');expect(result.ok).toBe(true);expect(getSession('new-test')).toMatchObject({id:'new-test',codex_session_id:'019ff001-3333-7333-8333-333333333333',status:'running'});expect(getSession(result.history_id!)).toMatchObject({codex_session_id:native,status:'cancelled',pid:null});expect(getDb().prepare('SELECT session_id FROM conversation_attachments').get()).toEqual({session_id:result.history_id});expect(getDb().prepare('SELECT data FROM pty_output WHERE session_id=?').get(result.history_id)).toEqual({data:'old output'});expect(releaseCodexConversation).toHaveBeenCalledWith(native);const worker=vi.mocked(fork).mock.results[0].value as any;expect(worker.send).toHaveBeenCalledWith(expect.objectContaining({resumeSessionId:'019ff001-3333-7333-8333-333333333333'}));expect(fork).toHaveBeenCalledTimes(1);
 });
 it('restores the original native thread and attachment ownership if the replacement worker fails',async()=>{vi.mocked(fork).mockImplementationOnce(()=>{throw Error('worker failed');});expect((await newSessionConversation('new-test')).ok).toBe(false);expect(getSession('new-test')).toMatchObject({codex_session_id:native,status:'running',task:'Do not submit old task'});expect(getDb().prepare('SELECT session_id FROM conversation_attachments').get()).toEqual({session_id:'new-test'});expect(getDb().prepare('SELECT count(*) n FROM sessions').get()).toEqual({n:1});});
 it('moves saved recovery preferences into old history so they cannot override a fresh provider thread',async()=>{
  getDb().prepare("INSERT INTO user_ui_state(user_id,key,value) VALUES('owner','session-control:new-test',?)").run(JSON.stringify({model:'old-model',effort:'high',provider:'old-provider'}));
  const result=await newSessionConversation('new-test');expect(result.ok).toBe(true);
  expect(getDb().prepare("SELECT value FROM user_ui_state WHERE key='session-control:new-test'").get()).toBeUndefined();
  expect(getDb().prepare('SELECT value FROM user_ui_state WHERE key=?').get(`session-control:${result.history_id}`)).toMatchObject({value:JSON.stringify({model:'old-model',effort:'high',provider:'old-provider'})});
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
  expect(getSession(result.history_id!)?.agent_environment_id).toBeNull();
  expect(getDb().prepare('SELECT session_id FROM conversation_attachments').all()).toEqual([{session_id:result.history_id}]);
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
