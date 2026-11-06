import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createServer,type Server} from 'http';
import {mkdtempSync,rmSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import {WebSocketServer,type WebSocket} from 'ws';
import {createStreamingCodexThread,interruptStreamingCodexThread,configureStreamingSharedResources,submitStreamingCodexInput,observeCodexConversation,type ConversationStreamFrame} from '../src/services/agents/codex/stream.js';
import {conversationMessageId} from '../src/services/conversation-reader.js';

let server:Server,wss:WebSocketServer,peer:WebSocket,dir:string,stop:(()=>void)|undefined;
let submissions:any[],requests:string[],frames:ConversationStreamFrame[],loaded:boolean;
let active=false,oversizedSummary=false,dropDispatch=false;
let humanRequests:any[]=[],humanResponses:any[]=[];
let baselineItems:any[]=[];
let baselineFailure:any=null;
let queueEntries:any[]=[],turnStartFailure:string|null=null;
let requestParams: Array<{method:string;params:any}> = [];
beforeEach(async()=>{
  dir=mkdtempSync(join(tmpdir(),'chat-stream-'));const path=join(dir,'sock');vi.stubEnv('AGENTMANAGER_CODEX_STREAM_SOCKET',path);
  server=createServer();wss=new WebSocketServer({server});submissions=[];requests=[];frames=[];loaded=true;active=false;baselineItems=[];baselineFailure=null;queueEntries=[];turnStartFailure=null;humanRequests=[];humanResponses=[];requestParams=[];oversizedSummary=false;dropDispatch=false;
  wss.on('connection',socket=>{
    peer=socket;socket.on('message',bytes=>{
      const frame=JSON.parse(bytes.toString());const {id,method,params}=frame;if(!method){humanResponses.push(frame);return;}requests.push(method);requestParams.push({method,params});if(method==='thread/resume')for(const request of humanRequests)socket.send(JSON.stringify(request));if(method==='turn/start'||method==='turn/steer')submissions.push(params);if(!id) return;
      if(method==='turn/steer'&&active&&baselineItems.some(item=>item.type==='contextCompaction'&&item.status!=='completed')){socket.send(JSON.stringify({id,error:{message:'cannot steer a compact turn',code:-32600}}));return;}
      if((method==='turn/start'||method==='turn/steer')&&turnStartFailure){socket.send(JSON.stringify({id,error:{message:turnStartFailure,code:-32600}}));return;}
      if((method==='turn/start'||method==='turn/steer')&&dropDispatch){socket.terminate();return;}
      if(method==='thread/queue/add')queueEntries.push({id:`queued-${queueEntries.length}`,clientUserMessageId:params.clientUserMessageId,input:params.input});
      if(method==='thread/queue/add'||method==='thread/queue/list'){socket.send(JSON.stringify({id,result:method==='thread/queue/add'?{queuedSubmission:queueEntries.at(-1)}:{data:queueEntries}}));return;}
      const result=method==='turn/steer'?{turnId:params.expectedTurnId}:method==='thread/start'?{thread:{id:'019ff001-8888-7888-8888-888888888888'}}:method==='thread/read'?{thread:{status:{type:active?'active':loaded?'idle':'notLoaded'}}}:method==='thread/turns/list'?{data:active?[{id:'turn',status:'inProgress',items:params.itemsView==='summary'&&!oversizedSummary?baselineItems.map(item=>{const {aggregatedOutput,...summary}=item;return summary;}):baselineItems}]:baselineFailure?[{id:'turn',status:'failed',error:baselineFailure,completedAt:1793340000,items:[]}]:[]}:{};
      socket.send(JSON.stringify({id,result}));
    });
  });
  await new Promise<void>(resolve=>server.listen(path,resolve));
});
afterEach(async()=>{stop?.();stop=undefined;for(const client of wss.clients) client.terminate();await new Promise<void>(resolve=>wss.close(()=>resolve()));await new Promise<void>(resolve=>server.close(()=>resolve()));vi.unstubAllEnvs();rmSync(dir,{recursive:true,force:true});});
const send=(method:string,params:unknown)=>peer.send(JSON.stringify({method,params}));
describe('native Codex conversation streaming',()=>{
  it('keeps a durable progress completion time across attach and later tool completions',async()=>{
    const completed=Date.now()-61000;
    active=true;baselineItems=[{type:'agentMessage',id:'previous-progress',text:'已完成的进展',phase:'commentary',startedAtMs:completed-1500,completedAtMs:completed},{type:'commandExecution',id:'next-tool',command:'true',status:'inProgress'}];
    stop=observeCodexConversation('thread',frame=>frames.push(frame));await vi.waitFor(()=>expect(frames.at(-1)).toMatchObject({messages:[{timestamp:new Date(completed).toISOString(),streaming:false}]}));
    send('item/completed',{threadId:'thread',turnId:'turn',completedAtMs:Date.now(),item:{type:'commandExecution',id:'next-tool',command:'true',status:'completed'}});
    await vi.waitFor(()=>expect((frames.at(-1) as any).activities.at(-1).status).toBe('completed'));
    expect((frames.at(-1) as any).messages[0].timestamp).toBe(new Date(completed).toISOString());
  });
  it('records assistant completion time rather than its start timestamp',async()=>{
    stop=observeCodexConversation('thread',frame=>frames.push(frame));await vi.waitFor(()=>expect(requests).toContain('thread/turns/list'));
    send('turn/started',{threadId:'thread',turn:{id:'work'}});
    const started=Date.now()-5000,completed=Date.now();
    send('item/started',{threadId:'thread',turnId:'work',startedAtMs:started,item:{type:'agentMessage',id:'progress',phase:'commentary',text:'正在核查'}});
    await vi.waitFor(()=>expect(frames.at(-1)).toMatchObject({messages:[{streaming:true}]}));
    send('item/completed',{threadId:'thread',turnId:'work',startedAtMs:started,completedAtMs:completed,item:{type:'agentMessage',id:'progress',phase:'commentary',text:'核查完成'}});
    await vi.waitFor(()=>expect(frames.at(-1)).toMatchObject({messages:[{streaming:false,timestamp:new Date(completed).toISOString()}]}));
  });
  it('preserves an already completed compaction timestamp and duration when later work ends',async()=>{
    stop=observeCodexConversation('thread',frame=>frames.push(frame));await vi.waitFor(()=>expect(requests).toContain('thread/turns/list'));
    const start=Date.now()-20000,end=start+1000;
    send('turn/started',{threadId:'thread',turn:{id:'work'}});
    send('item/completed',{threadId:'thread',turnId:'work',item:{id:'done-compact',type:'contextCompaction',startedAtMs:start,completedAtMs:end,durationMs:1000}});
    await vi.waitFor(()=>expect(frames.at(-1)).toMatchObject({compaction:{completed_at:new Date(end).toISOString(),duration_ms:1000}}));
    send('turn/completed',{threadId:'thread',turn:{id:'work',status:'completed',completedAt:Date.now()/1000}});
    await vi.waitFor(()=>expect(frames.at(-1)).toMatchObject({busy:false,compaction:{completed_at:new Date(end).toISOString(),duration_ms:1000}}));
  });
  it('flushes accepted queued user echoes before a rapid next turn clears the batch',async()=>{
    stop=observeCodexConversation('thread',frame=>frames.push(frame));await vi.waitFor(()=>expect(requests).toContain('thread/turns/list'));
    for(const id of ['one','two']){send('turn/started',{threadId:'thread',turn:{id}});send('item/completed',{threadId:'thread',turnId:id,item:{type:'userMessage',id:`user-${id}`,clientId:id,content:[{type:'text',text:id}]}});send('turn/completed',{threadId:'thread',turn:{id,status:'completed'}});}
    await vi.waitFor(()=>{for(const id of ['one','two'])expect(frames.some(f=>f.type==='snapshot'&&f.messages.some(m=>m.client_id===id))).toBe(true);});
  });
  it('accepts messages during compaction into the native queue once and retains image inputs',async()=>{
    active=true;baselineItems=[{id:'compact',type:'contextCompaction'}];const image={kind:'image' as const,name:'image.png',path:'/tmp/image.png'};
    const [first,repeat]=await Promise.all([submitStreamingCodexInput('thread','after compaction','same-client',[image]),submitStreamingCodexInput('thread','after compaction','same-client',[image])]);expect(first).toBe('queued');expect(repeat).toBe('queued');expect(requests.filter(m=>m==='thread/queue/add')).toHaveLength(1);expect(requests).not.toContain('turn/start');expect(queueEntries[0]).toMatchObject({clientUserMessageId:'same-client',input:[{type:'text',text:'after compaction[Image #1]'},{type:'localImage',path:image.path}]});
    await submitStreamingCodexInput('thread','second','second-client');expect(queueEntries.map(q=>q.input[0].text)).toEqual(['after compaction[Image #1]','second']);
    stop=observeCodexConversation('thread',frame=>frames.push(frame));await vi.waitFor(()=>expect(frames.some(frame=>frame.type==='queue'&&frame.messages.length===2&&frame.messages[0].queued)).toBe(true));
    queueEntries=[];send('thread/queue/changed',{threadId:'thread'});await vi.waitFor(()=>expect(frames.at(-1)).toMatchObject({type:'queue',messages:[]}));
  });
  it('handles the compaction-start race through the queue but never retries an unrelated rejection as another input',async()=>{
    turnStartFailure='Thread is busy compacting context';expect(await submitStreamingCodexInput('thread','one','race-client')).toBe('queued');expect(queueEntries).toHaveLength(1);
    turnStartFailure='Model access rejected';await expect(submitStreamingCodexInput('thread','two','rejected-client')).rejects.toThrow('Model access rejected');expect(queueEntries).toHaveLength(1);
  });
  it('steers running work immediately using a summary, without hydrating large tool output or queueing',async()=>{
    active=true;baselineItems=[{type:'userMessage',id:'old',clientId:'previous',content:[]},{type:'commandExecution',id:'huge',aggregatedOutput:'x'.repeat(3*1024*1024)}];
    expect(await submitStreamingCodexInput('thread','insert now','steer-client')).toBe(true);
    expect(requestParams.find(p=>p.method==='thread/turns/list')?.params.itemsView).toBe('summary');
    expect(requestParams.find(p=>p.method==='turn/steer')?.params).toMatchObject({expectedTurnId:'turn',clientUserMessageId:'steer-client',input:[{text:'insert now'}]});
    expect(requests).not.toContain('thread/queue/add');expect(requests).not.toContain('turn/start');
  });
  it('uses the existing live turn receipt to insert without reading any history',async()=>{
    stop=observeCodexConversation('thread',frame=>frames.push(frame));await vi.waitFor(()=>expect(frames.some(frame=>frame.type==='snapshot')).toBe(true));
    send('turn/started',{threadId:'thread',turn:{id:'running-now',status:'inProgress'}});await vi.waitFor(()=>expect(frames.at(-1)).toMatchObject({busy:true,turn_id:'running-now'}));
    requestParams=[];requests=[];expect(await submitStreamingCodexInput('thread','right now','live-insert')).toBe(true);
    expect(requestParams.find(p=>p.method==='turn/steer')?.params.expectedTurnId).toBe('running-now');expect(requests).not.toContain('thread/turns/list');expect(requests).not.toContain('thread/read');
  });
  it('reports a preparation disconnect as unsent and a post-dispatch disconnect as unknown',async()=>{
    active=true;oversizedSummary=true;baselineItems=[{type:'commandExecution',id:'large',aggregatedOutput:'x'.repeat(3*1024*1024)}];
    await expect(submitStreamingCodexInput('thread','not sent','prep-client')).rejects.toMatchObject({submission:'rejected'});expect(submissions).toHaveLength(0);
    oversizedSummary=false;baselineItems=[];dropDispatch=true;
    await expect(submitStreamingCodexInput('thread','ambiguous','dispatch-client')).rejects.toMatchObject({submission:'unknown'});expect(submissions).toHaveLength(1);expect(requests).not.toContain('thread/queue/add');
  });
  it('streams compaction start, real token usage and completion without model text or extra requests',async()=>{
    stop=observeCodexConversation('thread',frame=>frames.push(frame));await vi.waitFor(()=>expect(requests).toContain('thread/turns/list'));
    send('turn/started',{threadId:'thread',turn:{id:'compact'}});send('item/started',{threadId:'thread',turnId:'compact',item:{id:'compact-item',type:'contextCompaction'}});
    await vi.waitFor(()=>expect(frames.at(-1)).toMatchObject({type:'snapshot',busy:true,stage:'tools',messages:[],compaction:{id:'compact-item',status:'running'}}));
    send('thread/tokenUsage/updated',{threadId:'other',tokenUsage:{private:'PRIVATE'}});
    send('thread/tokenUsage/updated',{threadId:'thread',tokenUsage:{total:{totalTokens:1000000,private:'PRIVATE'},last:{totalTokens:2000,inputTokens:1800},modelContextWindow:40000,private:'PRIVATE'}});
    await vi.waitFor(()=>expect(frames.some(frame=>frame.type==='usage'&&frame.usage.last.total_tokens===2000)).toBe(true));expect(JSON.stringify(frames)).not.toContain('PRIVATE');
    send('item/completed',{threadId:'thread',turnId:'compact',item:{id:'compact-item',type:'contextCompaction'}});send('turn/completed',{threadId:'thread',turn:{id:'compact',status:'completed'}});
    await vi.waitFor(()=>expect(frames.at(-1)).toMatchObject({busy:false,compaction:{status:'completed',duration_ms:expect.any(Number)}}));expect(requests).not.toContain('turn/start');
  });
  it('restores active compaction on reconnect and distinguishes an interrupted compaction from success',async()=>{
    active=true;baselineItems=[{id:'compact-item',type:'contextCompaction'}];stop=observeCodexConversation('thread',frame=>frames.push(frame));
    await vi.waitFor(()=>expect(frames.at(-1)).toMatchObject({busy:true,compaction:{status:'running',started_at:null}}));
    send('turn/completed',{threadId:'thread',turn:{id:'turn',status:'interrupted'}});await vi.waitFor(()=>expect(frames.at(-1)).toMatchObject({busy:false,compaction:{status:'interrupted'}}));
  });
  it('pushes only changed allowlisted usage for this thread and releases a stale busy state after compaction',async()=>{
    stop=observeCodexConversation('thread',frame=>frames.push(frame));
    await vi.waitFor(()=>expect(requests).toContain('thread/turns/list'));
    const params={threadId:'thread',turnId:'turn',tokenUsage:{total:{totalTokens:900000,inputTokens:800000,cachedInputTokens:790000},last:{totalTokens:2400,inputTokens:2200,cachedInputTokens:2100},modelContextWindow:40000,private:'PRIVATE_DATA'}};
    send('thread/tokenUsage/updated',{...params,threadId:'other'});send('thread/tokenUsage/updated',params);send('thread/tokenUsage/updated',params);
    await vi.waitFor(()=>expect(frames.filter(frame=>frame.type==='usage')).toHaveLength(1));
    expect(frames.find(frame=>frame.type==='usage')).toMatchObject({native_id:'thread',usage:{last:{total_tokens:2400,cached_input_tokens:2100},window:40000}});
    expect(JSON.stringify(frames)).not.toContain('PRIVATE_DATA');
    send('turn/started',{threadId:'thread',turn:{id:'compaction'}});
    await vi.waitFor(()=>expect(frames.at(-1)).toMatchObject({type:'snapshot',busy:true}));
    send('thread/status/changed',{threadId:'thread',status:{type:'idle'}});
    await vi.waitFor(()=>expect(frames.at(-1)).toMatchObject({type:'snapshot',busy:false,stage:'idle'}));
    expect(requests).not.toContain('turn/start');
  });
  it('checks native state on completed compaction but never marks automatic compaction as an idle task',async()=>{
    active=true;stop=observeCodexConversation('thread',frame=>frames.push(frame));
    await vi.waitFor(()=>expect(frames.some(frame=>frame.type==='snapshot')).toBe(true));
    send('turn/started',{threadId:'thread',turn:{id:'working'}});
    send('item/completed',{threadId:'thread',turnId:'working',item:{type:'contextCompaction',id:'compact'}});
    await vi.waitFor(()=>expect(frames.at(-1)).toMatchObject({type:'snapshot',busy:true}));
    active=false;send('thread/compacted',{threadId:'thread',turnId:'working'});
    await vi.waitFor(()=>expect(frames.at(-1)).toMatchObject({type:'snapshot',busy:false}));
  });
  it('forwards native settings immediately without leaking other thread settings or private fields',async()=>{
    stop=observeCodexConversation('thread',frame=>frames.push(frame));await vi.waitFor(()=>expect(requests).toContain('thread/turns/list'));
    send('thread/settings/updated',{threadId:'other',threadSettings:{model:'private',effort:'high'}});
    send('thread/settings/updated',{threadId:'thread',threadSettings:{model:'chosen',effort:'medium',private:'PRIVATE'}});
    await vi.waitFor(()=>expect(frames.at(-1)).toEqual({type:'settings',model:'chosen',effort:'medium'}));
    expect(JSON.stringify(frames)).not.toContain('PRIVATE');expect(submissions).toHaveLength(0);
  });
  it('streams nonblocking question metadata on the actual AgentMessage item without creating a blocking RPC request',async()=>{
    stop=observeCodexConversation('thread',frame=>frames.push(frame));await vi.waitFor(()=>expect(requests).toContain('thread/turns/list'));
    const questions=[{title:'想去哪里？',options:['太空','深海','森林']}];
    send('turn/started',{threadId:'thread',turn:{id:'turn'}});
    send('item/completed',{threadId:'thread',turnId:'turn',item:{type:'agentMessage',id:'call-question',phase:'final_answer',text:'想去哪里？',delivery:'async',questions}});
    await vi.waitFor(()=>expect(frames.at(-1)).toMatchObject({type:'snapshot',interactions:[],messages:[{id:conversationMessageId('turn','assistant','call-question'),async_questions:questions}]}));
    send('turn/completed',{threadId:'thread',turn:{id:'turn',status:'completed'}});
    await vi.waitFor(()=>expect(frames.at(-1)).toMatchObject({busy:false,messages:[{async_questions:questions,streaming:false}]}));
  });
  it('replays genuine native questions on resume and answers exactly once on the subscribed socket',async()=>{
    const native={id:3,method:'item/tool/requestUserInput',params:{threadId:'thread',turnId:'turn',itemId:'ask',isBlocking:true,questions:[{id:'q',header:'范围',question:'选择部署范围',isOther:false,isSecret:false,options:[{label:'试用',description:'隔离环境'},{label:'正式',description:'日常环境'}]}]}};
    humanRequests=[native];
    const observer=observeCodexConversation('thread',frame=>frames.push(frame));stop=observer;
    await vi.waitFor(()=>expect(frames.at(-1)).toMatchObject({type:'snapshot',interactions:[{id:'3',kind:'question',submitted:false}]}));
    expect(requests).toContain('thread/turns/list'); // Native request id collides with our resume RPC id.
    expect(()=>observer.respond('3',{answers:{q:{answers:['伪造']}}})).toThrow('提供的选项');
    observer.respond('3',{answers:{q:{answers:['试用']}}});
    expect(()=>observer.respond('3',{answers:{q:{answers:['正式']}}})).toThrow('已提交');
    await vi.waitFor(()=>expect(humanResponses).toEqual([{id:3,result:{answers:{q:{answers:['试用']}}}}]));
    send('serverRequest/resolved',{threadId:'other',requestId:3});
    await vi.waitFor(()=>expect(frames.at(-1)).toMatchObject({interactions:[{submitted:true}]}));
    send('serverRequest/resolved',{threadId:'thread',requestId:3});
    await vi.waitFor(()=>expect(frames.at(-1)).toMatchObject({interactions:[]}));
    expect(()=>observer.respond('3',{answers:{q:{answers:['试用']}}})).toThrow('失效');
    expect(requests).not.toContain('turn/start');
  });
  it('restores still-pending approvals after reconnect, and never turns text or another thread into controls',async()=>{
    humanRequests=[{id:'approval',method:'item/commandExecution/requestApproval',params:{threadId:'thread',turnId:'turn',command:'echo test',cwd:'/project'}}];
    let observer=observeCodexConversation('thread',frame=>frames.push(frame));stop=observer;
    await vi.waitFor(()=>expect(frames.at(-1)).toMatchObject({interactions:[{id:'"approval"',kind:'command'}]}));
    observer();observer=observeCodexConversation('thread',frame=>frames.push(frame));stop=observer;
    await vi.waitFor(()=>expect(requests.filter(m=>m==='thread/resume')).toHaveLength(2));
    await vi.waitFor(()=>expect(frames.at(-1)).toMatchObject({interactions:[{submitted:false}]}));
    peer.send(JSON.stringify({id:8,method:'item/tool/requestUserInput',params:{threadId:'other',turnId:'turn',questions:[{id:'q',question:'private'}]}}));
    observer.respond('"approval"',{decision:'decline'});
    await vi.waitFor(()=>expect(humanResponses).toEqual([{id:'approval',result:{decision:'decline'}}]));
    send('turn/completed',{threadId:'thread',turn:{id:'turn',status:'completed'}});
    await vi.waitFor(()=>expect(frames.at(-1)).toMatchObject({interactions:[]}));
  });
  it('shows a public failure immediately, stops streaming, and deduplicates its completion echo',async()=>{
    stop=observeCodexConversation('thread',frame=>frames.push(frame));await vi.waitFor(()=>expect(requests).toContain('thread/turns/list'));
    send('turn/started',{threadId:'thread',turn:{id:'turn'}});
    send('item/started',{threadId:'thread',turnId:'turn',item:{type:'agentMessage',id:'progress',phase:'commentary',text:'正在处理'}});
    const error={message:'Selected model is at capacity. Please try a different model.',codexErrorInfo:'serverOverloaded',additionalDetails:'PRIVATE'};
    send('error',{threadId:'other',turnId:'turn',error,willRetry:false});
    send('error',{threadId:'thread',turnId:'turn',error,willRetry:false});
    await vi.waitFor(()=>expect(frames.at(-1)).toMatchObject({type:'snapshot',busy:false,stage:'idle',messages:[{text:'正在处理',streaming:false},{phase:'error',error:{code:'server_overloaded',will_retry:false}}]}));
    send('turn/completed',{threadId:'thread',turn:{id:'turn',status:'failed',error}});
    await vi.waitFor(()=>{const frame=frames.at(-1);expect(frame?.type==='snapshot'&&frame.messages.filter(message=>message.phase==='error')).toHaveLength(1);});
    expect(JSON.stringify(frames)).not.toContain('PRIVATE');
  });
  it('restores the latest failed turn on reconnect without executing anything',async()=>{
    baselineFailure={message:'Selected model is at capacity. Please try a different model.',codexErrorInfo:'serverOverloaded'};
    stop=observeCodexConversation('thread',frame=>frames.push(frame));
    await vi.waitFor(()=>expect(frames.at(-1)).toMatchObject({type:'snapshot',busy:false,messages:[{phase:'error',error:{code:'server_overloaded',will_retry:false}}]}));
    expect(requests).not.toContain('turn/start');
  });
  it('keeps native automatic retries busy and updates the same error when retrying finally fails',async()=>{
    stop=observeCodexConversation('thread',frame=>frames.push(frame));await vi.waitFor(()=>expect(requests).toContain('thread/turns/list'));
    send('turn/started',{threadId:'thread',turn:{id:'retry'}});
    const error={message:'Network connection interrupted',codexErrorInfo:{responseStreamDisconnected:{httpStatusCode:503}}};
    send('error',{threadId:'thread',turnId:'retry',error,willRetry:true});
    await vi.waitFor(()=>expect(frames.at(-1)).toMatchObject({type:'snapshot',busy:true,messages:[{phase:'error',error:{code:'response_stream_disconnected',will_retry:true}}]}));
    send('error',{threadId:'thread',turnId:'retry',error,willRetry:false});
    await vi.waitFor(()=>expect(frames.at(-1)).toMatchObject({type:'snapshot',busy:false,messages:[{phase:'error',error:{will_retry:false}}]}));
  });
  it('does not mark already completed progress as streaming when reconnecting during tool execution',async()=>{
    active=true;baselineItems=[{type:'agentMessage',id:'item-resumed',phase:'commentary',text:'正在检查。\n'},{type:'commandExecution',id:'tool',status:'inProgress',command:'private'}];
    stop=observeCodexConversation('thread',frame=>frames.push(frame));
    await vi.waitFor(()=>expect(frames.at(-1)).toMatchObject({type:'snapshot',busy:true,stage:'tools',messages:[{text:'正在检查。\n',streaming:false,timestamp:null}]}));
    expect(JSON.stringify(frames.flatMap(frame=>frame.type==='snapshot'?frame.messages:[]))).not.toContain('private');
    expect(frames.at(-1)).toMatchObject({activities:[{label:'运行命令 · private',status:'running',started_at:null}]});
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
    expect(submissions[0].input).toEqual([{type:'text',text:expect.stringContaining('报告.txt'),text_elements:[{byteRange:{start:12,end:22},placeholder:'[Image #1]'}]},{type:'localImage',path:attachments[0].path}]);
    expect(submissions[0].input[0].text).not.toContain('agentmanager_attachments');
    await submitStreamingCodexInput('thread','仅图片','image-only',attachments.slice(0,1));
    expect(submissions[1].input[0].text).toBe('仅图片[Image #1]');
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
  it('passes shared-resource discovery as configuration, never as a human message or extra model turn',async()=>{
    requestParams=[];
    const instructions='<octoally_shared_resources>entry only</octoally_shared_resources>';
    await createStreamingCodexThread('/project','actual user task',instructions);
    expect(requestParams.find(frame=>frame.method==='thread/start')?.params.developerInstructions).toBe(instructions);
    expect(submissions).toHaveLength(1);
    expect(JSON.stringify(submissions)).not.toContain('octoally_shared_resources');
    const before=requestParams.length;await configureStreamingSharedResources('019ff001-8888-7888-8888-888888888888',instructions);expect(requestParams).toHaveLength(before);
    await Promise.all([configureStreamingSharedResources('thread',instructions),configureStreamingSharedResources('thread',instructions)]);
    expect(requestParams.find(frame=>frame.method==='thread/resume')?.params).toEqual({threadId:'thread',excludeTurns:true});
    expect(requestParams.at(-1)).toMatchObject({method:'thread/inject_items',params:{threadId:'thread',items:[{role:'developer',content:[{type:'input_text',text:instructions}]}]}});
    const injected=requestParams.filter(frame=>frame.method==='thread/inject_items').length;
    await configureStreamingSharedResources('thread',instructions);
    expect(requestParams.filter(frame=>frame.method==='thread/inject_items')).toHaveLength(injected);
    expect(submissions).toHaveLength(1);
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
    expect(JSON.stringify(frames.flatMap(frame=>frame.type==='snapshot'?frame.messages:[]))).not.toMatch(/secret command|OTHER THREAD/);
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
