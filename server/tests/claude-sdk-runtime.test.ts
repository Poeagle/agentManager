import {afterEach,describe,expect,it,vi} from 'vitest';

const sdk=vi.hoisted(()=>({messages:[] as any[],queries:[] as any[],interrupts:0}));
vi.mock('@anthropic-ai/claude-agent-sdk',()=>({
  query:(request:any)=>{
    sdk.queries.push(request);
    return {
    async *[Symbol.asyncIterator](){for(const message of sdk.messages){await Promise.resolve();yield message;}},
    setModel:async(model:string)=>{sdk.queries.at(-1).setModel=model;},
    interrupt:async()=>{sdk.interrupts++;},
    close:()=>{},
  };},
}));

import {ensureClaudeRuntime,releaseClaudeRuntime} from '../src/services/agents/claude/sdk-runtime.js';
import {conversationMessageId} from '../src/services/conversation-reader.js';
import {parseClaudeMessage} from '../src/services/agents/claude/history.js';

const session='019ff001-1212-7212-8212-121212121212';
const assistant='019ff001-1212-7212-8212-121212121213';
let uuid=0;
const stream=(event:any)=>({type:'stream_event',uuid:`019ff001-1212-7212-8212-${String(++uuid).padStart(12,'0')}`,session_id:session,parent_tool_use_id:null,event});

afterEach(()=>{releaseClaudeRuntime(session);sdk.queries=[];sdk.messages=[];sdk.interrupts=0;uuid=0;});

