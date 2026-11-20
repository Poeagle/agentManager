import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { closeDb, getDb, initDb } from '../src/db/index.js';
import { agentContext, getAgent } from '../src/services/agents/index.js';
import { nativeItemId } from '../src/services/agents/session-fact-values.js';
import { beginSessionAction, collectSessionStatisticsInventory, readChangedSessionStatistics, readSessionMetadata, readSessionMetadataDetails,
  readSessionProgress, stopSessionStatistics, updateSessionFacts } from '../src/services/session-statistics.js';
import { createTestDatabase } from './helpers/database.js';

const base = Date.parse('2026-11-20T09:00:00Z');
const stamp = (seconds: number) => new Date(base + seconds * 1000).toISOString();
const row = (seconds: number, type: string, payload: unknown) => JSON.stringify({timestamp:stamp(seconds), type, payload}) + '\n';
const event = (time: number, type: string, properties: object = {}) => row(time, 'event_msg', {type, ...properties});
const user = (time: number, id: string) => row(time, 'response_item',
  {type:'message', role:'user', id, content:[{type:'input_text', text:'private input body'}]});
const answer = (time: number, id: string, phase: string) => row(time, 'response_item',
  {type:'message', role:'assistant', id, phase, content:[{type:'output_text', text:'private output body'}]});
const tool = (time: number, id: string) => row(time, 'response_item',
  {type:'function_call', call_id:id, arguments:'private arguments'});
const tokens = (input: number, cache: number, output = 20) =>
  ({input_tokens:input, cached_input_tokens:cache, output_tokens:output, reasoning_output_tokens:5, total_tokens:input+output});
const receipt = (time: number, id: string, turn: string, usage: ReturnType<typeof tokens>) =>
  row(time, 'token_usage_record', {thread_id:'codex-session', turn_id:turn, response_id:id, usage});
const legacy = (time: number, total: number, last: ReturnType<typeof tokens>) =>
  event(time, 'token_count', {info:{total_token_usage:{total_tokens:total}, last_token_usage:last}});
const codex = agentContext({id:'tab', agent_id:'codex', native_session_id:'codex-session', project_path:'/project'});
const claude = agentContext({id:'claude-tab', agent_id:'claude', native_session_id:'claude-session', project_path:'/project'});
let fixture:ReturnType<typeof createTestDatabase>, file:string;
beforeEach(async()=>{
  fixture=createTestDatabase();
  await mkdir(join(fixture.dir,'logs'));
  file=join(fixture.dir,'logs','rollout.jsonl');
});
afterEach(async()=>{await stopSessionStatistics();vi.restoreAllMocks();vi.unstubAllEnvs();fixture.cleanup();});

