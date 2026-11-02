import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import Database from 'better-sqlite3';
import {ConversationRetryManager,retryableConversationError,type ConversationRetryFrame} from '../src/services/conversation-retry.js';
import type {ConversationStreamFrame,observeCodexConversation} from '../src/services/conversation-stream.js';
const capacity={message:'Selected model is at capacity. Please try a different model.',codexErrorInfo:'ServerOverloaded'};
let db:Database.Database,manager:ConversationRetryManager,allowed:boolean;
let native:{state:string;turn:any;queued:boolean};
let emit:((frame:ConversationStreamFrame)=>void),failed:((turnId:string,error:unknown,willRetry:boolean)=>void)|undefined;
let start:ReturnType<typeof vi.fn>,frames:ConversationRetryFrame[],stops:ReturnType<typeof vi.fn>,inspect:ReturnType<typeof vi.fn>;
function create(){return new ConversationRetryManager(db,{allowed:()=>allowed,inspect,start,observe:((_id,callback,onFailure)=>{emit=callback;failed=onFailure;return Object.assign(stops,{respond:vi.fn()});}) as typeof observeCodexConversation});}
const failure=()=>manager.failure('session','user','native','initial',capacity,false);
const status=()=>frames.at(-1)?.retry;
const readJob=()=>JSON.parse((db.prepare('SELECT data FROM conversation_retries ORDER BY rowid DESC LIMIT 1').get() as {data:string}).data);
async function settle(){await Promise.resolve();await Promise.resolve();await Promise.resolve();}
async function failRetry(){native.turn={...native.turn,status:'failed',error:capacity};native.state='idle';failed!(native.turn.id,capacity,false);await settle();}
function snapshot(){emit({type:'snapshot',turn_id:native.turn.id,started_at:null,completed_at:new Date().toISOString(),messages:[],busy:false,connected:true,interactions:[],activities:[],compaction:null,stage:'idle'});}
beforeEach(()=>{
 vi.useFakeTimers();db=new Database(':memory:');allowed=true;frames=[];stops=vi.fn();
 native={state:'idle',turn:{id:'initial',status:'failed',error:capacity,items:[]},queued:false};
 inspect=vi.fn(async()=>structuredClone(native));start=vi.fn(async(_id,_failed,clientId)=>{native={state:'active',turn:{id:`retry-${start.mock.calls.length}`,status:'inProgress',items:[{type:'userMessage',clientId}]},queued:false};return native.turn.id;});
 manager=create();manager.subscribe('session','native',frame=>frames.push(structuredClone(frame)));
});
afterEach(()=>{manager.close();db.close();vi.useRealTimers();});
describe('bounded durable conversation retries',()=>{
 it('detects future errors in a server monitor without a browser subscription',async()=>{
  manager.monitor('session','user','native');failed!('initial',capacity,false);await vi.advanceTimersByTimeAsync(10000);expect(start).toHaveBeenCalledTimes(1);
 });
 it('waits 10/20/40 seconds and stops after exactly three retries despite repeated failure events',async()=>{
  failure();failure();expect(status()).toMatchObject({attempt:0,status:'waiting'});await vi.advanceTimersByTimeAsync(9999);expect(start).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);expect(start).toHaveBeenCalledTimes(1);expect(status()).toMatchObject({attempt:1,status:'running'});
  await failRetry();await vi.advanceTimersByTimeAsync(19999);expect(start).toHaveBeenCalledTimes(1);await vi.advanceTimersByTimeAsync(1);expect(start).toHaveBeenCalledTimes(2);
  await failRetry();await vi.advanceTimersByTimeAsync(40000);expect(start).toHaveBeenCalledTimes(3);await failRetry();expect(status()).toMatchObject({attempt:3,status:'exhausted'});
  manager.failure('session','user','native',native.turn.id,capacity,false);failure();await vi.advanceTimersByTimeAsync(600000);expect(start).toHaveBeenCalledTimes(3);
 });
 it('shares one budget across page reloads and browser subscriptions',async()=>{
  failure();await vi.advanceTimersByTimeAsync(4000);manager.close();manager=create();const restored:ConversationRetryFrame[]=[];const unsubscribe=manager.subscribe('session','native',frame=>restored.push(frame));failure();unsubscribe();
  await vi.advanceTimersByTimeAsync(5999);expect(start).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(1);expect(start).toHaveBeenCalledTimes(1);expect(readJob()).toMatchObject({attempt:1,status:'running'});
 });
 it('continues a retry job after every browser disconnects',async()=>{
  const unsubscribe=manager.subscribe('session','native',()=>{});failure();unsubscribe();await vi.advanceTimersByTimeAsync(10000);expect(start).toHaveBeenCalledTimes(1);
  native.state='idle';native.turn.status='completed';snapshot();await settle();expect(readJob().status).toBe('succeeded');expect(stops).toHaveBeenCalled();
 });
 it.each([true,false])('ignores native retry notifications and permanent failures (native retry %s)',async willRetry=>{
  manager.failure('session','user','native','initial',willRetry?capacity:{message:'Login required'},willRetry);await vi.advanceTimersByTimeAsync(60000);expect(start).not.toHaveBeenCalled();expect(frames).toEqual([]);
 });
 it.each(['active','notLoaded'])('does not interfere with a %s native thread',async state=>{
  failure();native.state=state;await vi.advanceTimersByTimeAsync(10000);expect(start).not.toHaveBeenCalled();expect(status()?.status).toBe('cancelled');
 });
 it.each(['queued','newer','final','permission'])('cancels when %s supersedes the failure',async reason=>{
  failure();if(reason==='queued')native.queued=true;if(reason==='newer')native.turn.id='manual';if(reason==='permission')allowed=false;if(reason==='final')native.turn.items=[{type:'agentMessage',phase:'final_answer',text:'Already done'}];
  await vi.advanceTimersByTimeAsync(10000);expect(start).not.toHaveBeenCalled();expect(status()?.status).toBe('cancelled');
 });
 it('cancels immediately on a manual turn or queued message and does not interrupt it',async()=>{
  failure();native.turn.id='manual';snapshot();await vi.advanceTimersByTimeAsync(10000);expect(status()?.status).toBe('cancelled');expect(start).not.toHaveBeenCalled();
  manager.failure('session','user','native','another',capacity,false);emit({type:'queue',messages:[{id:'queued',role:'user',text:'new message',timestamp:null}]});await vi.advanceTimersByTimeAsync(10000);expect(start).not.toHaveBeenCalled();
 });
 it('can stop a pending retry explicitly',async()=>{
  failure();manager.cancel('session','other-native');expect(status()?.status).toBe('waiting');manager.cancel('session','native');await vi.advanceTimersByTimeAsync(10000);expect(status()?.status).toBe('cancelled');expect(start).not.toHaveBeenCalled();
 });
 it('never blindly resubmits a timed out dispatch, including after restart',async()=>{
  start.mockRejectedValue(new Error('response lost'));failure();await vi.advanceTimersByTimeAsync(10000);expect(status()).toMatchObject({attempt:1,status:'unknown'});manager.close();manager=create();failure();await vi.advanceTimersByTimeAsync(100000);expect(start).toHaveBeenCalledTimes(1);
 });
 it('recovers a persisted submitting job only if the native correlation id confirms acceptance',async()=>{
  failure();const job=readJob();job.status='submitting';job.attempt=1;job.client_id='recover-id';db.prepare('UPDATE conversation_retries SET data=?').run(JSON.stringify(job));manager.close();
  native={state:'active',turn:{id:'accepted',status:'inProgress',items:[{type:'userMessage',clientId:'recover-id'}]},queued:false};manager=create();await settle();expect(readJob()).toMatchObject({status:'running',retry_turn_id:'accepted',attempt:1});expect(start).not.toHaveBeenCalled();
 });
 it('does not resume an uncertain dispatch if its correlation cannot be found',async()=>{
  failure();const job=readJob();job.status='submitting';job.attempt=1;job.client_id='lost';db.prepare('UPDATE conversation_retries SET data=?').run(JSON.stringify(job));manager.close();manager=create();await settle();expect(readJob().status).toBe('unknown');await vi.advanceTimersByTimeAsync(100000);expect(start).not.toHaveBeenCalled();
 });
 it('treats interrupted and permanent failures in a retry as terminal',async()=>{
  failure();await vi.advanceTimersByTimeAsync(10000);native.state='idle';native.turn.status='interrupted';snapshot();await settle();expect(status()?.status).toBe('cancelled');await vi.advanceTimersByTimeAsync(100000);expect(start).toHaveBeenCalledTimes(1);
 });
 it('does not start with revoked permissions',async()=>{allowed=false;failure();await vi.advanceTimersByTimeAsync(100000);expect(start).not.toHaveBeenCalled();expect(frames).toEqual([]);});
 it('only classifies explicit temporary service overloads',()=>{
  expect(retryableConversationError(capacity)).toBe(true);for(const message of ['Unauthorized','Rate limit reached, check your billing','Invalid model','Network request timed out'])expect(retryableConversationError({message})).toBe(false);
 });
});
