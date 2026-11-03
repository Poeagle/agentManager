import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,appendFileSync,rmSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import {watchSessionRuntime,stopSessionRuntimeWatches} from '../src/services/session-runtime-watch.js';
import {subscribe} from '../src/services/event-store.js';
import * as manager from '../src/services/session-manager.js';
import * as promptContext from '../src/services/prompt-context.js';
import {setLiveCodexRuntime,clearLiveCodexRuntime,rememberCodexQuestionReply,syncQueuedCodexQuestionReplies} from '../src/services/codex-runtime-signals.js';
const native='019ff001-4545-7454-8454-454545454545';
let dir:string,file:string,unsubscribe:()=>void,events:any[];
const record=(type:string,second:number,extra={})=>JSON.stringify({type:'event_msg',timestamp:`2026-11-03T00:00:${String(second).padStart(2,'0')}Z`,payload:{type,...extra}})+'\n';
beforeEach(()=>{
 dir=mkdtempSync(join(tmpdir(),'runtime-watch-'));mkdirSync(join(dir,'sessions'));vi.stubEnv('CODEX_HOME',dir);file=join(dir,'sessions',`rollout-${native}.jsonl`);
 vi.spyOn(manager,'getLiveWorkAgent').mockResolvedValue('codex');events=[];unsubscribe=subscribe(event=>{if(event.type==='session.runtime')events.push(JSON.parse(event.data!));});
});
afterEach(()=>{stopSessionRuntimeWatches();unsubscribe();vi.restoreAllMocks();vi.unstubAllEnvs();rmSync(dir,{recursive:true,force:true});});
it('shares the native observer, coalesces write bursts and emits state and question changes without polling',async()=>{
 writeFileSync(file,record('task_started',1));const binding={id:'s',project_id:'p',codex_session_id:native};
 await Promise.all(Array.from({length:20},()=>watchSessionRuntime(binding)));
 await vi.waitFor(()=>expect(events).toHaveLength(1));expect(events[0].runtime.state).toBe('running');
 for(let i=0;i<200;i++)appendFileSync(file,record('agent_message',2,{message:'progress'}));
 appendFileSync(file,record('item_completed',3,{item:{type:'AgentMessage',id:'question',delivery:'async',questions:[{title:'继续吗',options:['继续']}]}})+record('task_complete',4));
 await vi.waitFor(()=>expect(events.at(-1).runtime).toMatchObject({state:'idle',pending_question_count:1}),{timeout:1500,interval:20});
 expect(events.length).toBeLessThanOrEqual(3);
 const count=events.length;appendFileSync(file,JSON.stringify({type:'response_item',payload:{type:'function_call_output',output:'PRIVATE_TOOL_OUTPUT'}})+'\n');
 await new Promise(resolve=>setTimeout(resolve,160));expect(events).toHaveLength(count);expect(JSON.stringify(events)).not.toContain('PRIVATE_TOOL_OUTPUT');
 stopSessionRuntimeWatches();appendFileSync(file,record('task_started',5));await new Promise(resolve=>setTimeout(resolve,160));expect(events).toHaveLength(count);
});
it('cancels an obsolete asynchronous attachment when a tab changes its native binding',async()=>{
 const next='019ff001-2323-7232-8232-232323232323',nextFile=join(dir,'sessions',`rollout-${next}.jsonl`);
 writeFileSync(file,record('task_complete',1));writeFileSync(nextFile,record('task_complete',2));
 let release!:(path:string)=>void;const delayed=new Promise<string>(resolve=>{release=resolve;});
 vi.spyOn(promptContext,'findCodexRollout').mockImplementation(id=>id===native?delayed:Promise.resolve(nextFile));
 const old=watchSessionRuntime({id:'s',project_id:'p',codex_session_id:native});
 await watchSessionRuntime({id:'s',project_id:'p',codex_session_id:next});release(file);await old;
 await vi.waitFor(()=>expect(events).toHaveLength(1));expect(events[0].runtime.session_id).toBe(next);
 appendFileSync(file,record('task_started',3));await new Promise(resolve=>setTimeout(resolve,160));expect(events).toHaveLength(1);
});
it('pushes live lifecycle changes before any rollout append, coalescing unchanged signals',async()=>{
 writeFileSync(file,record('task_complete',1));await watchSessionRuntime({id:'s',project_id:'p',codex_session_id:native});
 await vi.waitFor(()=>expect(events.at(-1)?.runtime.state).toBe('idle'));
 vi.mocked(manager.getLiveWorkAgent).mockResolvedValue(null);
 setLiveCodexRuntime(native,'observer','running');
 await vi.waitFor(()=>expect(events.at(-1)?.runtime).toMatchObject({source:'codex_stream',state:'running'}),{timeout:1000,interval:10});
 const count=events.length;for(let i=0;i<100;i++)setLiveCodexRuntime(native,'observer','running');
 await new Promise(resolve=>setTimeout(resolve,120));expect(events).toHaveLength(count);
 setLiveCodexRuntime(native,'observer','idle');
 await vi.waitFor(()=>expect(events.at(-1)?.runtime.state).toBe('idle'),{timeout:1000,interval:10});clearLiveCodexRuntime(native,'observer');
});
it('clears question attention on an accepted queued answer without waiting for compaction to write the answer',async()=>{
 const call='ack-question',questionItemId=JSON.stringify(['request_user_input_async',call,0]);
 writeFileSync(file,record('task_started',1)+record('item_completed',2,{item:{type:'AgentMessage',id:call,delivery:'async',questions:[{title:'Which?',options:null}]}}));
 await watchSessionRuntime({id:'s',project_id:'p',codex_session_id:native});
 await vi.waitFor(()=>expect(events.at(-1)?.runtime.pending_question_count).toBe(1));
 const answer='<send_user_message_question_reply>\n'+JSON.stringify([{questionItemId,question:'Which?',answer:'Private answer text'}])+'\n</send_user_message_question_reply>';
 rememberCodexQuestionReply(native,'ack-client',answer,true);
 await vi.waitFor(()=>expect(events.at(-1)?.runtime).toMatchObject({state:'running',pending_question_count:0,queued_answer_count:1,submitted_question_ids:[questionItemId]}),{timeout:1000,interval:10});
 expect(JSON.stringify(events)).not.toContain('Private answer text');
 // Removing an unconsumed native queue entry restores the original question.
 syncQueuedCodexQuestionReplies(native,[]);
 await vi.waitFor(()=>expect(events.at(-1)?.runtime.pending_question_count).toBe(1));
});
it('keeps a fresh thread ready when the native subscription reports idle',async()=>{
 writeFileSync(file,JSON.stringify({type:'session_meta',timestamp:'2026-11-03T00:00:00Z',payload:{id:native}})+'\n');
 await watchSessionRuntime({id:'s',project_id:'p',codex_session_id:native});
 setLiveCodexRuntime(native,'fresh','idle');
 await vi.waitFor(()=>expect(events.at(-1)?.runtime).toMatchObject({source:'codex_stream',state:'ready'}));clearLiveCodexRuntime(native,'fresh');
});
