import {afterEach,beforeEach,expect,it} from 'vitest';
import {mkdtempSync,writeFileSync,appendFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {readConversationProgress,readConversationStatistics} from '../src/services/agents/codex/statistics.js';
import {getAgent} from '../src/services/agents/index.js';
import {conversationMessageId} from '../src/services/conversation-reader.js';
let dir:string,path:string;beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'live-cost-'));path=join(dir,'rollout.jsonl');});afterEach(()=>rmSync(dir,{recursive:true,force:true}));
const row=(type:string,payload:unknown)=>JSON.stringify({type,timestamp:'2026-11-15T00:00:00Z',payload})+'\n';
const start=row('event_msg',{type:'task_started',turn_id:'turn'});
const context=(model:string,tier:string|null)=>row('turn_context',{turn_id:'turn',model,service_tier:tier});
const call=(id:string)=>row('response_item',{type:'function_call',call_id:id,arguments:'PRIVATE_ARGUMENTS'});
const message=(id:string)=>row('response_item',{type:'message',id,role:'assistant',phase:'commentary',content:[{type:'output_text',text:'progress'}]});
const usage=(total:number)=>row('event_msg',{type:'token_count',info:{total_token_usage:{total_tokens:total},last_token_usage:{total_tokens:1001000,input_tokens:1000000,cached_input_tokens:900000,output_tokens:1000,reasoning_output_tokens:100}}});
it('prices GPT-6.2 model and speed changes per request in live and restored conversation statistics',async()=>{
 writeFileSync(path,context('gpt-6.2-sol','priority')+start+message('sol')+usage(1001000));
 expect((await readConversationStatistics(path))[0].interval?.cost).toMatchObject({amount:0.6,complete:true,basis:'public_usd_reference',unit:'USD',rate_date:'2026-11-22'});
 appendFileSync(path,context('gpt-6.2-astra','ultrafast')+message('astra')+usage(2002000));
 expect((await readConversationProgress(path))?.segment?.cost).toMatchObject({amount:4.2,complete:true});
 const updated=await readConversationStatistics(path);expect(updated.map(item=>item.interval?.cost?.amount)).toEqual([0.6,3.6]);
 const restored=join(dir,'restored.jsonl');writeFileSync(restored,context('gpt-6.2-sol','priority')+start+message('sol')+usage(1001000)+context('gpt-6.2-astra','ultrafast')+message('astra')+usage(2002000));
 expect((await readConversationStatistics(restored)).map(item=>item.interval?.cost?.amount)).toEqual([0.6,3.6]);
});
it('updates active calls and rounds before any token count, then updates per-part USD estimates before the next text',async()=>{
 writeFileSync(path,context('gpt-6.1-sol','default')+start+message('first')+usage(1001000));
 let live=await readConversationProgress(path);expect(live?.step).toMatchObject({after_message_id:conversationMessageId('turn','assistant','first'),requests:0,tokens:null,tool_calls:0});
 appendFileSync(path,context('gpt-6.1-terra','fast')+call('a')+call('b')+call('a'));
 live=await readConversationProgress(path);expect(live?.step).toMatchObject({tokens:null,tool_calls:2,tool_rounds:1});
 appendFileSync(path,usage(2002000));live=await readConversationProgress(path);
 expect(live?.step).toMatchObject({tokens:{input_tokens:1000000,cached_input_tokens:900000,output_tokens:1000,total_tokens:1001000},cost:{amount:0.3,complete:true,unit:'USD',basis:'public_usd_reference',breakdown:{input:0.2,cache:0.09,output:0.01,reasoning:0.001}},tool_calls:2,tool_rounds:1,requests:1});
 expect(live?.segment?.cost?.amount).toBe(0.6);expect((await readConversationStatistics(path))[0].interval?.cost?.amount).toBe(0.3);
 expect(JSON.stringify(live)).not.toContain('PRIVATE_ARGUMENTS');
});
it('prices the default speed as complete and keeps unavailable prices partial',async()=>{
 writeFileSync(path,start+message('unpriced')+usage(1001000));
 expect((await readConversationStatistics(path))[0].interval?.cost).toMatchObject({amount:null,complete:false});
 appendFileSync(path,context('gpt-6.1-sol',null)+message('standard')+usage(2002000));
 expect((await readConversationStatistics(path)).at(-1)?.interval?.cost).toMatchObject({amount:0.3,complete:true,unit:'USD'});
 appendFileSync(path,context('gpt-6.1-sol','unsupported-speed')+message('unknown-speed')+usage(3003000));
 expect((await readConversationStatistics(path)).at(-1)?.interval?.cost).toMatchObject({amount:null,complete:false});
});
it('suppresses subscription Credit for API engines without changing shared cached snapshots',async()=>{
 writeFileSync(path,context('gpt-6.1-sol','default')+start+message('first')+usage(1001000));
 const api=await readConversationStatistics(path,false);expect(api[0].cost).toBeNull();expect(api[0].interval?.cost).toBeNull();expect(api[0].segment?.cost).toBeNull();
 expect((await getAgent('codex').statistics.read({session:{agent_environment_id:'provider:fixture'}} as any,path))[0].interval?.cost).toBeNull();
 expect((await readConversationProgress(path,false))?.step?.cost).toBeNull();expect((await readConversationStatistics(path))[0].interval?.cost?.amount).toBe(0.3);
});
it('does not carry step counters into a new input segment or a new native turn',async()=>{
 writeFileSync(path,start+message('first')+usage(1001000)+call('old'));
 await readConversationProgress(path);appendFileSync(path,row('event_msg',{type:'user_message',message:'follow-up'}));
 expect((await readConversationProgress(path))?.step).toMatchObject({after_message_id:null,tool_calls:0,tool_rounds:0,tokens:null});
 appendFileSync(path,row('event_msg',{type:'task_started',turn_id:'next'}));expect((await readConversationProgress(path))?.step).toMatchObject({after_message_id:null,tool_calls:0,requests:0});
});

