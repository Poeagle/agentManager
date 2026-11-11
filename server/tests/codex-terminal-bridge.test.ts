import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import WebSocket,{WebSocketServer} from 'ws';
import {projectCodexTerminalFrame} from '../src/services/agents/codex/terminal-projection.js';
import {startCodexTerminalBridge} from '../src/services/agents/codex/terminal-bridge.js';

const first=JSON.stringify(['request_user_input_async','question',0]),second=JSON.stringify(['request_user_input_async','question',1]);
const envelope='<send_user_message_question_reply>\n'+JSON.stringify([{questionItemId:first,question:'使用哪个环境？',answer:'见截图'}])+'\n</send_user_message_question_reply>';
const content=[{type:'text',text:envelope+'[Image #1]\n\n附件：\n- result.txt: /project/.agentmanager/pastes/result.txt',text_elements:[]},{type:'localImage',path:'/project/.agentmanager/pastes/answer.png'}];
const item={type:'userMessage',id:'answer-item',clientId:'answer-client',content};
const notification={method:'item/completed',params:{threadId:'thread',turnId:'turn',item}};
// Codex 0.166 TUI's parse_input contract. Unlike the model, it requires one
// text-only input and an envelope ending at the end of that text.
function nativeTuiReplyIds(input:any[]){if(input.length!==1||input[0].type!=='text'||!input[0].text.trim().endsWith('</send_user_message_question_reply>'))return [];try{return JSON.parse(input[0].text.trim().slice('<send_user_message_question_reply>'.length,-'</send_user_message_question_reply>'.length)).map((answer:any)=>answer.questionItemId);}catch{return [];}}

