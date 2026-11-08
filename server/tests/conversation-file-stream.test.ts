import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,appendFileSync,rmSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import {observeConversationFile,type ConversationHistoryFrame,type ConversationStatisticsFrame} from '../src/services/conversation-file-stream.js';
import type {ConversationUsageFrame} from '../src/services/conversation-usage.js';
import {rememberCodexQuestionReply,syncQueuedCodexQuestionReplies} from '../src/services/agents/codex/runtime-signals.js';
let close:(()=>void)|undefined,dir:string|undefined;
afterEach(()=>{close?.();vi.unstubAllEnvs();if(dir)rmSync(dir,{recursive:true,force:true});});
it('pushes new public legacy conversation records on file writes and stops when closed',async()=>{
 dir=mkdtempSync(join(tmpdir(),'conversation-file-'));vi.stubEnv('CODEX_HOME',dir);mkdirSync(join(dir,'sessions'));
 const native='019ff001-2345-7345-8345-234523452345',file=join(dir,'sessions',`rollout-${native}.jsonl`),record=(payload:any)=>JSON.stringify({type:'event_msg',timestamp:new Date().toISOString(),payload})+'\n';
 writeFileSync(file,record({type:'user_message',message:'检查推送'}));const frames:Array<ConversationHistoryFrame|ConversationUsageFrame|ConversationStatisticsFrame>=[];
 close=observeConversationFile({cli_type:'codex',codex_session_id:native,claude_session_id:null,project_path:dir},frame=>frames.push(frame));
 await vi.waitFor(()=>expect(frames.flatMap(f=>f.type==='history'?f.messages:[]).map(m=>m.text)).toContain('检查推送'));
 const started=Date.now();appendFileSync(file,record({type:'agent_message',message:'新进展立即推送',phase:'commentary'}));
 await vi.waitFor(()=>expect(frames.flatMap(f=>f.type==='history'?f.messages:[]).map(m=>m.text)).toContain('新进展立即推送'),{timeout:1000,interval:20});expect(Date.now()-started).toBeLessThan(1000);
 expect(frames.flatMap(f=>f.type==='history'?f.messages:[]).filter(m=>m.text==='检查推送')).toHaveLength(1);close();const count=frames.length;appendFileSync(file,record({type:'agent_message',message:'关闭后不再推送'}));await new Promise(r=>setTimeout(r,100));expect(frames).toHaveLength(count);
});
it('pushes typed compaction summaries and usage changes without exposing tool output',async()=>{
 dir=mkdtempSync(join(tmpdir(),'conversation-file-usage-'));vi.stubEnv('CODEX_HOME',dir);mkdirSync(join(dir,'sessions'));
 const native='019ff001-4545-7454-8454-454545454545',file=join(dir,'sessions',`rollout-${native}.jsonl`);
 const count=(value:number)=>JSON.stringify({type:'event_msg',timestamp:new Date().toISOString(),payload:{type:'token_count',info:{last_token_usage:{total_tokens:value},total_token_usage:{total_tokens:500000},model_context_window:40000}}})+'\n';
 writeFileSync(file,count(24000));const frames:Array<ConversationHistoryFrame|ConversationUsageFrame|ConversationStatisticsFrame>=[];
 close=observeConversationFile({cli_type:'codex',codex_session_id:native,claude_session_id:null,project_path:dir},frame=>frames.push(frame));
 await vi.waitFor(()=>expect(frames.filter(frame=>frame.type==='usage')).toHaveLength(1));
 appendFileSync(file,JSON.stringify({type:'compacted',payload:{message:'PRIVATE_SUMMARY'}})+'\n'+count(2400));
 await vi.waitFor(()=>expect(frames.at(-1)).toMatchObject({type:'usage',usage:{last:{total_tokens:2400}}}),{timeout:1000});
 appendFileSync(file,JSON.stringify({type:'response_item',payload:{type:'function_call_output',output:'PRIVATE_OUTPUT'}})+'\n');
 await new Promise(resolve=>setTimeout(resolve,120));expect(frames.filter(frame=>frame.type==='usage')).toHaveLength(2);
 expect(frames.flatMap(frame=>frame.type==='history'?frame.messages:[])).toContainEqual(expect.objectContaining({text:'PRIVATE_SUMMARY',presentation:'compaction_summary'}));
 expect(JSON.stringify(frames)).not.toContain('PRIVATE_OUTPUT');
});
it('shares file parsing and updates question metadata while the execution state remains running',async()=>{
 dir=mkdtempSync(join(tmpdir(),'conversation-file-runtime-'));vi.stubEnv('CODEX_HOME',dir);mkdirSync(join(dir,'sessions'));
 const native='019ff001-9999-7999-8999-999999999999',file=join(dir,'sessions',`rollout-${native}.jsonl`),binding={cli_type:'codex',codex_session_id:native,claude_session_id:null,project_path:dir};
 const record=(payload:unknown)=>JSON.stringify({type:'event_msg',timestamp:new Date().toISOString(),payload})+'\n';
 writeFileSync(file,record({type:'task_started',turn_id:'work'})+record({type:'item_completed',item:{type:'AgentMessage',id:'ask',delivery:'async',questions:[{title:'Which?',options:null}]}}));
 const first:any[]=[],second:any[]=[];close=observeConversationFile(binding,frame=>first.push(frame));
 await vi.waitFor(()=>expect(first.find(frame=>frame.type==='history')?.runtime).toMatchObject({state:'running',pending_question_count:1}));
 const stopSecond=observeConversationFile(binding,frame=>second.push(frame));
 try {
  expect(second[0]).toBe(first[0]);
  const questionItemId=JSON.stringify(['request_user_input_async','ask',0]);
  rememberCodexQuestionReply(native,'client','<send_user_message_question_reply>\n'+JSON.stringify([{questionItemId,question:'Which?',answer:'PRIVATE_ANSWER'}])+'\n</send_user_message_question_reply>',true);
  await vi.waitFor(()=>expect(second.filter(frame=>frame.type==='history').at(-1)?.runtime).toMatchObject({state:'running',pending_question_count:0,queued_answer_count:1}));
  expect(JSON.stringify(second)).not.toContain('PRIVATE_ANSWER');close();const count=first.length;
  appendFileSync(file,record({type:'agent_message',message:'remaining viewer'}));
  await vi.waitFor(()=>expect(second.flatMap(frame=>frame.messages||[]).some(message=>message.text==='remaining viewer')).toBe(true));expect(first).toHaveLength(count);
 }finally{stopSecond();syncQueuedCodexQuestionReplies(native,[]);}
});
