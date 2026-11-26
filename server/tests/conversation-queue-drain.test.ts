import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createTestDatabase} from './helpers/database.js';
import {getDb} from '../src/db/index.js';
import {getAgent} from '../src/services/agents/index.js';
import * as stream from '../src/services/agents/codex/stream.js';
import type {AgentContext} from '../src/services/agents/types.js';
import {ownCodexQueuedInput,startOwnedCodexQueue} from '../src/services/agents/codex/queue.js';
let cleanup:()=>void;
beforeEach(()=>{const fixture=createTestDatabase();cleanup=fixture.cleanup;vi.stubEnv('AGENTMANAGER_CODEX_STREAM_SOCKET',fixture.dir+'/native.sock');});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();cleanup();});
it('waits during compaction and atomically starts one owned entry on idle without replaying its text',async()=>{
 let active=true,entries=[{id:'native-one',clientUserMessageId:'client-one',input:[]},{id:'other',clientUserMessageId:'other-client',input:[]}];const calls:string[]=[];
 ownCodexQueuedInput('thread','client-one');
 const request=async(method:string,params:any)=>{calls.push(method);if(method==='thread/queue/list')return {data:entries};if(method==='thread/read')return {thread:{status:{type:active?'active':'idle'}}};if(method==='thread/queue/start'){expect(params.queuedSubmissionId).toBe('native-one');entries=entries.filter(e=>e.id!==params.queuedSubmissionId);return {turn:{id:'new-turn'}};}throw Error('unexpected '+method);};
 expect(await startOwnedCodexQueue(request,'thread')).toBeNull();expect(calls).not.toContain('thread/queue/start');active=false;
 await Promise.all([startOwnedCodexQueue(request,'thread'),startOwnedCodexQueue(request,'thread')]);expect(calls.filter(m=>m==='thread/queue/start')).toHaveLength(1);expect(entries.map(e=>e.clientUserMessageId)).toEqual(['other-client']);
 expect(getDb().prepare('SELECT * FROM agent_queued_inputs').all()).toHaveLength(0);expect(calls).not.toContain('turn/start');
});
it('recovers ownership from the platform database and does not consume someone else’s queue head',async()=>{
 const scope=process.env.AGENTMANAGER_CODEX_STREAM_SOCKET!;
 getDb().prepare('INSERT INTO agent_queued_inputs VALUES(?,?,?,?)').run('codex',scope,'cold','ours');
 const calls:string[]=[];let items=[{id:'theirs',clientUserMessageId:'theirs'},{id:'ours',clientUserMessageId:'ours'}];
 const request=async(method:string)=>{calls.push(method);if(method==='thread/queue/list')return {data:items};if(method==='thread/read')return {thread:{status:{type:'idle'}}};if(method==='thread/queue/start'){items=[];return {turn:{id:'started'}};}throw Error(method);};
 expect(await startOwnedCodexQueue(request,'cold')).toBeNull();expect(calls).not.toContain('thread/queue/start');items=items.slice(1);
 expect(await startOwnedCodexQueue(request,'cold')).toBe('ours');expect(calls.filter(m=>m==='thread/queue/start')).toHaveLength(1);
});

it.each([
 ['consumed', true, false, false],
 ['pending', false, true, true],
 ['unconfirmed', false, false, true],
] as const)('reconciles queued input before changing conversations (%s)',async (_case,started,pending,blocked)=>{
 const scope=process.env.AGENTMANAGER_CODEX_STREAM_SOCKET!;
 const db=getDb();
 db.prepare('INSERT INTO agent_queued_inputs VALUES(?,?,?,?)').run('codex',scope,'failed-thread','follow-up');
 const request=async (method:string)=>{
   if(method==='thread/queue/list')return {data:pending?[{clientUserMessageId:'follow-up'}]:[]};
   if(method==='thread/turns/list')return {data:[{items:[{type:'userMessage',clientId:started?'follow-up':'other'}]}]};
   throw Error(method);
 };
 vi.spyOn(stream,'withCodexConnection').mockImplementation(action=>action(request,{userAgent:null}));
 const context={nativeId:'failed-thread',session:{id:'fixture'}} as AgentContext;
 expect(await getAgent('codex').input.hasQueuedFollowUp!(context)).toBe(blocked);
 expect(db.prepare('SELECT 1 FROM agent_queued_inputs').all()).toHaveLength(blocked?1:0);
});
