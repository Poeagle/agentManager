import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createServer,type Server} from 'http';
import {mkdtempSync,rmSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import {WebSocketServer,type WebSocket} from 'ws';
import {agentContext,getAgent} from '../src/services/agents/index.js';
import type {AgentStreamFrame} from '../src/services/agents/events.js';

let server:Server,wss:WebSocketServer,peer:WebSocket,dir:string;
let stops:Array<()=>void>,frames:AgentStreamFrame[],requests:Array<{method:string;params:any}>;
let initializes:number,failFirst:boolean,stallFirst:boolean,oversized:boolean,paginated:boolean;
let holdItems:boolean,releaseItems:(()=>void)|undefined,pageItems:any[],nativeActive:boolean;
let holdQueue:boolean,releaseQueue:(()=>void)|undefined;
let queueItems:any[];
const native='019ff001-3030-7303-8303-303030303030';
beforeEach(async()=>{
 dir=mkdtempSync(join(tmpdir(),'stream-recovery-'));vi.stubEnv('AGENTMANAGER_CODEX_STREAM_SOCKET',join(dir,'sock'));
 stops=[];frames=[];requests=[];initializes=0;failFirst=false;stallFirst=false;oversized=false;paginated=false;
 holdItems=false;releaseItems=undefined;pageItems=[{type:'agentMessage',id:'recent',phase:'commentary',text:'recent progress',completedAtMs:Date.now()}];nativeActive=true;
 holdQueue=false;releaseQueue=undefined;
 queueItems=[];
 server=createServer();wss=new WebSocketServer({server});
 wss.on('connection',socket=>{peer=socket;socket.on('message',bytes=>{
  const {id,method,params}=JSON.parse(bytes.toString());if(!id||!method)return;requests.push({method,params});
  if(method==='initialize'&&++initializes===1){if(stallFirst)return;if(failFirst){socket.send(JSON.stringify({id,error:{code:-32603,message:'temporary initialization failure'}}));return;}}
  let result:any={};
  if(method==='thread/read')result={thread:{status:{type:nativeActive?'active':'idle'}}};
  if(method==='thread/queue/list'){const offset=Number(params.cursor||0),limit=params.limit??100;result={data:queueItems.slice(offset,offset+limit),nextCursor:offset+limit<queueItems.length?String(offset+limit):null};if(holdQueue){releaseQueue=()=>socket.send(JSON.stringify({id,result}));return;}}
  if(method==='thread/turns/list')result={data:[{id:'turn',status:'inProgress',itemsView:paginated?'summary':params.itemsView,items:oversized&&params.itemsView!=='notLoaded'?[{id:'large-tool',type:'commandExecution',aggregatedOutput:'x'.repeat(2*1024*1024+4096)}]:[]}]};
  if(method==='thread/items/list'){result={data:pageItems.map(item=>({item})),nextCursor:'older-items'};if(holdItems){releaseItems=()=>socket.send(JSON.stringify({id,result}));return;}}
  socket.send(JSON.stringify({id,result}));
 });});
 await new Promise<void>(resolve=>server.listen(join(dir,'sock'),resolve));
});
afterEach(async()=>{
 for(const stop of stops)stop();for(const client of wss.clients)client.terminate();
 await new Promise<void>(resolve=>wss.close(()=>resolve()));await new Promise<void>(resolve=>server.close(()=>resolve()));
 vi.unstubAllEnvs();rmSync(dir,{recursive:true,force:true});
});
function observe(id='platform'){
 const context=agentContext({id,cli_type:'codex',codex_session_id:native,created_by_user_id:'owner',project_path:dir});
 stops.push(getAgent('codex').stream.observe({...context,streamFormat:'incremental'},frame=>frames.push(frame)));
}
const send=(method:string,params:any)=>{if(method==='turn/completed')nativeActive=false;if(method==='turn/started')nativeActive=true;peer.send(JSON.stringify({method,params:{threadId:native,turnId:'turn',...params}}));};
describe('native stream recovery and incremental transport',()=>{
 it('recovers a queue larger than the native payload limit through bounded pages',async()=>{
  queueItems=Array.from({length:40},(_,index)=>({id:`queued-${index}`,clientUserMessageId:`client-${index}`,input:[{type:'text',text:'x'.repeat(56*1024)}]}));observe();
  await vi.waitFor(()=>expect(frames.some(frame=>frame.type==='queue'&&frame.messages.length===40)).toBe(true),{timeout:2000});
  expect(initializes).toBe(1);expect(requests.filter(request=>request.method==='thread/queue/list')).toHaveLength(10);expect(requests.filter(request=>request.method==='thread/queue/list').every(request=>request.params.limit===4)).toBe(true);
 });
 it('coalesces bursts of queue changes into one in-flight read and one catch-up read',async()=>{
  holdQueue=true;observe();await vi.waitFor(()=>expect(releaseQueue).toBeTypeOf('function'));
  for(let i=0;i<100;i++)send('thread/queue/changed',{});
  await new Promise(resolve=>setTimeout(resolve,40));expect(requests.filter(request=>request.method==='thread/queue/list')).toHaveLength(1);
  holdQueue=false;releaseQueue!();await vi.waitFor(()=>expect(frames.some(frame=>frame.type==='queue')).toBe(true));
  expect(requests.filter(request=>request.method==='thread/queue/list')).toHaveLength(2);
 });
 it('never lets a delayed recovery baseline overwrite live completion or newer text',async()=>{
  holdItems=true;pageItems=[{type:'agentMessage',id:'current',phase:'commentary',text:'old snapshot with a much longer outdated prefix'}];observe();
  await vi.waitFor(()=>expect(releaseItems).toBeTypeOf('function'));
  send('turn/started',{turn:{id:'turn'}});send('item/completed',{item:{type:'agentMessage',id:'current',phase:'final_answer',text:'new answer'}});send('turn/completed',{turn:{id:'turn',status:'completed'}});
  await vi.waitFor(()=>expect(frames.some(frame=>frame.type==='patch'&&frame.state?.busy===false)).toBe(true));const before=frames.length;
  releaseItems!();await vi.waitFor(()=>expect(requests.filter(request=>request.method==='thread/read')).toHaveLength(2));
  const after=frames.slice(before);expect(after.some(frame=>frame.type==='snapshot'&&frame.busy||frame.type==='patch'&&frame.state?.busy)).toBe(false);
  const late:AgentStreamFrame[]=[];stops.push(getAgent('codex').stream.observe({...agentContext({id:'late',cli_type:'codex',codex_session_id:native,created_by_user_id:'owner',project_path:dir}),streamFormat:'incremental'},frame=>late.push(frame)));
  expect(late.find(frame=>frame.type==='snapshot')).toMatchObject({busy:false,stage:'idle',messages:[{text:'new answer',phase:'final',streaming:false}]});
 });
 it('fills a missing running activity when live events race a reconnect baseline',async()=>{
  holdItems=true;pageItems=[{type:'commandExecution',id:'still-running',command:'long operation',status:'inProgress',startedAtMs:Date.now()}];observe();
  await vi.waitFor(()=>expect(releaseItems).toBeTypeOf('function'));
  send('turn/started',{turn:{id:'turn'}});send('item/started',{item:{type:'reasoning',id:'reasoning-event'}});
  releaseItems!();await vi.waitFor(()=>expect(frames.some(frame=>frame.type==='snapshot'&&frame.activities.some(activity=>activity.id==='still-running'&&activity.status==='running')||frame.type==='patch'&&frame.state?.activities?.some(activity=>activity.id==='still-running'&&activity.status==='running'))).toBe(true));
 });
 it('recovers when initialize never answers, even while the native socket stays open',async()=>{
  stallFirst=true;observe();await vi.waitFor(()=>expect(initializes).toBe(1));
  await vi.waitFor(()=>expect(frames.some(frame=>frame.type==='snapshot')).toBe(true),{timeout:8000,interval:50});
  expect(initializes).toBe(2);expect(requests.map(request=>request.method)).not.toContain('turn/start');
 },10000);
 it('retries failed initialization without replaying user input and shares recovery among viewers',async()=>{
  failFirst=true;observe();observe('another-platform-tab');
  await vi.waitFor(()=>expect(frames.some(frame=>frame.type==='unavailable'&&frame.retrying)).toBe(true));
  await vi.waitFor(()=>expect(frames.some(frame=>frame.type==='snapshot')).toBe(true),{timeout:2500});
  expect(initializes).toBe(2);expect(requests.map(request=>request.method)).not.toContain('turn/start');expect(requests.map(request=>request.method)).not.toContain('thread/start');
 });
 it('recovers an oversized baseline using metadata and receives live deltas without their old item prefix',async()=>{
  oversized=true;observe();
  await vi.waitFor(()=>expect(frames.some(frame=>frame.type==='snapshot')).toBe(true),{timeout:2500});
  expect(requests.filter(request=>request.method==='thread/turns/list').map(request=>request.params.itemsView)).toEqual(['summary','notLoaded']);expect(initializes).toBe(2);
  send('item/agentMessage/delta',{itemId:'after-reconnect',delta:'still streaming'});
  await vi.waitFor(()=>expect(frames.some(frame=>frame.type==='patch'&&frame.upserts.some(message=>message.text==='still streaming'))).toBe(true));
  expect(requests.some(request=>request.params?.itemsView==='full')).toBe(false);
 });
 it('pages recent items and sends only changed text until an immediate completion update',async()=>{
  paginated=true;observe();await vi.waitFor(()=>expect(frames.some(frame=>frame.type==='snapshot')).toBe(true));
  expect(requests.find(request=>request.method==='thread/items/list')?.params).toMatchObject({limit:8,sortDirection:'desc'});
  send('item/started',{item:{type:'agentMessage',id:'current',phase:'commentary',text:''}});
  send('item/agentMessage/delta',{itemId:'current',delta:'first'});
  await vi.waitFor(()=>expect(frames.some(frame=>frame.type==='patch'&&frame.upserts.some(message=>message.text==='first'))).toBe(true));
  frames=[];send('item/agentMessage/delta',{itemId:'current',delta:' second'});
  await vi.waitFor(()=>expect(frames.some(frame=>frame.type==='patch'&&frame.deltas.some(delta=>delta.offset===5&&delta.text===' second'))).toBe(true));
  expect(JSON.stringify(frames)).not.toContain('recent progress');expect(frames.every(frame=>frame.type==='patch')).toBe(true);
  const completed=Date.now();send('item/completed',{completedAtMs:completed,item:{type:'agentMessage',id:'current',phase:'commentary',text:'first second'}});send('turn/completed',{turn:{id:'turn',status:'completed',completedAt:completed/1000}});
  await vi.waitFor(()=>expect(frames.some(frame=>frame.type==='patch'&&frame.upserts.some(message=>message.streaming===false&&message.timestamp===new Date(completed).toISOString()))).toBe(true));
  expect(frames.at(-1)).toMatchObject({type:'patch',state:{busy:false,stage:'idle'}});expect(requests.map(request=>request.method)).not.toContain('turn/start');
 });
 it('keeps subsequent text traffic independent of the completed messages in a long turn',async()=>{
  observe();await vi.waitFor(()=>expect(frames.some(frame=>frame.type==='snapshot')).toBe(true));
  for(let i=0;i<20;i++)send('item/completed',{item:{type:'agentMessage',id:`old-${i}`,phase:'commentary',text:`OLD_${i}:`+'x'.repeat(4096)}});
  send('item/started',{item:{type:'agentMessage',id:'live',phase:'commentary',text:''}});
  await vi.waitFor(()=>expect(frames.some(frame=>frame.type==='patch'&&frame.upserts.some(message=>message.text.startsWith('OLD_19:')))).toBe(true));
  frames=[];
  for(let i=0;i<10;i++){
   send('item/agentMessage/delta',{itemId:'live',delta:'y'.repeat(256)});
   await vi.waitFor(()=>expect(frames.length).toBeGreaterThan(i),{interval:10});
  }
  const bytes=Buffer.byteLength(JSON.stringify(frames)),oldMinimum=20*4096*10;
  expect(bytes).toBeLessThan(oldMinimum*0.05);expect(JSON.stringify(frames)).not.toContain('OLD_');
 });
});