describe('persisted session statistics',()=>{
  it('reconciles primary receipts, tool rounds, completed intervals, and cache changes across restart',async()=>{
    const first=tokens(10_000,9_000), second=tokens(11_000,0), third=tokens(12_000,10_000);
    await writeFile(file,
      row(0,'session_meta',{id:'codex-session', creator_account_id:'private account'})+
      event(1,'task_started',{turn_id:'a'})+row(2,'turn_context',{turn_id:'a',model:'gpt-6.1-sol',service_tier:'default'})+
      user(3,'first')+answer(4,'progress','commentary')+tool(5,'tool-a')+tool(5,'tool-b')+tool(5,'tool-a')+
      receipt(6,'r1','a',first)+legacy(7,first.total_tokens,first)+
      answer(8,'final-a','final_answer')+receipt(9,'r2','a',third)+legacy(9,first.total_tokens+third.total_tokens,third)+
      event(10,'task_complete',{turn_id:'a'}));
    await updateSessionFacts(codex,file);
    const [progress,final]=readChangedSessionStatistics(codex,0);
    expect(progress.interval).toMatchObject({requests:1,tool_calls:2,tool_rounds:1,complete:true,tokens:{total_tokens:first.total_tokens}});
    expect(final).toMatchObject({conclusion:{requests:2,tool_calls:2,tool_rounds:1,complete:true},interval:{requests:1,tool_calls:0}});
    const before=readSessionMetadata(codex)!;
    closeDb();initDb();
    expect(readSessionMetadata(codex)).toEqual(before);
    await updateSessionFacts(codex,file);
    expect(readSessionMetadata(codex)).toEqual(before);
    await appendFile(file,
      row(900,'compacted',{message:'x'.repeat(800_000)})+
      event(930,'task_started',{turn_id:'b'})+row(931,'turn_context',{turn_id:'b',model:'gpt-6.1-terra',service_tier:'priority'})+
      user(932,'second')+answer(933,'final-b','final_answer')+
      receipt(934,'r3','b',second)+legacy(935,first.total_tokens+third.total_tokens,third)+
      receipt(934,'r3','b',second)+event(936,'task_complete',{turn_id:'b'}));
    await updateSessionFacts(codex,file);
    const details=readSessionMetadataDetails(codex,true)!;
    expect(details.summary).toMatchObject({status:'complete',totals:{
      requests:3,tool_calls:2,tool_rounds:1,tokens:{total_tokens:first.total_tokens+second.total_tokens+third.total_tokens},
    },user_inputs:2,completed_turns:2,cache_drop_count:1});
    expect(details.models).toMatchObject([{model:'gpt-6.1-sol',speed:'default',requests:2},{model:'gpt-6.1-terra',speed:'priority',requests:1}]);
    expect(details.cache_drops[0]).toMatchObject({at:stamp(934),elapsed_ms:929000,
      factors:['model','speed','compact','input_gap'],previous:{request_id:'r1',input_id:nativeItemId('user','first')},current:{request_id:'r3'},confirmed_cause:null});
    expect(readChangedSessionStatistics(codex,before.revision).at(-1)?.conclusion).toMatchObject({requests:1,tokens:{total_tokens:second.total_tokens}});
    expect(JSON.stringify(details)).not.toContain('private');
  });

  it('recovers a partial line and replaces stale projections when the source is rewritten',async()=>{
    const prefix=event(0,'task_started',{turn_id:'a'})+user(1,'one')+answer(2,'pending','final_answer');
    const line=receipt(3,'r1','a',tokens(10_000,9_000));
    await writeFile(file,prefix+line.slice(0,-1));
    await updateSessionFacts(codex,file);
    expect(readChangedSessionStatistics(codex,0)[0].interval).toMatchObject({coverage:'pending',tokens:null});
    expect(readSessionMetadata(codex)?.reasons).toContain('incomplete_record');
    await appendFile(file,'\n'+event(4,'task_complete',{turn_id:'a'}));
    await updateSessionFacts(codex,file);
    const before=readSessionMetadata(codex);
    expect(before).toMatchObject({status:'complete',totals:{requests:1}});
    await writeFile(file+'.replacement',event(5,'task_started',{turn_id:'new'}));
    await rename(file+'.replacement',file);
    await updateSessionFacts(codex,file);
    expect(readChangedSessionStatistics(codex,0)).toEqual([]);
    expect(readSessionMetadata(codex)).toMatchObject({status:'partial',reasons:['source_replaced']});
    expect(readSessionMetadata(codex)?.generation).not.toBe(before?.generation);
    expect(getDb().prepare('SELECT request_id FROM session_statistics_requests').all()).toEqual([{request_id:'r1'}]);
  });

  it('records where an interrupt was submitted and settles confirmed late usage once',async()=>{
    await writeFile(file,event(0,'task_started',{turn_id:'turn'})+user(1,'input')+
      answer(2,'progress','commentary')+tool(2,'call'));
    await updateSessionFacts(codex,file);
    const stop=beginSessionAction(codex,'stop',{turn_id:'turn'});
    stop('accepted');
    await appendFile(file,event(3,'turn_aborted',{turn_id:'turn'}));
    await updateSessionFacts(codex,file);
    expect(readSessionProgress(codex)?.segment).toMatchObject({end_reason:'interrupted',complete:false});
    await appendFile(file,receipt(4,'late','turn',tokens(5000,1000))+receipt(4,'late','turn',tokens(5000,1000)));
    await updateSessionFacts(codex,file);
    const details=readSessionMetadataDetails(codex,true)!;
    expect(details.events.filter(event=>event.action==='stop')).toMatchObject([
      {state:'accepted'},
      {state:'requested',execution:{turn_id:'turn',active_tool_ids:['call'],active_item_ids:[],last_item_id:nativeItemId('assistant','progress')}},
    ]);
    expect(details.events.find(event=>event.action==='interrupt')).toMatchObject({state:'completed',evidence:'native',at:stamp(3)});
    expect(details.summary.totals).toMatchObject({requests:1,tool_calls:1});
    expect(readChangedSessionStatistics(codex,0)[0]).toMatchObject({interval:{complete:true},segment:{end_reason:'interrupted',tool_calls:1}});
  });

  it('deduplicates Claude content blocks and uses native cache write/read semantics',async()=>{
    const assistant=(time:number,id:string,content:unknown[],usage:object,stop_reason:string|null)=>
      JSON.stringify({timestamp:stamp(time),type:'assistant',message:{id,role:'assistant',model:'claude-test',content,usage,stop_reason}})+'\n';
    const human=(time:number,uuid:string,content:unknown)=>JSON.stringify({timestamp:stamp(time),type:'user',uuid,message:{role:'user',content}})+'\n';
    const usage={input_tokens:1000,cache_creation_input_tokens:200,cache_read_input_tokens:8800,output_tokens:10};
    await writeFile(file,human(1,'one','First')+
      assistant(2,'a',[{type:'text',text:'progress'}],usage,null)+
      assistant(3,'a',[{type:'tool_use',id:'tool-1'},{type:'tool_use',id:'tool-2'}],{...usage,output_tokens:20},'tool_use')+
      human(4,'tool-result',[{type:'tool_result',tool_use_id:'tool-1'}])+
      assistant(5,'b',[{type:'text',text:'Final'}],usage,'end_turn')+
      human(6,'two','Second')+
      assistant(8,'c',[{type:'text',text:'Other final'}],{...usage,input_tokens:9800,cache_read_input_tokens:0},'end_turn'));
    await updateSessionFacts(claude,file);
    const details=readSessionMetadataDetails(claude,true)!;
    expect(details.summary).toMatchObject({status:'complete',totals:{requests:3,tool_calls:2,tool_rounds:1,cost:null,
      tokens:{input_tokens:30000,cached_input_tokens:17600,output_tokens:40,reasoning_output_tokens:null,total_tokens:30040}},
      user_inputs:2,completed_turns:2,cache_drop_count:1});
    expect(readChangedSessionStatistics(claude,0)[1].conclusion).toMatchObject({requests:2,tool_calls:2,tool_rounds:1});
  });

  it('keeps pending and completed statistics scoped to the native environment of the binding',async()=>{
    await writeFile(file,event(0,'task_started',{turn_id:'a'})+user(1,'one')+answer(2,'final','final_answer')+receipt(3,'id','a',tokens(5000,1000)));
    await updateSessionFacts(codex,file);
    const other={...codex,session:{...codex.session,agent_environment_id:'provider:other'}};
    expect(readSessionMetadata(other,false)).toMatchObject({status:'unavailable',totals:null});
    expect(readChangedSessionStatistics(other,0)).toEqual([]);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM session_statistics_requests').get()).toEqual({n:1});
  });

  it('keeps a request that crosses a steer attached to its native Item and previous Progress',async()=>{
    const first=tokens(5000,4500),second=tokens(6000,0);
    await writeFile(file,event(0,'task_started',{turn_id:'turn'})+user(1,'first')+
      answer(2,'progress','commentary')+tool(3,'parallel')+user(4,'steer')+
      receipt(5,'in-flight','turn',first)+answer(6,'next','commentary')+
      receipt(7,'next-run','turn',second)+event(8,'task_complete',{turn_id:'turn'}));
    await updateSessionFacts(codex,file);
    const [old,newer]=readChangedSessionStatistics(codex,0);
    expect(old).toMatchObject({interval:{requests:1,tokens:{total_tokens:5020}},
      segment:{end_reason:'input',end_at:stamp(4),complete:true,requests:1,tool_calls:1,tokens:{total_tokens:5020}}});
    expect(newer.segment).toMatchObject({start_at:stamp(4),complete:true,requests:1,tokens:{total_tokens:6020}});
    const metadata=readSessionMetadataDetails(codex,true)!;
    expect(metadata.summary.cache_drop_count).toBe(0);
    expect(metadata.events.find(fact=>fact.message_id===nativeItemId('user','steer')&&fact.state==='accepted')?.execution).toMatchObject({
      turn_id:'turn',last_item_id:nativeItemId('assistant','progress'),active_tool_ids:['parallel'],
    });
  });

  it('does not split shared usage or add non-Item requests twice when computing a Final',async()=>{
    await writeFile(file,event(0,'task_started',{turn_id:'turn'})+user(1,'first')+
      tool(2,'hidden')+receipt(3,'tools','turn',tokens(2000,1000))+
      answer(4,'same-a','commentary')+answer(4,'same-b','commentary')+
      receipt(5,'shared','turn',tokens(3000,1500))+
      answer(6,'final','final_answer')+receipt(7,'final-request','turn',tokens(4000,2000))+
      event(8,'task_complete',{turn_id:'turn'}));
    await updateSessionFacts(codex,file);
    const [a,b,final]=readChangedSessionStatistics(codex,0);
    expect(a.interval).toMatchObject({shared_messages:2,requests:1,tokens:{total_tokens:3020}});
    expect(a.interval).toEqual(b.interval);
    expect(final.conclusion).toMatchObject({requests:3,tokens:{total_tokens:9060},tool_calls:1});
  });

  it('backfills an unopened native session and records progress across a bounded batch',async()=>{
    const native='019ff001-1212-7212-8212-121212122345';
    const directory=join(fixture.dir,'sessions');
    const path=join(directory,`rollout-${native}.jsonl`);
    await mkdir(directory);
    vi.stubEnv('CODEX_HOME',fixture.dir);
    vi.spyOn(getAgent('claude').statistics.facts!,'discover').mockImplementation(async function*(){});
    const output=row(3,'response_item',{type:'function_call_output',output:'x'.repeat(640*1024)});
    await writeFile(path,row(0,'session_meta',{id:native})+event(1,'task_started',{turn_id:'turn'})+user(2,'input')+
      output.repeat(14)+answer(4,'final','final_answer')+receipt(5,'response','turn',tokens(2000,1500))+
      event(6,'task_complete',{turn_id:'turn'}));
    const context=agentContext({agent_id:'codex',native_session_id:native});
    const {signal}=new AbortController();
    await collectSessionStatisticsInventory(signal);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({n:0});
    expect(readSessionMetadata(context)).toMatchObject({status:'pending',reasons:['backfill']});
    await collectSessionStatisticsInventory(signal);
    expect(readSessionMetadata(context)).toMatchObject({status:'complete',totals:{requests:1,tokens:{total_tokens:2020}}});
  });

  it('keeps a missing receipt visible after rebuilding a replacement across multiple batches',async()=>{
    const start=event(0,'task_started',{turn_id:'turn'})+user(1,'input');
    const final=answer(4,'final','final_answer');
    const end=event(6,'task_complete',{turn_id:'turn'});
    await writeFile(file,start+final+receipt(5,'old-request','turn',tokens(2000,1500))+end);
    await updateSessionFacts(codex,file,false);
    const toolOutput=row(3,'response_item',{type:'function_call_output',output:'x'.repeat(640*1024)});
    await writeFile(file+'.replacement',start+toolOutput.repeat(14)+final+
      receipt(5,'new-request','turn',tokens(3000,1500))+end);
    await rename(file+'.replacement',file);
    await updateSessionFacts(codex,file,false);
    expect(readSessionMetadata(codex)?.reasons).toContain('backfill');
    await updateSessionFacts(codex,file,false);
    expect(readSessionMetadata(codex)).toMatchObject({
      status:'partial',reasons:['source_replaced'],totals:{requests:1,tokens:{total_tokens:3020}},
    });
    expect(getDb().prepare('SELECT request_id FROM session_statistics_requests ORDER BY request_id').all())
      .toEqual([{request_id:'new-request'},{request_id:'old-request'}]);
  });

  it('does not let a duplicate modern receipt suppress a subsequent legacy request',async()=>{
    const first=tokens(5000,4500),next=tokens(5100,4500);
    await writeFile(file,event(0,'task_started',{turn_id:'t'})+
      answer(1,'update','commentary')+receipt(2,'modern','t',first)+legacy(3,first.total_tokens,first)+
      receipt(4,'modern','t',first)+answer(5,'final','final_answer')+legacy(6,first.total_tokens+next.total_tokens,next)+
      event(7,'task_complete',{turn_id:'t'}));
    await updateSessionFacts(codex,file);
    expect(readSessionMetadata(codex)).toMatchObject({status:'complete',totals:{requests:2,tokens:{total_tokens:10140}}});
  });
});
