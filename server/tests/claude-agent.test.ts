import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {appendFileSync,mkdtempSync,rmSync,writeFileSync} from 'fs';
import {join} from 'path';
import {tmpdir} from 'os';
import * as manager from '../src/services/session-manager.js';
import * as state from '../src/services/session-state.js';
import {readClaudeControls,readClaudeRuntime,readClaudeTelemetry,validateClaudeControls,applyClaudeControls,compactClaudeConversation,confirmedClaudeControls} from '../src/services/agents/claude/controls.js';
import type {AgentContext} from '../src/services/agents/types.js';
const paths=vi.hoisted(()=>({directory:''}));
vi.mock('../src/services/agents/claude/archive.js',async()=>({...await vi.importActual('../src/services/agents/claude/archive.js'),resolveClaudeDir:()=>paths.directory}));
const native='019ff001-1212-7212-8212-121212121212';
let context:AgentContext;
beforeEach(()=>{paths.directory=mkdtempSync(join(tmpdir(),'claude-adapter-'));context={session:{id:'claude-fixture',cli_type:'claude'},nativeId:native,projectPath:'/fixture'};});
afterEach(()=>{vi.restoreAllMocks();rmSync(paths.directory,{recursive:true,force:true});});
const record=(value:unknown)=>JSON.stringify(value)+'\n';
describe('Claude feature implementation without starting a CLI',()=>{
 it('reads real model and usage, handles partial records and native compaction completion without scanning processes for telemetry',async()=>{
  const live=vi.spyOn(manager,'getLiveWorkAgent').mockResolvedValue(null);
  vi.spyOn(state,'getTracker').mockReturnValue(undefined);
  const path=join(paths.directory,`${native}.jsonl`),timestamp='2026-11-04T01:00:00Z';
  writeFileSync(path,record({type:'assistant',timestamp,message:{model:'claude-fixture',stop_reason:'end_turn',usage:{input_tokens:10,cache_read_input_tokens:20,cache_creation_input_tokens:5,output_tokens:3}}}));
  const usage=await readClaudeTelemetry(context);expect(usage.usage?.last.total_tokens).toBe(38);expect(usage.usage?.total.total_tokens).toBeNull();expect(live).not.toHaveBeenCalled();
  const controls=await readClaudeControls(context);expect(controls).toMatchObject({model:'claude-fixture',loaded:false});expect(confirmedClaudeControls(context,{model:'claude-fixture',effort:''},controls,'2026-11-04T00:59:00Z')).toBe(true);expect(confirmedClaudeControls(context,{model:'claude-fixture',effort:''},controls,'2026-11-04T01:01:00Z')).toBe(false);
  const compact=record({type:'system',subtype:'compact_boundary',uuid:'compact-fixture',timestamp});
  appendFileSync(path,compact.slice(0,30));expect((await readClaudeRuntime(context)).compaction).toBeNull();
  appendFileSync(path,compact.slice(30));expect((await readClaudeRuntime(context)).compaction).toMatchObject({id:'compact-fixture',status:'completed',completed_at:timestamp});
 });
 it('validates model aliases and serializes complete control operations, reporting the model as pending',async()=>{
  vi.spyOn(manager,'getLiveWorkAgent').mockResolvedValue('claude');
  vi.spyOn(state,'getTracker').mockReturnValue({state:{processState:'idle'}} as any);
  const writes=vi.spyOn(manager,'writeToSession').mockReturnValue(true);
  await expect(validateClaudeControls(context,{model:'sonnet; arbitrary command',effort:''})).rejects.toThrow('模型别名');
  const settings=await validateClaudeControls(context,{model:'sonnet',effort:''});
  const [changed]=await Promise.all([applyClaudeControls(context,settings),compactClaudeConversation(context)]);
  expect(changed).toMatchObject({model:'sonnet',pending:true});
  expect(writes.mock.calls).toEqual([['claude-fixture','/model sonnet',true],['claude-fixture','\r',false],['claude-fixture','/compact',true],['claude-fixture','\r',false]]);
 });
 it('rejects control operations while busy without writing to the terminal',async()=>{
  vi.spyOn(manager,'getLiveWorkAgent').mockResolvedValue('claude');vi.spyOn(state,'getTracker').mockReturnValue({state:{processState:'busy'}} as any);
  const writes=vi.spyOn(manager,'writeToSession').mockReturnValue(true);await expect(compactClaudeConversation(context)).rejects.toThrow('空闲');expect(writes).not.toHaveBeenCalled();
 });
});
