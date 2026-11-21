import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {appendFileSync,mkdtempSync,rmSync,writeFileSync} from 'fs';
import {join} from 'path';
import {tmpdir} from 'os';
import * as manager from '../src/services/session-manager.js';
import {readClaudeControls,readClaudeRuntime,readClaudeTelemetry,validateClaudeControls,applyClaudeControls,compactClaudeConversation,confirmedClaudeControls} from '../src/services/agents/claude/controls.js';
import {ensureClaudeRuntime,releaseClaudeRuntime} from '../src/services/agents/claude/sdk-runtime.js';
import {readConversation} from '../src/services/conversation-reader.js';
import type {AgentContext} from '../src/services/agents/types.js';
import {createTestDatabase} from './helpers/database.js';
const paths=vi.hoisted(()=>({directory:''}));
vi.mock('../src/services/agents/claude/archive.js',async()=>({...await vi.importActual('../src/services/agents/claude/archive.js'),resolveClaudeDir:()=>paths.directory}));
const native='019ff001-1212-7212-8212-121212121212';
let context:AgentContext,database:ReturnType<typeof createTestDatabase>|undefined;
beforeEach(()=>{paths.directory=mkdtempSync(join(tmpdir(),'claude-adapter-'));context={session:{id:'claude-fixture',cli_type:'claude'},nativeId:native,projectPath:'/fixture'};});
afterEach(()=>{releaseClaudeRuntime(native);database?.cleanup();database=undefined;vi.restoreAllMocks();rmSync(paths.directory,{recursive:true,force:true});});
const record=(value:unknown)=>JSON.stringify(value)+'\n';
describe('Claude feature implementation without starting a CLI',()=>{
 it('reads real model and usage, handles partial records and native compaction completion without scanning processes for telemetry',async()=>{
  const live=vi.spyOn(manager,'getLiveWorkAgent').mockResolvedValue(null);
  const path=join(paths.directory,`${native}.jsonl`),timestamp='2026-11-04T01:00:00Z';
  writeFileSync(path,record({type:'assistant',timestamp,message:{model:'claude-fixture',stop_reason:'end_turn',usage:{input_tokens:10,cache_read_input_tokens:20,cache_creation_input_tokens:5,output_tokens:3}}}));
  const usage=await readClaudeTelemetry(context);expect(usage.usage?.last.total_tokens).toBe(38);expect(usage.usage?.total.total_tokens).toBe(38);expect(live).not.toHaveBeenCalled();
  const controls=await readClaudeControls(context);expect(controls).toMatchObject({model:'claude-fixture',loaded:false});expect(confirmedClaudeControls(context,{model:'claude-fixture',effort:''},controls,'2026-11-04T00:59:00Z')).toBe(true);expect(confirmedClaudeControls(context,{model:'claude-fixture',effort:''},controls,'2026-11-04T01:01:00Z')).toBe(false);
  const compact=record({type:'system',subtype:'compact_boundary',uuid:'compact-fixture',timestamp,compactMetadata:{preTokens:100,postTokens:20,durationMs:5000}});
  appendFileSync(path,compact.slice(0,30));expect((await readClaudeRuntime(context)).compaction).toBeNull();
  appendFileSync(path,compact.slice(30));expect((await readClaudeRuntime(context)).compaction).toMatchObject({id:'compact-fixture',status:'completed',completed_at:timestamp});
  const projected=await readConversation({...context.session,project_path:context.projectPath,claude_session_id:native,cli_type:'claude'},{limit:10});
  expect(projected.messages.find(message=>message.presentation==='compaction_summary')).toMatchObject({role:'assistant',phase:'commentary'});
 });
 it('accumulates provider-reported Claude usage while retaining the latest request for context occupancy',async()=>{
  const path=join(paths.directory,`${native}.jsonl`);
  const assistant=(input:number,read:number,write:number,output:number)=>record({type:'assistant',timestamp:'2026-11-04T01:00:00Z',message:{model:'claude-fixture',stop_reason:'end_turn',usage:{input_tokens:input,cache_read_input_tokens:read,cache_creation_input_tokens:write,output_tokens:output}}});
  writeFileSync(path,assistant(10,20,5,3)+assistant(4,6,2,8));
  const value=await readClaudeTelemetry(context);
  expect(value.usage).toMatchObject({
   last:{total_tokens:20,input_tokens:12,cached_input_tokens:6,output_tokens:8},
   total:{total_tokens:58,input_tokens:47,cached_input_tokens:26,output_tokens:11},
   window:null,
  });
 });
 it('projects native assistant usage into the public conversation message',async()=>{
  const path=join(paths.directory,`${native}.jsonl`);
  writeFileSync(path,record({type:'user',uuid:'user-usage',timestamp:'2026-11-04T00:59:00Z',message:{role:'user',content:'Run'}})+record({type:'assistant',uuid:'assistant-usage',parentUuid:'user-usage',timestamp:'2026-11-04T01:00:00Z',message:{id:'assistant-usage',role:'assistant',model:'claude-fixture',stop_reason:'end_turn',content:[{type:'text',text:'Done'}],usage:{input_tokens:12,cache_read_input_tokens:6,cache_creation_input_tokens:2,output_tokens:8}}}));
  const value=await readConversation({...context.session,project_path:context.projectPath,claude_session_id:native,cli_type:'claude'},{limit:10});
  expect(value.messages.find(message=>message.role==='assistant')?.usage).toMatchObject({
    input_tokens:20,cached_input_tokens:6,output_tokens:8,total_tokens:28,
  });
 });
 it('validates model aliases and updates the managed runtime without terminal input',async()=>{
  ensureClaudeRuntime(native,'/fixture');
  const writes=vi.spyOn(manager,'writeToSession').mockReturnValue(true);
  await expect(validateClaudeControls(context,{model:'sonnet; arbitrary command',effort:''})).rejects.toThrow('Claude 支持的模型');
  const settings=await validateClaudeControls(context,{model:'sonnet',effort:''});
  const changed=await applyClaudeControls(context,settings);
  expect(changed).toMatchObject({model:'sonnet',pending:false});
  expect(writes).not.toHaveBeenCalled();
 });
 it('runs manual compaction through the managed SDK without sending terminal commands',async()=>{
  ensureClaudeRuntime(native,'/fixture');
  const writes=vi.spyOn(manager,'writeToSession').mockReturnValue(true);
  await compactClaudeConversation(context);
  expect(writes).not.toHaveBeenCalled();
 releaseClaudeRuntime(native);
 });
 it('keeps each session model preference independently across runtime recovery',async()=>{
  database=createTestDatabase();
  const first={...context,session:{...context.session,id:'session-a'}};
  const second={...context,session:{...context.session,id:'session-b'}};
  const {saveClaudeSessionModelPreference,readClaudeSessionModelPreference}=await import('../src/services/agents/claude/controls.js');
  saveClaudeSessionModelPreference(first,{model:'model-a',effort:''});
  saveClaudeSessionModelPreference(second,{model:'model-b',effort:''});
  expect(readClaudeSessionModelPreference(first)?.model).toBe('model-a');
  expect(readClaudeSessionModelPreference(second)?.model).toBe('model-b');
  database.cleanup();
  database=undefined;
 });
 it('restores the prior model setting if preparing a fresh conversation fails',async()=>{
  database=createTestDatabase();
  const {captureClaudeFreshRollback,saveClaudeSessionModelPreference,readClaudeSessionModelPreference}=await import('../src/services/agents/claude/controls.js');
  saveClaudeSessionModelPreference(context,{model:'old-model',effort:''});
  const rollback=captureClaudeFreshRollback(context);
  saveClaudeSessionModelPreference(context,{model:'new-model',effort:''});rollback();
  expect(readClaudeSessionModelPreference(context)?.model).toBe('old-model');
 });
 it('prepares a fresh Claude session using the selected target provider and model',async()=>{
  database=createTestDatabase();
  const {createClaudeProvider}=await import('../src/services/agents/claude/providers.js');
  createClaudeProvider({id:'brief-target',name:'Brief target',kind:'anthropic-compatible',apiKey:'fixture-secret',fields:{baseUrl:'https://fixture.invalid',models:['model-a','model-b'],defaultModel:'model-a'}});
  const {getAgent}=await import('../src/services/agents/index.js');
  const lifecycle=getAgent('claude').lifecycle;
  await expect(lifecycle.prepareFreshInEnvironment!(context,'claude-provider:brief-target',undefined,{model:'missing',effort:''})).rejects.toThrow('目标账号不支持所选模型');
  const fresh=await lifecycle.prepareFreshInEnvironment!(context,'claude-provider:brief-target',undefined,{model:'model-b',effort:''});
  try{expect(fresh).not.toBe(native);expect((await import('../src/services/agents/claude/controls.js')).readClaudeSessionModelPreference(context)).toMatchObject({model:'model-b'});}
  finally{releaseClaudeRuntime(fresh);}
 });
});
