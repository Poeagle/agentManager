import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('../src/services/codex-version.js',()=>({prepareCodexReload:vi.fn().mockResolvedValue('0.166.0')}));
vi.mock('child_process',async original=>{
 const actual=await original<typeof import('child_process')>(),{EventEmitter}=await import('events');let serial=0;
 return {...actual,fork:vi.fn(()=>{const worker:any=new EventEmitter();worker.connected=true;worker.exitCode=null;worker.signalCode=null;worker.kill=vi.fn(()=>{worker.connected=false;worker.exitCode=0;queueMicrotask(()=>worker.emit('exit',0));});worker.send=vi.fn((message:any)=>{if(message.type==='spawn')queueMicrotask(()=>worker.emit('message',{type:'ready',pid:90000000+(serial++)}));if(message.type==='kill')worker.kill();});queueMicrotask(()=>worker.emit('message',{type:'worker-ready'}));return worker;})};
});
import {fork} from 'child_process';
import {getDb} from '../src/db/index.js';
import {config} from '../src/config.js';
import {createTestDatabase} from './helpers/database.js';
import {reloadCodexSessionById,getSession,killSession,purgeSessionRecord} from '../src/services/session-manager.js';
import {prepareCodexReload} from '../src/services/codex-version.js';
let cleanup:()=>void;
const saved={useTmux:config.useTmux,useDtach:config.useDtach},native='019ff001-3434-7434-8434-343434343434';
beforeEach(()=>{vi.useFakeTimers({toFake:['setTimeout','clearTimeout','setInterval','clearInterval']});vi.clearAllMocks();vi.mocked(prepareCodexReload).mockResolvedValue('0.166.0');const db=createTestDatabase();cleanup=db.cleanup;config.useTmux=false;config.useDtach=false;vi.stubEnv('AGENTMANAGER_CODEX_STREAM_SOCKET','');getDb().prepare("INSERT INTO projects(id,name,path) VALUES('reload-project','Reload',?)").run(db.dir);getDb().prepare("INSERT INTO sessions(id,project_id,task,status,mode,cli_type,codex_session_id) VALUES('reload-test','reload-project','Do not submit this old task','running','session','codex',?)").run(native);getDb().prepare("INSERT INTO conversation_attachments(session_id,client_id,input_key,input_text,attachments) VALUES('reload-test','attachment','k','text','[]')").run();});
afterEach(async()=>{await killSession('reload-test');vi.clearAllTimers();vi.useRealTimers();vi.unstubAllEnvs();Object.assign(config,saved);cleanup();});
describe('explicit tab reload',()=>{
 it('restarts one terminal on the same native thread and preserves its record and attachments',async()=>{
  expect(await reloadCodexSessionById('reload-test')).toMatchObject({ok:true,client_version:'0.166.0'});expect(getSession('reload-test')).toMatchObject({id:'reload-test',codex_session_id:native,status:'running'});const worker=vi.mocked(fork).mock.results[0].value as any;expect(worker.send).toHaveBeenCalledWith(expect.objectContaining({type:'spawn',resumeSessionId:native}));expect(getDb().prepare("SELECT count(*) n FROM conversation_attachments WHERE session_id='reload-test'").get()).toEqual({n:1});expect(fork).toHaveBeenCalledTimes(1);
 });
 it('shares duplicate reload requests and does not fork duplicate clients',async()=>{
  const [a,b]=await Promise.all([reloadCodexSessionById('reload-test'),reloadCodexSessionById('reload-test')]);expect(a).toEqual(b);expect(a.ok).toBe(true);expect(fork).toHaveBeenCalledTimes(1);
 });
 it('preserves the running session when installed and engine versions cannot be matched',async()=>{
  vi.mocked(prepareCodexReload).mockRejectedValueOnce(new Error('请先升级共享服务'));expect(await reloadCodexSessionById('reload-test')).toMatchObject({ok:false,error:'请先升级共享服务'});expect(getSession('reload-test')?.status).toBe('running');expect(fork).not.toHaveBeenCalled();
 });
 it('cancels a reload if the user closes it while the version check is in flight',async()=>{
  let release!:(version:string)=>void,entered!:()=>void;const ready=new Promise<void>(resolve=>entered=resolve);vi.mocked(prepareCodexReload).mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;entered();}));const reload=reloadCodexSessionById('reload-test');await ready;await killSession('reload-test');expect(purgeSessionRecord('reload-test').ok).toBe(false);release('0.166.0');expect((await reload).ok).toBe(false);expect(fork).not.toHaveBeenCalled();expect(getSession('reload-test')?.status).toBe('cancelled');expect(purgeSessionRecord('reload-test').ok).toBe(true);
 });
});
