import {readFile,writeFile,copyFile,unlink} from 'fs/promises';
import {join} from 'path';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createTestDatabase} from './helpers/database.js';
import {createUser} from '../src/auth.js';
import {getDb} from '../src/db/index.js';
import {saveCodexEnvironment} from '../src/services/agents/codex/environments.js';
import {currentCodexEngine} from '../src/services/agents/codex/engine-context.js';
import {transferCodexEnvironment} from '../src/services/agents/codex/environment-transfer.js';
import {usageOrigins} from '../src/services/agents/codex/usage-provenance.js';
const fixture=vi.hoisted(()=>({sourceFile:'',targetFile:'',cleanup:vi.fn(),rpc:vi.fn(),lifecycle:vi.fn()}));
vi.mock('../src/services/agents/codex/history-bundle.js',()=>({omitAdditionalToolsForEndpoint:vi.fn(()=>false),preparePagedHistory:vi.fn(async()=>{await copyFile(fixture.sourceFile,fixture.targetFile);return {path:fixture.targetFile,importedIds:['import-parent'],finish:async(keep:boolean)=>fixture.cleanup(keep)};})}));
vi.mock('../src/services/agents/codex/account-transport.js',async original=>({...await original<typeof import('../src/services/agents/codex/account-transport.js')>(),ensureAccountTransport:vi.fn(async(id:string)=>({socket:'/fixture/'+id,home:'/fixture/home'})),closeAccountTransport:vi.fn(),checkAccountProject:vi.fn(),accountCommand:vi.fn()}));
vi.mock('../src/services/agents/codex/controls.js',()=>({readEngineModelsForEnvironment:vi.fn(async()=>[{model:'fixture-model',provider:'openai',efforts:[{value:'high'}],defaultEffort:'high'}])}));
vi.mock('../src/services/prompt-context.js',()=>({findCodexRollout:vi.fn(async()=>fixture.sourceFile)}));
vi.mock('../src/services/agents/codex/account-files.js',()=>({stageEnvironmentHistory:vi.fn(async()=>{await copyFile(fixture.sourceFile,fixture.targetFile);return {path:fixture.targetFile,cleanup:async()=>{fixture.cleanup();await unlink(fixture.targetFile);}};})}));
vi.mock('../src/services/agents/codex/stream.js',()=>({withCodexConnection:vi.fn(async(action:any)=>action(fixture.rpc))}));
vi.mock('../src/services/session-manager.js',()=>({getSession:(id:string)=>getDb().prepare('SELECT * FROM sessions WHERE id=?').get(id),newSessionConversation:async(_id:string,_preference:unknown,replacement:any)=>{fixture.lifecycle();try{await replacement.prepare({projectPath:'/fixture/project'});return {ok:true};}catch(e){return {ok:false,error:(e as Error).message};}}}));
let db:ReturnType<typeof createTestDatabase>,owner:string,sourceId:string,targetId:string;
const native='019ff001-1111-7111-8111-111111111111',fresh='019ff001-2222-7222-8222-222222222222';
const preference={model:'fixture-model',provider:'openai',effort:'high'};
let active:boolean,paginated:boolean,failResume:boolean,dropHistory:boolean,reads:number;
beforeEach(async()=>{
 vi.clearAllMocks();db=createTestDatabase();owner=createUser({username:'owner',password:'password1'}).id;
 const c={username:'fixture',port:22,identityFile:'',codexCommand:'codex',codexHome:''};
 sourceId=(await saveCodexEnvironment({name:'source',connection:c,allowed_user_ids:[owner]})).id;
 targetId=(await saveCodexEnvironment({name:'target',connection:{...c,username:'second'},allowed_user_ids:[owner]})).id;
 getDb().prepare("INSERT INTO sessions(id,task,cli_type,codex_session_id,created_by_user_id,agent_environment_id) VALUES('s','work','codex',?,?,?)").run(native,owner,sourceId);
 fixture.sourceFile=join(db.dir,'source.jsonl');fixture.targetFile=join(db.dir,'staged.jsonl');
 await writeFile(fixture.sourceFile,[{type:'session_meta',payload:{id:native}},{type:'response_item',payload:{type:'function_call',name:'exec_command',arguments:'pwd'}},{type:'response_item',payload:{type:'function_call_output',output:'/fixture/project'}},{type:'event_msg',payload:{type:'agent_message',message:'All context'}}].map(x=>JSON.stringify(x)+'\n').join(''));
 active=false;paginated=false;failResume=false;dropHistory=false;reads=0;
 fixture.rpc.mockImplementation(async(method:string,params:any)=>{
  const target=currentCodexEngine().environmentId===targetId;
  if(method==='thread/read'){reads++;return {thread:{id:native,path:fixture.sourceFile,status:{type:active?'active':'idle'},historyMode:paginated?'paginated':'legacy'}};}
  if(method==='thread/resume'&&!target)return {sandbox:{type:'workspaceWrite',writableRoots:['/fixture/project'],networkAccess:false},approvalPolicy:'on-request'};
  if(method==='thread/fork'){expect(params.path).toBe(fixture.targetFile);expect(await readFile(params.path,'utf8')).toBe(await readFile(fixture.sourceFile,'utf8'));return {thread:{id:fresh}};}
  if(method==='thread/resume'&&target){if(failResume)throw Error('target disconnected');return {thread:{id:fresh,status:{type:'idle'},model:'fixture-model'}};}
  if(method==='thread/turns/list')return {data:target&&dropHistory?[]:[{id:'existing'}]};
  return {};
 });
});
afterEach(()=>{db.cleanup();});
describe('full native environment transfer preparation',()=>{
 it('copies tool and conversation records, preserves permissions and never submits a turn',async()=>{
  expect(await transferCodexEnvironment('s',owner,targetId,preference)).toMatchObject({ok:true});
  expect(fixture.rpc).toHaveBeenCalledWith('thread/fork',expect.objectContaining({model:'fixture-model',modelProvider:'openai',sandbox:'workspace-write',approvalPolicy:'on-request',deferGoalContinuation:true}));
  expect(fixture.rpc.mock.calls.map(c=>c[0])).not.toContain('turn/start');expect(fixture.cleanup).toHaveBeenCalledOnce();expect(reads).toBe(2);
  expect(usageOrigins(targetId)[fresh]).toEqual({after:expect.any(String)});
 });
 it('refuses an active source before copying any history',async()=>{active=true;expect(await transferCodexEnvironment('s',owner,targetId,preference)).toMatchObject({ok:false,error:expect.stringContaining('仍在执行')});expect(fixture.cleanup).not.toHaveBeenCalled();});
 it('archives a partially created target on resume failure and preserves source ownership',async()=>{failResume=true;expect(await transferCodexEnvironment('s',owner,targetId,preference)).toMatchObject({ok:false,error:'target disconnected'});expect(fixture.rpc).toHaveBeenCalledWith('thread/archive',{threadId:fresh});expect(fixture.cleanup).toHaveBeenCalledOnce();expect(getDb().prepare("SELECT agent_environment_id,codex_session_id FROM sessions WHERE id='s'").get()).toEqual({agent_environment_id:sourceId,codex_session_id:native});});
 it('rejects a fork when the target cannot read inherited paginated turns',async()=>{paginated=true;dropHistory=true;expect(await transferCodexEnvironment('s',owner,targetId,preference)).toMatchObject({ok:false,error:expect.stringContaining('无法完整读取复制后的会话历史')});expect(fixture.cleanup).toHaveBeenCalledWith(false);expect(fixture.rpc).toHaveBeenCalledWith('thread/archive',{threadId:fresh});expect(getDb().prepare("SELECT agent_environment_id,codex_session_id FROM sessions WHERE id='s'").get()).toEqual({agent_environment_id:sourceId,codex_session_id:native});});
 it('checks every page and rejects a partially inherited history',async()=>{
  paginated=true;const base=fixture.rpc.getMockImplementation()!;
  fixture.rpc.mockImplementation(async(method,params)=>{if(method!=='thread/turns/list')return base(method,params);const target=currentCodexEngine().environmentId===targetId;if(!params.cursor)return {data:Array.from({length:100},(_,i)=>({id:'turn-'+i})),nextCursor:'next'};return {data:target?[]:[{id:'last-turn'}]};});
  expect(await transferCodexEnvironment('s',owner,targetId,preference)).toMatchObject({ok:false,error:expect.stringContaining('无法完整读取')});expect(fixture.rpc).toHaveBeenCalledWith('thread/turns/list',expect.objectContaining({cursor:'next'}));expect(fixture.cleanup).toHaveBeenCalledWith(false);
 });
 it('imports paginated lineage and archives only generated ancestors while keeping their files for cold restoration',async()=>{paginated=true;expect(await transferCodexEnvironment('s',owner,targetId,preference)).toMatchObject({ok:true});expect(fixture.rpc).toHaveBeenCalledWith('thread/archive',{threadId:'import-parent'});expect(fixture.rpc).not.toHaveBeenCalledWith('thread/archive',{threadId:native});expect(fixture.cleanup).toHaveBeenCalledWith(true);expect(usageOrigins(targetId)['import-parent']).toEqual({exclude:true});});
 it('checks model support before staging a destination file',async()=>{expect(await transferCodexEnvironment('s',owner,targetId,{...preference,model:'unavailable'})).toMatchObject({ok:false,error:expect.stringContaining('不支持')});expect(fixture.cleanup).not.toHaveBeenCalled();});
 it('rejects an unauthorized destination before starting the lifecycle',async()=>{await saveCodexEnvironment({name:'target',allowed_user_ids:[]},targetId);await expect(transferCodexEnvironment('s',owner,targetId,preference)).rejects.toThrow('无权');expect(fixture.lifecycle).not.toHaveBeenCalled();});
 it('rechecks the source after copying and refuses a task started during the transfer',async()=>{const base=fixture.rpc.getMockImplementation()!;fixture.rpc.mockImplementation(async(method,params)=>{const result=await base(method,params);if(method==='thread/fork')active=true;return result;});expect(await transferCodexEnvironment('s',owner,targetId,preference)).toMatchObject({ok:false,error:expect.stringContaining('开始了新任务')});expect(fixture.rpc).toHaveBeenCalledWith('thread/archive',{threadId:fresh});});
});
