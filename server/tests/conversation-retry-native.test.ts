import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createServer,type Server} from 'http';
import {mkdtempSync,rmSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import {WebSocketServer} from 'ws';
import {inspectRetryThread,startRetryTurn} from '../src/services/conversation-retry.js';
import {observeCodexConversation} from '../src/services/agents/codex/stream.js';
let server:Server,wss:WebSocketServer,dir:string,requests:Array<{method:string;params:any}>,state:string,turn:any,queued:boolean,stop:(()=>void)|undefined;
beforeEach(async()=>{
 dir=mkdtempSync(join(tmpdir(),'retry-native-'));const path=join(dir,'socket');vi.stubEnv('AGENTMANAGER_CODEX_STREAM_SOCKET',path);requests=[];state='idle';queued=false;turn={id:'failed',status:'failed',error:{message:'Selected model is at capacity.'},items:[]};server=createServer();wss=new WebSocketServer({server});
 wss.on('connection',socket=>socket.on('message',bytes=>{const frame=JSON.parse(bytes.toString());if(!frame.method)return;requests.push(frame);if(frame.id==null)return;
  const result=frame.method==='thread/read'?{thread:{status:{type:state}}}:frame.method==='thread/turns/list'?{data:[turn]}:frame.method==='thread/queue/list'?{data:queued?[{id:'manual'}]:[]}:frame.method==='turn/start'?{turn:{id:'retry'}}:{};socket.send(JSON.stringify({id:frame.id,result}));
 }));await new Promise<void>(resolve=>server.listen(path,resolve));
});
afterEach(async()=>{stop?.();stop=undefined;for(const client of wss.clients)client.terminate();await new Promise<void>(resolve=>wss.close(()=>resolve()));await new Promise<void>(resolve=>server.close(()=>resolve()));vi.unstubAllEnvs();rmSync(dir,{recursive:true,force:true});});
describe('native retry transport',()=>{
 it.each(['async','final'])('rechecks %s final-phase messages on the actual dispatch connection',async kind=>{
  turn.items=[{type:'agentMessage',phase:'final_answer',text:'内容',...(kind==='async'?{delivery:'async',questions:[{title:'哪个目录？',options:['A','B']}]}:{})}];
  if(kind==='async'){expect(await startRetryTurn('native','failed','correlation')).toBe('retry');expect(requests.filter(call=>call.method==='turn/start')).toHaveLength(1);}
  else{await expect(startRetryTurn('native','failed','correlation')).rejects.toThrow('final_answer');expect(requests.some(call=>call.method==='turn/start')).toBe(false);}
 });
 it('continues the same thread once and asks to check completed operations',async()=>{
  expect(await startRetryTurn('native','failed','correlation')).toBe('retry');const calls=requests.filter(call=>call.method==='turn/start');expect(calls).toHaveLength(1);expect(calls[0].params).toMatchObject({threadId:'native',parentTurnId:'failed',clientUserMessageId:'correlation'});expect(calls[0].params.input[0].text).toContain('避免重复执行');expect(calls[0].params).not.toHaveProperty('model');expect(requests.some(call=>['thread/start','thread/archive','thread/resume'].includes(call.method))).toBe(false);
 });
 it.each(['active','queued','new-turn'])('rechecks %s before dispatch',async condition=>{
  if(condition==='active')state='active';if(condition==='queued')queued=true;if(condition==='new-turn')turn.id='manual';await expect(startRetryTurn('native','failed','correlation')).rejects.toThrow();expect(requests.some(call=>call.method==='turn/start')).toBe(false);
 });
 it('does not load an embedded CLI through a different daemon',async()=>{state='notLoaded';expect(await inspectRetryThread('native')).toEqual({state:'notLoaded',turn:null,queued:false});expect(requests.map(call=>call.method)).not.toContain('thread/resume');expect(requests.map(call=>call.method)).not.toContain('thread/turns/list');});
 it('does not treat baseline errors as fresh retry triggers',async()=>{
  const failure=vi.fn();stop=observeCodexConversation('native',()=>{},failure);await vi.waitFor(()=>expect(requests.some(call=>call.method==='thread/turns/list')).toBe(true));await new Promise(resolve=>setTimeout(resolve,20));expect(failure).not.toHaveBeenCalled();
  for(const socket of wss.clients)socket.send(JSON.stringify({method:'error',params:{threadId:'native',turnId:'failed',error:turn.error,willRetry:true}}));await vi.waitFor(()=>expect(failure).toHaveBeenCalledWith('failed',turn.error,true));
 });
});
