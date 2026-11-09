import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {mkdtempSync,writeFileSync,appendFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {conversationMessageId} from '../src/services/conversation-reader.js';
import {readConversationStatistics} from '../src/services/agents/codex/statistics.js';
let dir:string,file:string;
const row=(type:string,payload:unknown)=>JSON.stringify({type,payload})+'\n';
const start=(id='one')=>row('event_msg',{type:'task_started',turn_id:id});
const message=(id:string,turn='one',phase='commentary')=>row('response_item',{type:'message',id,role:'assistant',phase,content:[{type:'output_text',text:'visible'}],internal_chat_message_metadata_passthrough:{turn_id:turn}});
const call=(id:string,type='function_call')=>row('response_item',{type,call_id:id,arguments:'PRIVATE_ARGUMENTS'});
const usage=(total:number,last:number)=>row('event_msg',{type:'token_count',info:{total_token_usage:{total_tokens:total},last_token_usage:{total_tokens:last,input_tokens:last-10,cached_input_tokens:20,output_tokens:10,reasoning_output_tokens:3},PRIVATE:'DO_NOT_EXPOSE'}});
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'conversation-statistics-'));file=join(dir,'rollout.jsonl');});afterEach(()=>rmSync(dir,{recursive:true,force:true}));
describe('bounded native conversation statistics',()=>{
 it('counts a native event and response echo once with the real conclusion duration',async()=>{
  const at=(time:string,type:string,payload:unknown)=>JSON.stringify({timestamp:time,type,payload})+'\n';
  const content=[{type:'output_text',text:'Answer'}];
  const record=at('2026-11-09T16:00:00Z','event_msg',{type:'task_started',turn_id:'turn'})
   +at('2026-11-09T16:00:20Z','response_item',{type:'custom_tool_call',call_id:'tool'})
   +at('2026-11-09T16:01:04Z','event_msg',{type:'item_completed',turn_id:'turn',item:{type:'AgentMessage',id:'answer',phase:'final_answer',content}})
   +at('2026-11-09T16:01:04.001Z','response_item',{type:'message',id:'answer',role:'assistant',phase:'final_answer',content,internal_chat_message_metadata_passthrough:{turn_id:'turn'}})
   +usage(1000,200)+at('2026-11-09T16:01:05Z','event_msg',{type:'task_complete',turn_id:'turn'});
  writeFileSync(file,record);
  const result=await readConversationStatistics(file);expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({message_id:conversationMessageId('other','assistant','answer'),interval:{shared_messages:1},conclusion:{shared_messages:1,elapsed_ms:64001,tool_calls:1,tool_rounds:1,tokens:{total_tokens:200}}});
 });
 it('still marks genuinely distinct conclusions in one request as shared',async()=>{
  writeFileSync(file,start()+message('first','one','final_answer')+message('second','one','final_answer')+usage(100,100));
  const result=await readConversationStatistics(file);expect(result).toHaveLength(2);expect(result.map(item=>item.conclusion?.shared_messages)).toEqual([2,2]);
 });
 it('does not duplicate an already settled native item when its echo arrives later',async()=>{
  const content=[{type:'output_text',text:'Answer'}];
  writeFileSync(file,start()+row('event_msg',{type:'item_completed',turn_id:'one',item:{type:'AgentMessage',id:'same',phase:'final_answer',content}})+usage(100,100));
  expect(await readConversationStatistics(file)).toHaveLength(1);
  appendFileSync(file,row('response_item',{type:'message',role:'assistant',id:'same',phase:'final_answer',content})+usage(200,100));
  expect(await readConversationStatistics(file)).toHaveLength(1);
 });
 it('uses lifecycle identity when a legacy assistant item omits per-message turn metadata',async()=>{
  writeFileSync(file,start('legacy')+row('response_item',{type:'message',id:'legacy-answer',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'visible'}]})+usage(100,100)+row('event_msg',{type:'task_complete',turn_id:'legacy'}));
  const snapshots=await readConversationStatistics(file);expect(snapshots).toHaveLength(1);expect(snapshots[0]).toMatchObject({turn_id:'legacy',complete:true,requests:1,tokens:{total_tokens:100}});expect(snapshots[0].message_id).toHaveLength(32);
 });
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
  writeFileSync(file,row('turn_context',{turn_id:'partial'})+message('old','partial')+call('a')+usage(1000,100));expect((await readConversationStatistics(file))[0]).toMatchObject({complete:false,tokens:{total_tokens:100},tool_calls:1});
  appendFileSync(file,start('new')+message('new','new','final_answer')+row('event_msg',{type:'task_complete',turn_id:'new'}));expect((await readConversationStatistics(file)).at(-1)).toMatchObject({tokens:null,turn_id:'new'});
 });
 it('waits for complete lines and discards cached counters after file truncation',async()=>{
  writeFileSync(file,start()+message('one'));const update=usage(1000,100);appendFileSync(file,update.slice(0,-1));expect(await readConversationStatistics(file)).toEqual([]);appendFileSync(file,'\n');expect((await readConversationStatistics(file))[0].tokens?.total_tokens).toBe(100);
  writeFileSync(file,start('new')+message('two','new')+usage(200,20));const snapshots=await readConversationStatistics(file);expect(snapshots).toHaveLength(1);expect(snapshots[0]).toMatchObject({turn_id:'new',tokens:{total_tokens:20}});
 });
 it('does not scan old oversized history to fabricate a complete current turn',async()=>{
  writeFileSync(file,start()+row('response_item',{type:'function_call_output',output:'x'.repeat(3*1024*1024)})+message('tail')+usage(1000,100));expect((await readConversationStatistics(file))[0]).toMatchObject({complete:false,tokens:{total_tokens:100}});
 });
 it('marks an unphased assistant item as the conclusion only when task_complete names its exact text',async()=>{
  const unphased=(id:string,text:string)=>row('response_item',{type:'message',id,role:'assistant',content:[{type:'output_text',text}],internal_chat_message_metadata_passthrough:{turn_id:'implicit'}});
  const completed=(text:string)=>row('event_msg',{type:'task_complete',turn_id:'implicit',last_agent_message:text});
  // Native rollouts write token_count before task_complete. Its snapshot must
  // already count usage while leaving the matching answer pending.
  writeFileSync(file,start('implicit')+unphased('progress','正在检查')+usage(100,100)+completed('检查完成'));
  expect((await readConversationStatistics(file))[0].conclusion).toBeUndefined();
  const resolved=join(dir,'resolved.jsonl');
  writeFileSync(resolved,start('implicit')+unphased('answer','介绍完成')+usage(200,200)+completed('介绍完成'));
  expect((await readConversationStatistics(resolved))[0]).toMatchObject({turn_id:'implicit',complete:true,tokens:null,conclusion:{complete:false,end_at:null,shared_messages:1,tokens:{total_tokens:200}}});
 });
 it('settles the matching tail rather than an earlier identical progress item',async()=>{
  const answer=(id:string,text:string)=>row('response_item',{type:'message',id,role:'assistant',content:[{type:'output_text',text}],internal_chat_message_metadata_passthrough:{turn_id:'same-tail'}});
  writeFileSync(file,start('same-tail')+answer('first','完成')+usage(100,100)+answer('later-progress','仍在检查')+usage(200,100)+answer('tail','完成')+usage(300,100)+row('event_msg',{type:'task_complete',turn_id:'same-tail',last_agent_message:'完成'}));
  const snapshots=await readConversationStatistics(file);
  expect(snapshots).toHaveLength(3);
  expect(snapshots[0].conclusion).toBeUndefined();
  expect(snapshots[1].conclusion).toBeUndefined();
  expect(snapshots[2]).toMatchObject({message_id:expect.any(String),conclusion:{shared_messages:1,tokens:{total_tokens:300}}});
 });
});
