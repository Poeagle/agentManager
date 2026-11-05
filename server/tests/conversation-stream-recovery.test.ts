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
const native='019ff001-3030-7303-8303-303030303030';
beforeEach(async()=>{
 dir=mkdtempSync(join(tmpdir(),'stream-recovery-'));vi.stubEnv('AGENTMANAGER_CODEX_STREAM_SOCKET',join(dir,'sock'));
 stops=[];frames=[];requests=[];initializes=0;failFirst=false;stallFirst=false;oversized=false;paginated=false;
 server=createServer();wss=new WebSocketServer({server});
 wss.on('connection',socket=>{peer=socket;socket.on('message',bytes=>{
  const {id,method,params}=JSON.parse(bytes.toString());if(!id||!method)return;requests.push({method,params});
  if(method==='initialize'&&++initializes===1){if(stallFirst)return;if(failFirst){socket.send(JSON.stringify({id,error:{code:-32603,message:'temporary initialization failure'}}));return;}}
  let result:any={};
  if(method==='thread/read')result={thread:{status:{type:'active'}}};
  if(method==='thread/queue/list')result={data:[]};
  if(method==='thread/turns/list')result={data:[{id:'turn',status:'inProgress',itemsView:paginated?'summary':params.itemsView,items:oversized&&params.itemsView!=='notLoaded'?[{id:'large-tool',type:'commandExecution',aggregatedOutput:'x'.repeat(2*1024*1024+4096)}]:[]}]};
  if(method==='thread/items/list')result={data:[{item:{type:'agentMessage',id:'recent',phase:'commentary',text:'recent progress',completedAtMs:Date.now()}}],nextCursor:'older-items'};
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
const send=(method:string,params:any)=>peer.send(JSON.stringify({method,params:{threadId:native,turnId:'turn',...params}}));
describe('native stream recovery and incremental transport',()=>{
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