describe('Claude Agent SDK runtime',()=>{
  it('launches idle until the first manually supplied message',async()=>{
    const {createTestDatabase}=await import('./helpers/database.js');const database=createTestDatabase();
    let nativeId:string|undefined;
    try{
      const {claudeAdapter}=await import('../src/services/agents/claude/adapter.js');
      const launch=await claudeAdapter.launch.prepare({session:{id:'empty'},projectPath:database.dir} as any,'');nativeId=launch.nativeId;
      expect(sdk.queries).toEqual([]);expect(launch.initialMessageId).toBeUndefined();
      await ensureClaudeRuntime(nativeId!,database.dir).submit('manual input');
      await vi.waitFor(()=>expect(sdk.queries).toHaveLength(1));
    }finally{if(nativeId)releaseClaudeRuntime(nativeId);database.cleanup();}
  });
  it('preserves the supplied native user identity for live messages and persisted history',async()=>{
    const userId='d3587c44-6f5d-4d52-9a6c-484eac61880f';
    const runtime=ensureClaudeRuntime(session,'/tmp');await runtime.submit('scheduled','client-id',[],userId);
    const live=runtime.snapshot().messages.find(message=>message.role==='user')!;
    expect(live).toMatchObject({id:conversationMessageId('','user',userId),client_id:'client-id',text:'scheduled'});
    await vi.waitFor(()=>expect(sdk.queries).toHaveLength(1));
    const native=await sdk.queries[0].prompt[Symbol.asyncIterator]().next();expect(native.value.uuid).toBe(userId);
    const history=parseClaudeMessage(Buffer.from(JSON.stringify({type:'user',uuid:userId,message:{role:'user',content:'scheduled'},timestamp:'2026-11-01T00:00:00Z'})));
    expect(history?.itemId).toBe(userId);expect(conversationMessageId('',history!.message.role,history!.itemId)).toBe(live.id);
  });
  it('stops only the matching active turn',async()=>{
    let resolve!:(value:any)=>void;sdk.messages=[new Promise(done=>{resolve=done;})];
    const runtime=ensureClaudeRuntime(session,'/tmp');expect(await runtime.submit('Work')).toBe(true);
    const turn=runtime.snapshot().turn_id!;expect(await runtime.stopTurn('old-turn')).toBe(false);expect(sdk.interrupts).toBe(0);
    expect(await runtime.stopTurn(turn)).toBe(true);expect(sdk.interrupts).toBe(1);
    resolve({type:'result',subtype:'success',uuid:assistant,session_id:session});await vi.waitFor(()=>expect(runtime.runtime().state).toBe('idle'));expect(await runtime.stopTurn(turn)).toBe(false);
  });
  it('uses protocol envelopes instead of per-chunk UUIDs and preserves text around tools',async()=>{
    sdk.messages=[
      stream({type:'message_start',message:{id:'api-message-one'}}),
      stream({type:'content_block_start',index:0,content_block:{type:'text',text:'我先'}}),
      stream({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'读取。'}}),
      stream({type:'content_block_stop',index:0}),
      stream({type:'content_block_start',index:1,content_block:{type:'tool_use',id:'tool-1',name:'Read',input:{file_path:'/tmp/demo.ts'}}}),
      stream({type:'content_block_stop',index:1}),
      stream({type:'message_stop'}),
      {type:'assistant',uuid:assistant,session_id:session,parent_tool_use_id:null,message:{id:'api-message-one',content:[{type:'text',text:'我先读取。'},{type:'tool_use',id:'tool-1',name:'Read',input:{file_path:'/tmp/demo.ts'}}]}},
      {type:'user',uuid:'019ff001-1212-7212-8212-121212121214',session_id:session,parent_tool_use_id:'tool-1',message:{content:[{type:'tool_result',tool_use_id:'tool-1',content:'ok'}]}},
      stream({type:'message_start',message:{id:'api-message-two'}}),
      stream({type:'content_block_start',index:0,content_block:{type:'text',text:''}}),
      stream({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'读取'}}),
      stream({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'完成。'}}),
      stream({type:'content_block_stop',index:0}),
      stream({type:'message_stop'}),
      {type:'assistant',uuid:'019ff001-1212-7212-8212-121212121216',session_id:session,parent_tool_use_id:null,message:{id:'api-message-two',content:[{type:'text',text:'读取完成。'}]}},
      {type:'result',subtype:'success',uuid:'019ff001-1212-7212-8212-121212121215',session_id:session},
    ];
    const runtime=ensureClaudeRuntime(session,'/tmp');
    const frames:any[]=[];const stop=runtime.observe(frame=>frames.push(frame));
    expect(await runtime.submit('开始','client-one')).toBe(true);
    await vi.waitFor(()=>expect(runtime.runtime().state).toBe('idle'));
    stop();
    const final=frames.at(-1);
    expect(final.messages.filter((message:any)=>message.role==='user')).toHaveLength(1);
    const assistants=final.messages.filter((message:any)=>message.role==='assistant');
    expect(assistants).toHaveLength(2);
    expect(assistants.map((message:any)=>message.text)).toEqual(['我先读取。','读取完成。']);
    expect(assistants.map((message:any)=>message.id)).toEqual([
      conversationMessageId('','assistant','api-message-one'),
      conversationMessageId('','assistant','api-message-two'),
    ]);
    const historyRecord=parseClaudeMessage(Buffer.from(JSON.stringify({
      type:'assistant',
      uuid:assistant,
      parentUuid:'user-turn',
      timestamp:'2026-11-08T10:00:00Z',
      message:{id:'api-message-one',role:'assistant',stop_reason:'end_turn',content:[{type:'text',text:'我先读取。'}]},
    })));
    expect(assistants[0].id).toBe(conversationMessageId('',historyRecord!.message.role,historyRecord!.itemId));
    const user=final.messages.find((message:any)=>message.role==='user');
    expect(user.id).toBe(conversationMessageId('',user.role,user.turn_id));
    expect(new Set(assistants.map((message:any)=>message.id)).size).toBe(2);
    expect(assistants).toEqual(assistants.map((message:any)=>expect.objectContaining({phase:'final',streaming:false})));
    expect(final.activities).toEqual([expect.objectContaining({id:'tool-1',label:'读取文件 · /tmp/demo.ts',status:'completed'})]);
    expect(assistants[0].content_blocks).toEqual([
      {type:'text',index:0,text:'我先读取。'},
      {type:'tool_use',index:1,id:'tool-1',name:'Read',input:{file_path:'/tmp/demo.ts'},status:'completed',result:'ok'},
    ]);
  });
  it('rekeys streamed content to the late native ID and merges tool snapshots by tool ID',async()=>{
    sdk.messages=[
      stream({type:'message_start',message:{id:'late-native-message'}}),
      stream({type:'content_block_start',index:0,content_block:{type:'text',text:'检查中'}}),
      stream({type:'content_block_start',index:1,content_block:{type:'tool_use',id:'tool-late',name:'Bash',input:{}}}),
      stream({type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:'{"command":"pwd"}'}}),
      stream({type:'message_stop'}),
      {type:'assistant',uuid:assistant,session_id:session,parent_tool_use_id:null,message:{id:'late-native-message',content:[{type:'text',text:'检查中'},{type:'tool_use',id:'tool-late',name:'Bash',input:{command:'pwd'}}]}},
      {type:'user',uuid:'019ff001-1212-7212-8212-121212121214',session_id:session,parent_tool_use_id:'tool-late',message:{content:[{type:'tool_result',tool_use_id:'tool-late',content:'/tmp/demo'}]}},
      {type:'result',subtype:'success',uuid:'019ff001-1212-7212-8212-121212121215',session_id:session},
    ];
    const runtime=ensureClaudeRuntime(session,'/tmp');
    const frames:any[]=[];const stop=runtime.observe(frame=>frames.push(frame));
    await runtime.submit('检查');
    await vi.waitFor(()=>expect(runtime.runtime().state).toBe('idle'));
    stop();
    const assistants=frames.at(-1).messages.filter((message:any)=>message.role==='assistant');
    expect(assistants).toHaveLength(1);
    expect(frames.some(frame=>frame.messages.some((message:any)=>message.content_blocks?.some((block:any)=>block.type==='tool_use'&&block.id==='tool-late'&&block.status==='running'&&block.input.command==='pwd')))).toBe(true);
    expect(assistants[0]).toMatchObject({
      id:conversationMessageId('','assistant','late-native-message'),
      text:'检查中',
      content_blocks:[
        {type:'text',index:0,text:'检查中'},
        {type:'tool_use',index:1,id:'tool-late',name:'Bash',input:{command:'pwd'},status:'completed',result:'/tmp/demo'},
      ],
    });
  });
  it('uses the completed assistant event when no partial text was emitted',async()=>{
    sdk.messages=[
      stream({type:'message_start',message:{id:'api-message-one'}}),
      stream({type:'message_stop'}),
      {type:'assistant',uuid:assistant,session_id:session,parent_tool_use_id:null,message:{content:[{type:'text',text:'完整回复'}]}},
      {type:'result',subtype:'success',uuid:'019ff001-1212-7212-8212-121212121215',session_id:session},
    ];
    const runtime=ensureClaudeRuntime(session,'/tmp');
    const frames:any[]=[];const stop=runtime.observe(frame=>frames.push(frame));
    expect(await runtime.submit('开始')).toBe(true);
    await vi.waitFor(()=>expect(runtime.runtime().state).toBe('idle'));
    stop();
    expect(frames.at(-1).messages.filter((message:any)=>message.role==='assistant')).toEqual([
      expect.objectContaining({text:'完整回复',phase:'final',streaming:false}),
    ]);
  });
  it('merges thinking-only and text completions from the same API message into one final message',async()=>{
    sdk.messages=[
      stream({type:'message_start',message:{id:'same-api-message'}}),
      stream({type:'content_block_start',index:0,content_block:{type:'thinking'}}),
      {type:'assistant',uuid:assistant,session_id:session,parent_tool_use_id:null,message:{id:'same-api-message',content:[{type:'thinking',thinking:''}]}},
      stream({type:'content_block_stop',index:0}),
      stream({type:'content_block_start',index:1,content_block:{type:'text',text:''}}),
      stream({type:'content_block_delta',index:1,delta:{type:'text_delta',text:'What would you like me to do?'}}),
      {type:'assistant',uuid:'019ff001-1212-7212-8212-121212121214',session_id:session,parent_tool_use_id:null,message:{id:'same-api-message',content:[{type:'text',text:'What would you like me to do?'}]}},
      stream({type:'content_block_stop',index:1}),
      stream({type:'message_stop'}),
      {type:'result',subtype:'success',uuid:'019ff001-1212-7212-8212-121212121215',session_id:session},
    ];
    const runtime=ensureClaudeRuntime(session,'/tmp');const frames:any[]=[];const stop=runtime.observe(frame=>frames.push(frame));
    await runtime.submit('介绍你自己');await vi.waitFor(()=>expect(runtime.runtime().state).toBe('idle'));stop();
    const assistants=frames.at(-1).messages.filter((message:any)=>message.role==='assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({
      id:conversationMessageId('','assistant','same-api-message'),
      text:'What would you like me to do?',
      phase:'final',
      content_blocks:[{type:'text',index:1,text:'What would you like me to do?'}],
    });
  });
  it('uses the completed message identity when the SDK omits partial stream events',async()=>{
    sdk.messages=[
      {type:'assistant',uuid:assistant,session_id:session,parent_tool_use_id:null,message:{id:'api-message-recovered',content:[{type:'text',text:'恢复后的完整回复'}]}},
      {type:'result',subtype:'success',uuid:'019ff001-1212-7212-8212-121212121215',session_id:session},
    ];
    const runtime=ensureClaudeRuntime(session,'/tmp');
    const frames:any[]=[];const stop=runtime.observe(frame=>frames.push(frame));
    expect(await runtime.submit('继续')).toBe(true);
    await vi.waitFor(()=>expect(runtime.runtime().state).toBe('idle'));
    stop();
    const messages=frames.at(-1).messages.filter((message:any)=>message.role==='assistant');
    expect(messages).toEqual([
      expect.objectContaining({
        id:conversationMessageId('','assistant','api-message-recovered'),
        text:'恢复后的完整回复',
        phase:'final',
        streaming:false,
      }),
    ]);
  });
  it('does not project subagent assistant text into the main conversation',async()=>{
    sdk.messages=[
      {type:'assistant',uuid:assistant,session_id:session,parent_tool_use_id:'task-1',message:{id:'subagent-message',content:[{type:'text',text:'子代理内部进度'}]}},
      stream({type:'message_start',message:{id:'main-message'}}),
      stream({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'主回答'}}),
      stream({type:'message_stop'}),
      {type:'assistant',uuid:'019ff001-1212-7212-8212-121212121216',session_id:session,parent_tool_use_id:null,message:{id:'main-message',content:[{type:'text',text:'主回答'}]}},
      {type:'result',subtype:'success',uuid:'019ff001-1212-7212-8212-121212121215',session_id:session},
    ];
    const runtime=ensureClaudeRuntime(session,'/tmp');
    const frames:any[]=[];const stop=runtime.observe(frame=>frames.push(frame));
    expect(await runtime.submit('继续')).toBe(true);
    await vi.waitFor(()=>expect(runtime.runtime().state).toBe('idle'));
    stop();
    expect(frames.at(-1).messages.filter((message:any)=>message.role==='assistant')).toEqual([
      expect.objectContaining({
        id:conversationMessageId('','assistant','main-message'),
        text:'主回答',
        phase:'final',
        streaming:false,
      }),
    ]);
  });
  it('resumes an existing SDK session after process recovery',async()=>{
    sdk.messages=[{type:'result',subtype:'success',uuid:assistant,session_id:session}];
    const runtime=ensureClaudeRuntime(session,'/tmp',undefined,undefined,true);
    expect(await runtime.submit('继续')).toBe(true);
    await vi.waitFor(()=>expect(runtime.runtime().state).toBe('idle'));
    expect(sdk.queries).toHaveLength(1);
    expect(sdk.queries[0].options).toMatchObject({resume:session});
    expect(sdk.queries[0].options).not.toHaveProperty('sessionId');
  });
  it('applies the selected model to the next SDK query',async()=>{
    const runtime=ensureClaudeRuntime(session,'/tmp');
    runtime.setModel({model:'opus',effort:''});
    await runtime.submit('使用选定模型');
    await vi.waitFor(()=>expect(runtime.runtime().state).toBe('idle'));
    expect(sdk.queries[0].options.model).toBe('opus');
  });
  it('applies a model change to an active SDK query without waiting for a new turn',async()=>{
    sdk.messages=[
      stream({type:'message_start',message:{id:'active-message'}}),
      stream({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'进行中'}}),
    ];
    const runtime=ensureClaudeRuntime(session,'/tmp');
    const promise=runtime.submit('继续');
    await vi.waitFor(()=>expect(runtime.runtime().state).toBe('running'));
    runtime.setModel({model:'haiku',effort:''});
    await promise;
    expect(sdk.queries[0].setModel).toBe('haiku');
  });
  it('ignores a repeated completed SDK message with the same native ID',async()=>{
    const completed={type:'assistant',uuid:assistant,session_id:session,parent_tool_use_id:null,message:{id:'same-completion',content:[{type:'text',text:'只显示一次'}]}};
    sdk.messages=[completed,completed,{type:'result',subtype:'success',uuid:'019ff001-1212-7212-8212-121212121215',session_id:session}];
    const runtime=ensureClaudeRuntime(session,'/tmp');
    const frames:any[]=[];const stop=runtime.observe(frame=>frames.push(frame));
    await runtime.submit('继续');
    await vi.waitFor(()=>expect(runtime.runtime().state).toBe('idle'));
    stop();
    const messages=frames.at(-1).messages.filter((message:any)=>message.role==='assistant');
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe('只显示一次');
  });
});