describe('Codex terminal receipt compatibility',()=>{
 it('resolves the answered question only, without modifying native input or its attachments',()=>{
  expect(nativeTuiReplyIds(content)).toEqual([]);
  const before=JSON.stringify(notification),frame=projectCodexTerminalFrame(notification);
  expect(nativeTuiReplyIds(frame.params.item.content)).toEqual([first]);expect(JSON.stringify(notification)).toBe(before);
  expect(frame.params.item).toMatchObject({id:item.id,clientId:item.clientId});
  expect([first,second].filter(id=>!nativeTuiReplyIds(frame.params.item.content).includes(id))).toEqual([second]);
 });
 it('restores old image spans that split the reply wrapper only when a native image is present',()=>{
  const broken=envelope.slice(0,4)+'[Image #1]'+envelope.slice(4);
  const frame={...notification,params:{...notification.params,item:{...item,content:[{type:'text',text:broken},content[1]]}}};
  expect(nativeTuiReplyIds(projectCodexTerminalFrame(frame).params.item.content)).toEqual([first]);
  const plain={...frame,params:{...frame.params,item:{...item,content:[{type:'text',text:broken}]}}};expect(projectCodexTerminalFrame(plain)).toBe(plain);
 });
 it('projects history replay as well as live receipts and leaves ordinary messages and tool output intact',()=>{
  const history={id:1,result:{thread:{turns:[{id:'turn',items:[item]}]}}};
  const projected=projectCodexTerminalFrame(history,'thread/read');expect(nativeTuiReplyIds(projected.result.thread.turns[0].items[0].content)).toEqual([first]);expect(history.result.thread.turns[0].items[0]).toBe(item);
  expect(projectCodexTerminalFrame(history,'unknown')).toBe(history);
  for(const frame of [{method:'item/completed',params:{item:{type:'commandExecution',output:notification}}},{method:'item/completed',params:{item:{...item,content:[{type:'text',text:'普通消息'}]}}},{type:'state',busy:true}])expect(projectCodexTerminalFrame(frame)).toBe(frame);
  const pure={...notification,params:{...notification.params,item:{...item,content:[{type:'text',text:envelope}]}}};expect(projectCodexTerminalFrame(pure)).toBe(pure);
  const unrelated={...notification,params:{...notification.params,item:{...item,content:[{type:'text',text:envelope+' arbitrary trailing text'},content[1]]}}};expect(projectCodexTerminalFrame(unrelated)).toBe(unrelated);
 });
 it('forwards one unmodified model submission and normalizes only the terminal response stream',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'am-tui-test-')),upstream=createServer(),native=new WebSocketServer({server:upstream}),received:string[]=[];
  await new Promise<void>(resolve=>upstream.listen(join(dir,'native.sock'),resolve));
  native.on('connection',socket=>socket.on('message',bytes=>{received.push(bytes.toString());const frame=JSON.parse(bytes.toString());if(frame.method==='turn/start'){socket.send(JSON.stringify({id:frame.id,result:{}}));socket.send(JSON.stringify(notification));}else socket.send(JSON.stringify({id:frame.id,result:{thread:{turns:[{id:'turn',items:[item]}]}}}));}));
  const bridge=await startCodexTerminalBridge(join(dir,'terminal.sock'),join(dir,'native.sock')),client=new WebSocket(`ws+unix://${join(dir,'terminal.sock')}:/`),frames:any[]=[];
  client.on('message',bytes=>frames.push(JSON.parse(bytes.toString())));
  try{
   await new Promise<void>(resolve=>client.once('open',resolve));
   const request=JSON.stringify({id:1,method:'turn/start',params:{threadId:'thread',clientUserMessageId:item.clientId,input:content}});client.send(request);
   await vi.waitFor(()=>expect(frames.some(frame=>frame.method==='item/completed')).toBe(true));
   expect(received).toEqual([request]);expect(JSON.parse(received[0]).params.input).toEqual(content);expect(nativeTuiReplyIds(frames.find(frame=>frame.method==='item/completed').params.item.content)).toEqual([first]);
   client.send(JSON.stringify({id:2,method:'thread/read',params:{threadId:'thread'}}));await vi.waitFor(()=>expect(frames.some(frame=>frame.id===2)).toBe(true));expect(nativeTuiReplyIds(frames.find(frame=>frame.id===2).result.thread.turns[0].items[0].content)).toEqual([first]);
   expect(received.filter(raw=>JSON.parse(raw).method==='turn/start')).toHaveLength(1);
  }finally{client.terminate();await bridge.stop();for(const socket of native.clients)socket.terminate();await new Promise<void>(resolve=>native.close(()=>resolve()));await new Promise<void>(resolve=>upstream.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});}
 });
 it('accepts a terminal reconnect after the upstream tunnel is recreated',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'am-tui-reconnect-')),path=join(dir,'native.sock'),received:string[]=[];
  const makeUpstream=async()=>{const server=createServer(),wss=new WebSocketServer({server});wss.on('connection',ws=>ws.on('message',data=>{received.push(data.toString());ws.send(data);}));await new Promise<void>(resolve=>server.listen(path,resolve));return {server,wss};};
  let upstream=await makeUpstream();const bridge=await startCodexTerminalBridge(join(dir,'terminal.sock'),path),url=`ws+unix://${join(dir,'terminal.sock')}:/`;
  let first:WebSocket|undefined,second:WebSocket|undefined;
  try{
   first=new WebSocket(url);await new Promise<void>(resolve=>first!.once('open',resolve));first.send('first');await vi.waitFor(()=>expect(received).toEqual(['first']));
   const closed=new Promise<void>(resolve=>first!.once('close',()=>resolve()));for(const ws of upstream.wss.clients)ws.terminate();await closed;
   await new Promise<void>(resolve=>upstream.wss.close(()=>resolve()));await new Promise<void>(resolve=>upstream.server.close(()=>resolve()));
   upstream=await makeUpstream();second=new WebSocket(url);await new Promise<void>(resolve=>second!.once('open',resolve));second.send('second');await vi.waitFor(()=>expect(received).toEqual(['first','second']));
  }finally{first?.terminate();second?.terminate();await bridge.stop();for(const ws of upstream.wss.clients)ws.terminate();await new Promise<void>(resolve=>upstream.wss.close(()=>resolve()));await new Promise<void>(resolve=>upstream.server.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});}
 });
 it('releases an unused bridge without polling or touching the native engine',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'am-tui-idle-')),onIdle=vi.fn();
  const bridge=await startCodexTerminalBridge(join(dir,'terminal.sock'),join(dir,'missing.sock'),{idleMs:10,onIdle});
  try{await vi.waitFor(()=>expect(onIdle).toHaveBeenCalledOnce());}finally{await bridge.stop();rmSync(dir,{recursive:true,force:true});}
 });
});
