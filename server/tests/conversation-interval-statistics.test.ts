import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {mkdtempSync,writeFileSync,appendFileSync,rmSync,copyFileSync} from 'fs';
import {tmpdir} from 'os';import {join} from 'path';
import {readConversationStatistics,readConversationProgress} from '../src/services/agents/codex/statistics.js';
let dir:string,file:string;
const row=(type:string,payload:unknown)=>JSON.stringify({type,payload})+'\n';
const start=(id='turn')=>row('event_msg',{type:'task_started',turn_id:id});
const message=(id:string,turn='turn')=>row('response_item',{type:'message',id,role:'assistant',phase:'commentary',content:[{type:'output_text',text:'progress'}],internal_chat_message_metadata_passthrough:{turn_id:turn}});
const call=(id:string)=>row('response_item',{type:'function_call',call_id:id});
const usage=(total:number,last:number)=>row('event_msg',{type:'token_count',info:{total_token_usage:{total_tokens:total},last_token_usage:{total_tokens:last}}});
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'progress-interval-'));file=join(dir,'rollout.jsonl');});afterEach(()=>rmSync(dir,{recursive:true,force:true}));
describe('progress request intervals',()=>{
 it('updates cumulative progress as native records arrive and deduplicates tool calls',async()=>{
  writeFileSync(file,start()+message('a')+call('one')+usage(100,100));expect(await readConversationProgress(file)).toMatchObject({turn_id:'turn',tokens:{total_tokens:100},tool_calls:1,tool_rounds:1,complete:true});
  appendFileSync(file,call('two')+call('two'));expect(await readConversationProgress(file)).toMatchObject({tokens:{total_tokens:100},tool_calls:2,tool_rounds:1});
  appendFileSync(file,usage(300,200));expect(await readConversationProgress(file)).toMatchObject({tokens:{total_tokens:300},tool_calls:2,tool_rounds:2});
 });
 it('splits progress segments at follow-ups and stop boundaries and survives a cold read',async()=>{
  const at=(second:number,type:string,payload:unknown)=>JSON.stringify({timestamp:new Date(Date.UTC(2026,10,13,0,0,second)).toISOString(),type,payload})+'\n';
  writeFileSync(file,at(0,'event_msg',{type:'task_started',turn_id:'turn'})+at(1,'event_msg',{type:'user_message',message:'first',turn_id:'turn'})+message('a')+call('one')+usage(100,100));
  const first=await readConversationProgress(file);expect(first?.segment).toMatchObject({tool_calls:1,requests:1,end_at:null});
  appendFileSync(file,at(10,'event_msg',{type:'user_message',message:'follow-up',turn_id:'turn'})+message('b')+call('two')+usage(300,200)+message('c')+usage(400,100)+at(20,'event_msg',{type:'turn_aborted',turn_id:'turn'}));
  const rows=await readConversationStatistics(file),a=rows.find(item=>item.sequence===rows[0].sequence)!,b=rows.at(-1)!;
  expect(a.segment).toMatchObject({end_reason:'input',elapsed_ms:9000,tool_calls:1});
  expect(b.segment).toMatchObject({end_reason:'interrupted',elapsed_ms:10000,tool_calls:1,requests:1,complete:false,tokens:{total_tokens:100}});
  expect((await readConversationProgress(file))?.segment).toMatchObject({end_reason:'interrupted',tool_calls:1});
  const fresh=join(dir,'fresh.jsonl');writeFileSync(fresh,require('fs').readFileSync(file));expect(await readConversationStatistics(fresh)).toEqual(rows);
 });
 it('does not invent a stop time when the next turn starts without an end event',async()=>{
  const at=(second:number,type:string,payload:unknown)=>JSON.stringify({timestamp:new Date(Date.UTC(2026,10,13,0,0,second)).toISOString(),type,payload})+'\n';
  writeFileSync(file,at(0,'event_msg',{type:'task_started',turn_id:'one'})+message('one','one')+usage(100,100)+at(30,'event_msg',{type:'task_started',turn_id:'two'})+message('two','two')+usage(200,100));
  const [first]=await readConversationStatistics(file);expect(first.segment).toMatchObject({end_reason:'unknown',end_at:null,elapsed_ms:null,complete:false});
 });
 it('does not assign an unfinished first request to an early follow-up',async()=>{
  writeFileSync(file,start()+row('event_msg',{type:'user_message',message:'first',turn_id:'turn'})+row('event_msg',{type:'user_message',message:'follow-up',turn_id:'turn'})+message('reply')+usage(300,300));
  const progress=await readConversationProgress(file);expect(progress?.segment).toMatchObject({requests:0,tokens:null,complete:false});
 });
 it('reports each increment while keeping turn totals and deduplicating calls',async()=>{
  writeFileSync(file,start()+message('a')+call('one')+usage(100,100)+call('two')+call('two')+usage(300,200)+message('b')+usage(600,300));
  const [a,b]=await readConversationStatistics(file);expect(a.interval).toMatchObject({tokens:{total_tokens:100},tool_calls:1,tool_rounds:1,requests:1,complete:true});expect(b.tokens?.total_tokens).toBe(600);expect(b.interval).toMatchObject({tokens:{total_tokens:500},tool_calls:1,tool_rounds:1,requests:2,complete:true});
 });
 it('marks messages sharing one request instead of fabricating individual costs',async()=>{
  writeFileSync(file,start()+message('a')+message('b')+call('one')+usage(100,100)+message('c')+usage(300,200));const rows=await readConversationStatistics(file);expect(rows[0].interval).toMatchObject({shared_messages:2,tokens:{total_tokens:100}});expect(rows[1].interval).toEqual(rows[0].interval);expect(rows[2].interval).toMatchObject({shared_messages:1,tokens:{total_tokens:200},tool_calls:0});
 });
 it('can measure a complete interval following a partial cold-window baseline',async()=>{
  writeFileSync(file,row('turn_context',{turn_id:'turn'})+message('a')+call('one')+usage(1000,100)+message('b')+call('two')+usage(1200,200));const [a,b]=await readConversationStatistics(file);expect(a.interval).toMatchObject({complete:false,tokens:{total_tokens:100},tool_calls:1});expect(b.complete).toBe(false);expect(b.interval).toMatchObject({complete:true,tokens:{total_tokens:200},tool_calls:1,tool_rounds:1});
 });
 it('retains correct interval baselines when old message snapshots are evicted',async()=>{
  let text=start();for(let index=1;index<=100;index++)text+=message(String(index))+usage(index*10,10);writeFileSync(file,text);const rows=await readConversationStatistics(file);expect(rows).toHaveLength(80);expect(rows[0].tokens?.total_tokens).toBe(210);expect(rows[0].interval?.tokens?.total_tokens).toBe(10);
 });
 it('does not carry intervals into a different native turn or invent missing token usage',async()=>{
  writeFileSync(file,start()+message('a')+usage(100,100)+start('two')+message('b','two')+row('event_msg',{type:'task_complete',turn_id:'two'}));const rows=await readConversationStatistics(file);expect(rows[1].interval).toMatchObject({tokens:null,requests:0,tool_calls:0,complete:false});
 });
});