it('recovers exact current-step counters after an earlier request omitted token fields',async()=>{
 writeFileSync(path,start+message('incomplete')+row('event_msg',{type:'token_count',info:{total_token_usage:{total_tokens:100},last_token_usage:{total_tokens:100}}}));
 await readConversationProgress(path);appendFileSync(path,context('gpt-6.1-sol','default')+call('new')+usage(1001100));
 expect((await readConversationProgress(path))?.step).toMatchObject({complete:true,tokens:{input_tokens:1000000,cached_input_tokens:900000,output_tokens:1000},cost:{amount:0.3,complete:true,unit:'USD'}});
});

it('marks a gap inside the active interval partial rather than pricing it as complete',async()=>{
 writeFileSync(path,context('gpt-6.1-sol','default')+start+message('first')+usage(1001000));await readConversationProgress(path);
 appendFileSync(path,'{"type":"event_msg","payload":{"type":"token_count",broken}}\n'+usage(2002000));
 expect((await readConversationProgress(path))?.step).toMatchObject({complete:false,cost:{amount:0.3,complete:false,unit:'USD'}});
});
it('recovers preceding model and speed receipts for a cold long transcript without using later settings or replaying earlier usage',async()=>{
 const padding=row('event_msg',{type:'unrelated',padding:'x'.repeat(16000)}).repeat(200);
 writeFileSync(path,context('gpt-6.1-sol','fast')+start+usage(1001000)+padding+start+message('cold')+usage(2002000));
 const reads=await Promise.all([readConversationStatistics(path),readConversationStatistics(path),readConversationStatistics(path)]);
 const first=reads[0][0];expect(reads[1]).toEqual(reads[0]);expect(reads[2]).toEqual(reads[0]);
 expect(first.interval).toMatchObject({requests:1,tokens:{total_tokens:1001000},cost:{amount:0.6,complete:true,unit:'USD'}});
 appendFileSync(path,context('gpt-6.1-terra','default')+message('next')+usage(3003000));
 const next=await readConversationStatistics(path);
 expect(next[0].interval?.cost?.amount).toBe(0.6);expect(next[1].interval?.cost?.amount).toBeCloseTo(0.15);
});
