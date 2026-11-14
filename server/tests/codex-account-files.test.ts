import {mkdir,writeFile,readFile,stat,access,symlink,truncate} from 'fs/promises';
import {join} from 'path';
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {createTestDatabase} from './helpers/database.js';
const fixture=vi.hoisted(()=>({home:'',path:'',native:false,error:null as Error|null,command:vi.fn()}));
vi.mock('../src/services/agents/codex/engine-context.js',()=>({engineForThread:vi.fn(async()=>fixture.native?{socket:'/fixture/socket'}:{environmentId:'account:fixture',accountHome:fixture.home,socket:'/fixture/socket'}),runInCodexEngine:(_engine:unknown,action:()=>unknown)=>action()}));
vi.mock('../src/services/agents/codex/environments.js',()=>({environmentConnection:(e:any)=>e.connection,getCodexEnvironment:(id:string)=>id==='native'?{id,kind:'native'}:{id,kind:'account',connection:{username:'fixture',port:22,identityFile:'',codexCommand:'codex',codexHome:fixture.home}}}));
vi.mock('../src/services/agents/codex/stream.js',()=>({CodexRpcError:class extends Error{nativeMessage:string;constructor(message:string){super(message);this.nativeMessage=message;}},withCodexConnection:async(action:any)=>action(async()=>{if(fixture.error)throw fixture.error;return {thread:{path:fixture.path}};})}));
vi.mock('../src/services/agents/codex/account-transport.js',()=>({accountCommand:fixture.command,sshArguments:vi.fn()}));
import {environmentRollout,stageEnvironmentHistory,publishHistoryMirror} from '../src/services/agents/codex/account-files.js';
let db:ReturnType<typeof createTestDatabase>;
const native='019ff001-9999-7999-8999-999999999999',context={nativeId:native,session:{agent_environment_id:'account:fixture'}};
beforeEach(async()=>{vi.clearAllMocks();fixture.native=false;fixture.error=null;db=createTestDatabase();fixture.home=join(db.dir,'home');vi.stubEnv('CODEX_HOME',fixture.home);await mkdir(join(fixture.home,'sessions'),{recursive:true});fixture.path=join(fixture.home,'sessions','rollout-'+native+'.jsonl');await writeFile(fixture.path,'FULL NATIVE HISTORY\n');fixture.command.mockRejectedValue(Error('history_access: history outside target sessions'));});
afterEach(()=>{vi.unstubAllEnvs();db.cleanup();});
describe('account history file boundaries',()=>{
 it('preserves the mirror generation for appended turns so loaded older pages remain visible',async()=>{const before=await stat(fixture.path);const temporary=fixture.path+'.new';await writeFile(temporary,'FULL NATIVE HISTORY\nNEW TURN\n');await publishHistoryMirror(temporary,fixture.path);expect((await stat(fixture.path)).ino).toBe(before.ino);expect(await readFile(fixture.path,'utf8')).toBe('FULL NATIVE HISTORY\nNEW TURN\n');await expect(access(temporary)).rejects.toThrow();});
 it('changes the mirror generation for an actual transcript rewrite so removed content is not retained',async()=>{const before=await stat(fixture.path);const temporary=fixture.path+'.new';await writeFile(temporary,'REWRITTEN HISTORY\n');await publishHistoryMirror(temporary,fixture.path);expect((await stat(fixture.path)).ino).not.toBe(before.ino);expect(await readFile(fixture.path,'utf8')).toBe('REWRITTEN HISTORY\n');});
 it('returns no history for an unloaded account thread without hiding other RPC failures',async()=>{
  const {CodexRpcError}=await import('../src/services/agents/codex/stream.js');
  fixture.error=new CodexRpcError(`thread not loaded: ${native}`);expect(await environmentRollout(context)).toBeNull();
  fixture.error=new CodexRpcError('account access denied');await expect(environmentRollout(context)).rejects.toThrow('account access denied');
 });
 it('reads an explicitly bound rollout inside the account sessions root without broadening permissions',async()=>{expect(await environmentRollout(context)).toBe(fixture.path);expect(fixture.command).not.toHaveBeenCalled();});
 it('expands native paginated fork ancestry into the same public history',async()=>{
  fixture.native=true;const parent='019ff001-1111-7111-8111-111111111111';
  const line=(ordinal:number,type:string,payload:unknown)=>JSON.stringify({ordinal,type,payload})+'\n';
  const prefix=line(0,'session_meta',{id:parent})+line(1,'event_msg',{type:'user_message',message:'earlier message'});
  await writeFile(join(fixture.home,'sessions',`rollout-${parent}.jsonl`),prefix+line(2,'event_msg',{type:'user_message',message:'other branch'}));
  const child=line(2,'session_meta',{id:native,history_base:{thread_id:parent,end_byte_offset:Buffer.byteLength(prefix),end_ordinal_exclusive:2}})+line(3,'event_msg',{type:'agent_message',message:'continued answer'});
  await writeFile(fixture.path,child);
  const path=await environmentRollout({nativeId:native,session:{agent_environment_id:'native'}});
  expect(path).not.toBe(fixture.path);expect(await readFile(path!,'utf8')).toBe(prefix+child);
 });
 it('rejects a readable rollout outside the account directory',async()=>{fixture.path=join(db.dir,'other-account-'+native+'.jsonl');await writeFile(fixture.path,'PRIVATE OTHER ACCOUNT');await expect(environmentRollout(context)).rejects.toThrow('history_access');expect(fixture.command).toHaveBeenCalledOnce();});
 it('rejects a sessions symlink that resolves to another directory',async()=>{const outside=join(db.dir,'outside-'+native+'.jsonl');await writeFile(outside,'PRIVATE');fixture.path=join(fixture.home,'sessions','link-'+native+'.jsonl');await symlink(outside,fixture.path);await expect(environmentRollout(context)).rejects.toThrow('history_access');});
 it('never treats credentials as a conversation rollout',async()=>{fixture.path=join(fixture.home,'auth.json');expect(await environmentRollout(context)).toBeNull();expect(fixture.command).not.toHaveBeenCalled();});
 it('stages an independent owner-only copy and removes only the staging file',async()=>{const source=fixture.path;const staged=await stageEnvironmentHistory('native',source);expect(await readFile(staged.path,'utf8')).toBe('FULL NATIVE HISTORY\n');expect((await stat(staged.path)).mode&0o777).toBe(0o600);await staged.cleanup();await expect(access(staged.path)).rejects.toThrow();expect(await readFile(source,'utf8')).toBe('FULL NATIVE HISTORY\n');});
 it('rejects oversized history before making a staging copy',async()=>{await truncate(fixture.path,1024*1024*1024+1);await expect(stageEnvironmentHistory('native',fixture.path)).rejects.toThrow('1 GiB');});
});
