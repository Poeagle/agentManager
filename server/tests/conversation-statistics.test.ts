import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {mkdtempSync,writeFileSync,appendFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {readConversationStatistics} from '../src/services/conversation-statistics.js';
let dir:string,file:string;
const row=(type:string,payload:unknown)=>JSON.stringify({type,payload})+'\n';
const start=(id='one')=>row('event_msg',{type:'task_started',turn_id:id});
const message=(id:string,turn='one',phase='commentary')=>row('response_item',{type:'message',id,role:'assistant',phase,content:[{type:'output_text',text:'visible'}],internal_chat_message_metadata_passthrough:{turn_id:turn}});
const call=(id:string,type='function_call')=>row('response_item',{type,call_id:id,arguments:'PRIVATE_ARGUMENTS'});
const usage=(total:number,last:number)=>row('event_msg',{type:'token_count',info:{total_token_usage:{total_tokens:total},last_token_usage:{total_tokens:last,input_tokens:last-10,cached_input_tokens:20,output_tokens:10,reasoning_output_tokens:3},PRIVATE:'DO_NOT_EXPOSE'}});
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'conversation-statistics-'));file=join(dir,'rollout.jsonl');});afterEach(()=>rmSync(dir,{recursive:true,force:true}));
describe('bounded native conversation statistics',()=>{
 it('freezes cumulative progress snapshots and counts parallel calls as one round without double counting',async()=>{
  writeFileSync(file,start()+message('progress')+call('a')+call('a')+call('b','custom_tool_call')+usage(1000,100));
  let snapshots=await readConversationStatistics(file);expect(snapshots).toHaveLength(1);expect(snapshots[0]).toMatchObject({complete:true,requests:1,tool_calls:2,tool_rounds:1,tokens:{total_tokens:100,input_tokens:90,cached_input_tokens:20,output_tokens:10,reasoning_output_tokens:3}});
  appendFileSync(file,usage(1000,100)+call('c')+usage(1200,200)+message('final','one','final_answer')+usage(1500,300)+row('event_msg',{type:'task_complete',turn_id:'one'}));
  snapshots=await readConversationStatistics(file);expect(snapshots).toHaveLength(2);expect(snapshots[0].tokens?.total_tokens).toBe(100);expect(snapshots[1]).toMatchObject({requests:3,tool_calls:3,tool_rounds:2,tokens:{total_tokens:600}});expect(JSON.stringify(snapshots)).not.toMatch(/PRIVATE|ARGUMENTS|DO_NOT_EXPOSE/);
 });
 it('keeps turns separate and ignores tool result records even when their bodies are large',async()=>{
  writeFileSync(file,start()+message('first')+usage(1000,100)+start('two')+row('response_item',{type:'function_call_output',output:'x'.repeat(300000)})+message('second','two')+call('a')+usage(1100,100));
  const snapshots=await readConversationStatistics(file);expect(snapshots[1]).toMatchObject({turn_id:'two',complete:true,requests:1,tool_calls:1,tool_rounds:1,tokens:{total_tokens:100}});
 });
 it('marks incomplete history and missing usage instead of inventing per-message totals',async()=>{
  writeFileSync(file,row('turn_context',{turn_id:'partial'})+message('old','partial')+call('a')+usage(1000,100));expect((await readConversationStatistics(file))[0]).toMatchObject({complete:false,tokens:null,tool_calls:1});
  appendFileSync(file,start('new')+message('new','new','final_answer')+row('event_msg',{type:'task_complete',turn_id:'new'}));expect((await readConversationStatistics(file)).at(-1)).toMatchObject({tokens:null,turn_id:'new'});
 });
 it('waits for complete lines and discards cached counters after file truncation',async()=>{
  writeFileSync(file,start()+message('one'));const update=usage(1000,100);appendFileSync(file,update.slice(0,-1));expect(await readConversationStatistics(file)).toEqual([]);appendFileSync(file,'\n');expect((await readConversationStatistics(file))[0].tokens?.total_tokens).toBe(100);
  writeFileSync(file,start('new')+message('two','new')+usage(200,20));const snapshots=await readConversationStatistics(file);expect(snapshots).toHaveLength(1);expect(snapshots[0]).toMatchObject({turn_id:'new',tokens:{total_tokens:20}});
 });
 it('does not scan old oversized history to fabricate a complete current turn',async()=>{
  writeFileSync(file,start()+row('response_item',{type:'function_call_output',output:'x'.repeat(3*1024*1024)})+message('tail')+usage(1000,100));expect((await readConversationStatistics(file))[0]).toMatchObject({complete:false,tokens:null});
 });
});
