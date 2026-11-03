import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,appendFileSync,rmSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import {watchSessionRuntime,stopSessionRuntimeWatches} from '../src/services/session-runtime-watch.js';
import {subscribe} from '../src/services/event-store.js';
import * as manager from '../src/services/session-manager.js';
import * as promptContext from '../src/services/prompt-context.js';
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
