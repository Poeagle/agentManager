import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {appendFileSync,mkdtempSync,rmSync,writeFileSync} from 'fs';
import {join} from 'path';
import {tmpdir} from 'os';
import * as manager from '../src/services/session-manager.js';
import {readClaudeControls,readClaudeRuntime,readClaudeTelemetry,validateClaudeControls,applyClaudeControls,compactClaudeConversation,confirmedClaudeControls} from '../src/services/agents/claude/controls.js';
import {ensureClaudeRuntime,releaseClaudeRuntime} from '../src/services/agents/claude/sdk-runtime.js';
import type {AgentContext} from '../src/services/agents/types.js';
const paths=vi.hoisted(()=>({directory:''}));
vi.mock('../src/services/agents/claude/archive.js',async()=>({...await vi.importActual('../src/services/agents/claude/archive.js'),resolveClaudeDir:()=>paths.directory}));
const native='019ff001-1212-7212-8212-121212121212';
let context:AgentContext;
beforeEach(()=>{paths.directory=mkdtempSync(join(tmpdir(),'claude-adapter-'));context={session:{id:'claude-fixture',cli_type:'claude'},nativeId:native,projectPath:'/fixture'};});
afterEach(()=>{releaseClaudeRuntime(native);vi.restoreAllMocks();rmSync(paths.directory,{recursive:true,force:true});});
const record=(value:unknown)=>JSON.stringify(value)+'\n';
describe('Claude feature implementation without starting a CLI',()=>{
 it('reads real model and usage, handles partial records and native compaction completion without scanning processes for telemetry',async()=>{
  const live=vi.spyOn(manager,'getLiveWorkAgent').mockResolvedValue(null);
  const path=join(paths.directory,`${native}.jsonl`),timestamp='2026-11-04T01:00:00Z';
  writeFileSync(path,record({type:'assistant',timestamp,message:{model:'claude-fixture',stop_reason:'end_turn',usage:{input_tokens:10,cache_read_input_tokens:20,cache_creation_input_tokens:5,output_tokens:3}}}));
  const usage=await readClaudeTelemetry(context);expect(usage.usage?.last.total_tokens).toBe(38);expect(usage.usage?.total.total_tokens).toBeNull();expect(live).not.toHaveBeenCalled();
  const controls=await readClaudeControls(context);expect(controls).toMatchObject({model:'claude-fixture',loaded:false});expect(confirmedClaudeControls(context,{model:'claude-fixture',effort:''},controls,'2026-11-04T00:59:00Z')).toBe(true);expect(confirmedClaudeControls(context,{model:'claude-fixture',effort:''},controls,'2026-11-04T01:01:00Z')).toBe(false);
  const compact=record({type:'system',subtype:'compact_boundary',uuid:'compact-fixture',timestamp});
  appendFileSync(path,compact.slice(0,30));expect((await readClaudeRuntime(context)).compaction).toBeNull();
  appendFileSync(path,compact.slice(30));expect((await readClaudeRuntime(context)).compaction).toMatchObject({id:'compact-fixture',status:'completed',completed_at:timestamp});
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
 it('reports manual compaction as unsupported instead of sending terminal commands',async()=>{
  const writes=vi.spyOn(manager,'writeToSession').mockReturnValue(true);
  await expect(compactClaudeConversation(context)).rejects.toThrow('does not expose manual compaction');
  expect(writes).not.toHaveBeenCalled();
 });
});
