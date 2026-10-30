import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createServer,type Server} from 'http';
import {mkdtempSync,rmSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import {WebSocketServer,type WebSocket} from 'ws';
import {createStreamingCodexThread,interruptStreamingCodexThread,submitStreamingCodexInput,observeCodexConversation,type ConversationStreamFrame} from '../src/services/conversation-stream.js';
import {conversationMessageId} from '../src/services/conversation-reader.js';

let server:Server,wss:WebSocketServer,peer:WebSocket,dir:string,stop:(()=>void)|undefined;
let submissions:any[],requests:string[],frames:ConversationStreamFrame[],loaded:boolean;
let active=false;
let baselineItems:any[]=[];
beforeEach(async()=>{
  dir=mkdtempSync(join(tmpdir(),'chat-stream-'));const path=join(dir,'sock');vi.stubEnv('AGENTMANAGER_CODEX_STREAM_SOCKET',path);
  server=createServer();wss=new WebSocketServer({server});submissions=[];requests=[];frames=[];loaded=true;active=false;baselineItems=[];
  wss.on('connection',socket=>{
    peer=socket;socket.on('message',bytes=>{
      const {id,method,params}=JSON.parse(bytes.toString());requests.push(method);if(method==='turn/start')submissions.push(params);if(!id) return;
      const result=method==='thread/start'?{thread:{id:'019ff001-8888-7888-8888-888888888888'}}:method==='thread/read'?{thread:{status:{type:active?'active':loaded?'idle':'notLoaded'}}}:method==='thread/turns/list'?{data:active?[{id:'turn',status:'inProgress',items:baselineItems}]:[]}:{};
      socket.send(JSON.stringify({id,result}));
    });
  });
  await new Promise<void>(resolve=>server.listen(path,resolve));
});
afterEach(async()=>{stop?.();stop=undefined;for(const client of wss.clients) client.terminate();await new Promise<void>(resolve=>wss.close(()=>resolve()));await new Promise<void>(resolve=>server.close(()=>resolve()));vi.unstubAllEnvs();rmSync(dir,{recursive:true,force:true});});
const send=(method:string,params:unknown)=>peer.send(JSON.stringify({method,params}));
describe('native Codex conversation streaming',()=>{
  it('does not mark already completed progress as streaming when reconnecting during tool execution',async()=>{
    active=true;baselineItems=[{type:'agentMessage',id:'item-resumed',phase:'commentary',text:'正在检查。\n'},{type:'commandExecution',id:'tool',status:'inProgress',command:'private'}];
    stop=observeCodexConversation('thread',frame=>frames.push(frame));
    await vi.waitFor(()=>expect(frames.at(-1)).toMatchObject({type:'snapshot',busy:true,stage:'tools',messages:[{text:'正在检查。\n',streaming:false,timestamp:null}]}));
    expect(JSON.stringify(frames)).not.toContain('private');
  });
  it('submits conversation followups to the existing engine without terminal menus or a second thread',async()=>{
    expect(await submitStreamingCodexInput('thread','能否再详细一下')).toBe(true);
    expect(requests.filter(method=>method==='turn/start')).toHaveLength(1);expect(requests).not.toContain('thread/start');expect(requests).not.toContain('thread/resume');
  });
  it('carries client identity through native user echoes in causal order with the matching answer',async()=>{
    await submitStreamingCodexInput('thread','继续','client-one');expect(submissions[0].clientUserMessageId).toBe('client-one');
    stop=observeCodexConversation('thread',frame=>frames.push(frame));
    await vi.waitFor(()=>expect(requests).toContain('thread/turns/list'));
    send('turn/started',{threadId:'thread',turn:{id:'turn'}});
    send('item/completed',{threadId:'thread',turnId:'turn',item:{type:'userMessage',id:'prompt',clientId:'client-one',content:[{type:'text',text:'继续'}]}});
    send('item/started',{threadId:'thread',turnId:'turn',item:{type:'agentMessage',id:'answer',phase:'final_answer',text:'回答'}});
    await vi.waitFor(()=>expect(frames.at(-1)).toMatchObject({type:'snapshot',messages:[{id:conversationMessageId('turn','user','prompt'),role:'user',client_id:'client-one',text:'继续',streaming:false},{role:'assistant',text:'回答'}]}));
  });
  it('submits images as native localImage inputs and keeps file references in user text',async()=>{
    const attachments=[{kind:'image' as const,name:'截图.png',path:'/project/.agentmanager/pastes/image.png'},{kind:'file' as const,name:'报告.txt',path:'/project/.agentmanager/pastes/report.txt'}];
    expect(await submitStreamingCodexInput('thread','看看附件','client-image',attachments)).toBe(true);
    expect(submissions[0].input).toEqual([{type:'text',text:expect.stringContaining('报告.txt'),text_elements:[]},{type:'localImage',path:attachments[0].path}]);
    expect(submissions[0].input[0].text).not.toContain('agentmanager_attachments');
    await submitStreamingCodexInput('thread','仅图片','image-only',attachments.slice(0,1));
    expect(submissions[1].input[0].text).toBe('仅图片');
  });
  it('retains the terminal input path for an embedded CLI',async()=>{
    loaded=false;expect(await submitStreamingCodexInput('thread','followup')).toBe(false);expect(requests).not.toContain('turn/start');
  });
  it('interrupts a running engine when its terminal session is explicitly stopped',async()=>{
    active=true;await interruptStreamingCodexThread('thread');
    expect(requests).toContain('turn/interrupt');expect(requests).not.toContain('thread/resume');expect(requests).not.toContain('turn/start');
  });
  it('starts the initial prompt once and returns the exact identity used by the terminal',async()=>{
    expect(await createStreamingCodexThread('/project','initial request')).toBe('019ff001-8888-7888-8888-888888888888');
    expect(requests.filter(method=>method==='thread/start')).toHaveLength(1);expect(requests.filter(method=>method==='turn/start')).toHaveLength(1);
  });
  it('streams real deltas into one stable message, includes intermediate progress, excludes tools/reasoning and settles without duplication',async()=>{
    stop=observeCodexConversation('thread',frame=>frames.push(frame));
    await vi.waitFor(()=>expect(requests).toContain('thread/turns/list'));
    send('turn/started',{threadId:'thread',turn:{id:'turn'}});
    await vi.waitFor(()=>expect(frames.at(-1)).toMatchObject({type:'snapshot',messages:[],stage:'waiting',turn_id:'turn',busy:true}));
    send('item/started',{threadId:'thread',turnId:'turn',item:{type:'agentMessage',id:'comment',phase:'commentary',text:'正在检查'}});
    send('item/agentMessage/delta',{threadId:'thread',turnId:'turn',itemId:'comment',delta:'项目结构'});
    send('item/started',{threadId:'thread',turnId:'turn',item:{type:'commandExecution',id:'tool',command:'secret command'}});
    send('item/started',{threadId:'thread',turnId:'turn',item:{type:'agentMessage',id:'answer',phase:'final_answer',text:''}});
    send('item/agentMessage/delta',{threadId:'thread',turnId:'turn',itemId:'answer',delta:'逐段'});
    await vi.waitFor(()=>expect(frames.some(frame=>frame.type==='snapshot' && frame.messages.some(message=>message.text==='逐段' && message.streaming))).toBe(true));
    expect(frames.some(frame=>frame.type==='snapshot' && frame.messages.some(message=>message.text==='正在检查项目结构' && message.phase==='commentary'))).toBe(true);
    send('item/agentMessage/delta',{threadId:'other',turnId:'turn',itemId:'answer',delta:'OTHER THREAD'});
    send('item/agentMessage/delta',{threadId:'thread',turnId:'turn',itemId:'answer',delta:'输出'});
    await vi.waitFor(()=>expect(frames.at(-1)).toMatchObject({type:'snapshot',stage:'answering',messages:[{text:'正在检查项目结构',phase:'commentary',streaming:true},{id:conversationMessageId('turn','assistant','answer'),text:'逐段输出',phase:'final',streaming:true}]}));
    send('item/completed',{threadId:'thread',turnId:'turn',item:{type:'agentMessage',id:'answer',phase:'final_answer',text:'逐段输出'}});
    send('turn/completed',{threadId:'thread',turn:{id:'turn'}});
    await vi.waitFor(()=>expect(frames.at(-1)).toMatchObject({type:'snapshot',busy:false,messages:[{text:'正在检查项目结构',streaming:false},{text:'逐段输出',streaming:false}]}));
    expect(JSON.stringify(frames)).not.toMatch(/secret command|OTHER THREAD/);
    expect(requests).not.toContain('turn/start');expect(requests).not.toContain('thread/start');
  });
  it('preserves distinct answer items when a followup joins a still-active turn',async()=>{
    stop=observeCodexConversation('thread',frame=>frames.push(frame));
    await vi.waitFor(()=>expect(requests).toContain('thread/turns/list'));
    send('turn/started',{threadId:'thread',turn:{id:'same-turn'}});
    send('item/completed',{threadId:'thread',turnId:'same-turn',item:{type:'agentMessage',id:'first-answer',phase:'final_answer',text:'第一段回答'}});
    send('item/started',{threadId:'thread',turnId:'same-turn',item:{type:'agentMessage',id:'followup-answer',phase:'final_answer',text:''}});
    send('item/agentMessage/delta',{threadId:'thread',turnId:'same-turn',itemId:'followup-answer',delta:'追问的回答'});
    await vi.waitFor(()=>{
      const frame=frames.at(-1);expect(frame?.type).toBe('snapshot');
      if(frame?.type==='snapshot') {expect(frame.messages.map(item=>item.text)).toEqual(['第一段回答','追问的回答']);expect(new Set(frame.messages.map(item=>item.id)).size).toBe(2);}
    });
  });
  it('never resumes an embedded or unloaded thread into a second engine',async()=>{
    loaded=false;stop=observeCodexConversation('thread',frame=>frames.push(frame));
    await vi.waitFor(()=>expect(frames.at(-1)?.type).toBe('unavailable'));
    expect(requests).not.toContain('thread/resume');expect(requests).not.toContain('turn/start');
  });
});
