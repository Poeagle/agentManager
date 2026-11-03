import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {mkdtempSync,writeFileSync,appendFileSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {readConversationStatistics} from '../src/services/conversation-statistics.js';
let directory:string,file:string;
const time=(seconds:number)=>new Date(Date.UTC(2026,10,3,0,0,seconds)).toISOString();
const row=(seconds:number,type:string,payload:unknown)=>JSON.stringify({timestamp:time(seconds),type,payload})+'\n';
const start=(seconds:number,id='one')=>row(seconds,'event_msg',{type:'task_started',turn_id:id});
const message=(seconds:number,id:string,turn='one',phase='final_answer',extra={})=>row(seconds,'response_item',{type:'message',id,role:'assistant',phase,content:[{type:'output_text',text:id}],internal_chat_message_metadata_passthrough:{turn_id:turn},...extra});
const call=(id:string)=>row(0,'response_item',{type:'function_call',call_id:id});
const usage=(total:number,last:number)=>row(0,'event_msg',{type:'token_count',info:{total_token_usage:{total_tokens:total},last_token_usage:{total_tokens:last}}});
beforeEach(()=>{directory=mkdtempSync(join(tmpdir(),'conclusion-statistics-'));file=join(directory,'rollout.jsonl');});
afterEach(()=>rmSync(directory,{recursive:true,force:true}));
describe('conclusion-to-conclusion statistics',()=>{
 it('resets every counter at a conclusion, even within one native turn and after follow-ups',async()=>{
  writeFileSync(file,start(0)+call('a')+message(10,'first')+usage(100,100));
  const [first]=await readConversationStatistics(file);
  expect(first.conclusion).toMatchObject({tokens:{total_tokens:100},requests:1,tool_calls:1,tool_rounds:1,complete:true,start_at:time(0),end_at:time(10),elapsed_ms:10000});
  appendFileSync(file,row(20,'event_msg',{type:'user_message',message:'follow-up',turn_id:'one'})+message(25,'progress','one','commentary')+call('b')+usage(300,200)+message(30,'second')+usage(600,300));
  const rows=await readConversationStatistics(file);
  expect(rows[0]).toEqual(first);
  expect(rows[2]).toMatchObject({tokens:{total_tokens:600},tool_calls:2,conclusion:{tokens:{total_tokens:500},requests:2,tool_calls:1,tool_rounds:1,complete:true,start_at:time(10),end_at:time(30),elapsed_ms:20000}});
  expect(await readConversationStatistics(file)).toEqual(rows);
  const cold=join(directory,'fresh-reader.jsonl');copyFileSync(file,cold);
  expect(await readConversationStatistics(cold)).toEqual(rows);
 });
 it('carries work across failed/restarted native turns, counting waiting time and deduplicating calls',async()=>{
  writeFileSync(file,start(0)+message(10,'first')+usage(100,100)+start(20,'two')+call('same')+call('same')+message(25,'progress','two','commentary')+usage(300,200)+row(26,'event_msg',{type:'task_complete',turn_id:'two',error:'interrupted'})+start(40,'three')+call('same')+message(50,'second','three')+usage(600,300));
  const rows=await readConversationStatistics(file);
  expect(rows.at(-1)).toMatchObject({tokens:{total_tokens:300},tool_calls:1,conclusion:{tokens:{total_tokens:500},requests:2,tool_calls:2,tool_rounds:2,complete:true,start_at:time(10),end_at:time(50),elapsed_ms:40000}});
 });
 it('does not reset the first task interval at an additional user input or async question',async()=>{
  writeFileSync(file,start(0)+call('a')+message(10,'question','one','final_answer',{delivery:'async',questions:[{question:'Which?'}]})+usage(100,100)+row(20,'event_msg',{type:'user_message',message:'extra',turn_id:'one'})+message(30,'first')+usage(300,200));
  const rows=await readConversationStatistics(file);
  expect(rows[0].conclusion).toBeUndefined();
  expect(rows[1].conclusion).toMatchObject({tokens:{total_tokens:300},tool_calls:1,requests:2,start_at:time(0),elapsed_ms:30000});
 });
 it('recovers an exact boundary after a bounded cold read without scanning older history',async()=>{
  writeFileSync(file,start(0)+row(1,'response_item',{type:'function_call_output',output:'x'.repeat(3*1024*1024)})+row(2,'turn_context',{turn_id:'one'})+message(10,'first')+usage(1000,100)+start(20,'two')+call('a')+message(30,'second','two')+usage(1200,200));
  const [first,second]=await readConversationStatistics(file);
  expect(first.conclusion).toMatchObject({complete:false,start_at:null,elapsed_ms:null,tokens:{total_tokens:100}});
  expect(second.conclusion).toMatchObject({complete:true,start_at:time(10),elapsed_ms:20000,tokens:{total_tokens:200},tool_calls:1});
 });
 it('does not depend on the retained 80 snapshots',async()=>{
  let text=start(0)+message(10,'first')+usage(100,100);
  for(let i=1;i<=90;i++)text+=message(10+i,String(i),'one','commentary')+usage(100+i*10,10);
  text+=message(110,'second')+usage(1200,200);writeFileSync(file,text);
  const rows=await readConversationStatistics(file);expect(rows).toHaveLength(80);
  expect(rows.at(-1)?.conclusion).toMatchObject({tokens:{total_tokens:1100},requests:91,elapsed_ms:100000,start_at:time(10)});
 });
 it('marks absent usage as partial and starts the next conclusion from the actual boundary',async()=>{
  writeFileSync(file,start(0)+call('a')+message(10,'first')+row(10,'event_msg',{type:'task_complete',turn_id:'one'})+start(20,'two')+message(30,'second','two')+usage(200,200));
  const [first,second]=await readConversationStatistics(file);
  expect(first.conclusion).toMatchObject({tokens:null,complete:false,elapsed_ms:10000,tool_calls:1});
  expect(second.conclusion).toMatchObject({tokens:{total_tokens:200},complete:true,elapsed_ms:20000});
 });
 it('marks multiple conclusions in one request as shared instead of doubling per-conclusion costs',async()=>{
  writeFileSync(file,start(0)+message(10,'first')+message(15,'second')+usage(100,100)+message(25,'third')+usage(300,200));
  const [first,second,third]=await readConversationStatistics(file);
  expect(first.conclusion).toMatchObject({shared_messages:2,elapsed_ms:10000});expect(second.conclusion).toMatchObject({shared_messages:2,start_at:time(10),elapsed_ms:5000});
  expect(third.conclusion).toMatchObject({shared_messages:1,tokens:{total_tokens:200},elapsed_ms:10000});
 });
});
