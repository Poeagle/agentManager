import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {mkdtempSync,writeFileSync,appendFileSync,rmSync} from 'fs';
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
