import {afterEach,describe,expect,it,vi} from 'vitest';

const sdk=vi.hoisted(()=>({messages:[] as any[],queries:[] as any[],interrupts:0}));
vi.mock('@anthropic-ai/claude-agent-sdk',()=>({
  query:(request:any)=>{
    sdk.queries.push(request);
    return {
    async *[Symbol.asyncIterator](){for(const message of sdk.messages){await Promise.resolve();yield message;}},
    setModel:async(model:string)=>{sdk.queries.at(-1).setModel=model;},
    interrupt:async()=>{sdk.interrupts++;},
    close:()=>{sdk.queries.at(-1).closed=true;},
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
  it('classifies insufficient balance and unavailable models as terminal errors',async()=>{
    sdk.messages=[
      {type:'result',subtype:'error_during_execution',uuid:assistant,session_id:session,errors:['API Error: 402 {"error":{"message":"insufficient balance","type":"insufficient_balance"}}']},
    ];
    const runtime=ensureClaudeRuntime(session,'/tmp');
    await runtime.submit('balance check');
    await vi.waitFor(()=>expect(runtime.runtime().state).toBe('idle'));
    expect(runtime.snapshot().messages.find(message=>message.phase==='error')).toMatchObject({
      error:{code:'insufficient_balance',will_retry:false},
    });
    sdk.messages=[
      {type:'result',subtype:'error_during_execution',uuid:assistant,session_id:session,errors:["There's an issue with the selected model (grok-4.5). It may not exist or you may not have access to it."]},
    ];
    await runtime.submit('model check');
    await vi.waitFor(()=>expect(runtime.runtime().state).toBe('idle'));
    expect(runtime.snapshot().messages.filter(message=>message.phase==='error').at(-1)).toMatchObject({
      error:{code:'model_unavailable',will_retry:false},
    });
  });
  it('injects only the bound Provider credentials and model into the SDK process',async()=>{
    sdk.messages=[{type:'result',subtype:'success',uuid:assistant,session_id:session}];
    const runtime=ensureClaudeRuntime(session,'/tmp',undefined,{model:'claude-a',effort:''},false,{
      id:'gateway',name:'Gateway',baseUrl:'https://gateway.example',authToken:'private-token',
      models:['claude-a','claude-b'],defaultModel:'claude-a',contextWindow:200000,maxOutputTokens:64000,
    });
    await runtime.submit('provider-bound');
    await vi.waitFor(()=>expect(runtime.runtime().state).toBe('idle'));
    expect(sdk.queries).toHaveLength(1);
    expect(sdk.queries[0].options).toMatchObject({
      model:'claude-a',
      env:{
        ANTHROPIC_BASE_URL:'https://gateway.example',
        ANTHROPIC_AUTH_TOKEN:'private-token',
        ANTHROPIC_API_KEY:'',
        ANTHROPIC_MODEL:'claude-a',
        ANTHROPIC_DEFAULT_OPUS_MODEL:'claude-a',
        ANTHROPIC_DEFAULT_SONNET_MODEL:'claude-a',
        ANTHROPIC_DEFAULT_HAIKU_MODEL:'claude-a',
        CLAUDE_CODE_MAX_CONTEXT_TOKENS:'200000',
        CLAUDE_CODE_MAX_OUTPUT_TOKENS:'64000',
      },
    });
    expect(runtime.selectedModel()).toBe('claude-a');
  });
  it('keeps simultaneously active Claude providers isolated by session runtime',async()=>{
    sdk.messages=[{type:'result',subtype:'success',uuid:assistant,session_id:session}];
    const other='019ff001-1212-7212-8212-121212121299';
    const first=ensureClaudeRuntime(session,'/tmp',undefined,{model:'provider-a-model',effort:''},false,{
      id:'provider-a',name:'Provider A',baseUrl:'https://a.example',authToken:'token-a',
      models:['provider-a-model'],defaultModel:'provider-a-model',contextWindow:null,maxOutputTokens:null,
    });
    const second=ensureClaudeRuntime(other,'/tmp',undefined,{model:'provider-b-model',effort:''},false,{
      id:'provider-b',name:'Provider B',baseUrl:'https://b.example',authToken:'token-b',
      models:['provider-b-model'],defaultModel:'provider-b-model',contextWindow:null,maxOutputTokens:null,
    });
    await Promise.all([first.submit('A'),second.submit('B')]);
    await vi.waitFor(()=>expect(sdk.queries).toHaveLength(2));
    expect(sdk.queries.map(query=>query.options)).toEqual(expect.arrayContaining([
      expect.objectContaining({model:'provider-a-model',env:expect.objectContaining({ANTHROPIC_BASE_URL:'https://a.example',ANTHROPIC_AUTH_TOKEN:'token-a',ANTHROPIC_MODEL:'provider-a-model'})}),
      expect.objectContaining({model:'provider-b-model',env:expect.objectContaining({ANTHROPIC_BASE_URL:'https://b.example',ANTHROPIC_AUTH_TOKEN:'token-b',ANTHROPIC_MODEL:'provider-b-model'})}),
    ]));
    expect(()=>first.configure({id:'provider-b',name:'Provider B',baseUrl:'https://b.example',authToken:'token-b',models:['provider-b-model'],defaultModel:'provider-b-model',contextWindow:null,maxOutputTokens:null})).toThrow('另一个 Provider');
    releaseClaudeRuntime(other);
  });
  it('maps every Claude model alias to the concrete model selected for this request',async()=>{
    sdk.messages=[{type:'result',subtype:'success',uuid:assistant,session_id:session}];
    const runtime=ensureClaudeRuntime(session,'/tmp',undefined,{model:'claude-fable-5',effort:''},false,{
      id:'anthropic',name:'Anthropic',baseUrl:'https://xindu.xyz',authToken:'private-token',
      models:['claude-fable-5','opus','sonnet','haiku'],defaultModel:'claude-fable-5',contextWindow:null,maxOutputTokens:null,
    });
    await runtime.submit('reply ok');
    await vi.waitFor(()=>expect(runtime.runtime().state).toBe('idle'));
    expect(sdk.queries.at(-1)?.options).toMatchObject({
      model:'claude-fable-5',
      env:{ANTHROPIC_MODEL:'claude-fable-5',ANTHROPIC_DEFAULT_OPUS_MODEL:'claude-fable-5',ANTHROPIC_DEFAULT_SONNET_MODEL:'claude-fable-5',ANTHROPIC_DEFAULT_HAIKU_MODEL:'claude-fable-5'},
    });
  });
  it('rejects an explicit model that is not part of the selected provider catalog',async()=>{
    const runtime=ensureClaudeRuntime(session,'/tmp',undefined,{model:'catalog-model',effort:''},false,{
      id:'provider',name:'Provider',baseUrl:'https://provider.example',authToken:'token',
      models:['catalog-model'],defaultModel:'catalog-model',contextWindow:null,maxOutputTokens:null,
    });
    expect(()=>runtime.setModel({model:'other-model',effort:''})).toThrow('不属于当前 Provider');
    releaseClaudeRuntime(session);
  });
  it('reports when the upstream returns a different model than the selected one',async()=>{
    sdk.messages=[
      {type:'assistant',uuid:assistant,session_id:session,parent_tool_use_id:null,message:{id:'wrong-model',model:'grok-4.6',content:[{type:'text',text:'Wrong model response.'}]}},
      {type:'result',subtype:'success',uuid:assistant,session_id:session},
    ];
    const runtime=ensureClaudeRuntime(session,'/tmp',undefined,{model:'claude-opus-4-8',effort:''},false,{
      id:'anthropic',name:'Anthropic',baseUrl:'https://xindu.xyz',authToken:'private-token',
      models:['claude-opus-4-8'],defaultModel:'claude-opus-4-8',contextWindow:null,maxOutputTokens:null,
    });
    await runtime.submit('Use the selected model');
    await vi.waitFor(()=>expect(runtime.runtime().state).toBe('idle'));
    expect(runtime.snapshot().messages.find(message=>message.error?.code==='model_mismatch')).toMatchObject({
      text:expect.stringContaining('grok-4.6'),
      error:{code:'model_mismatch',will_retry:false},
    });
  });
  it('runs manual compaction as a dedicated Claude SDK query and maps native status',async()=>{
    sdk.messages=[
      {type:'system',subtype:'status',status:'compacting',uuid:'status-1',session_id:session},
      {type:'system',subtype:'compact_boundary',uuid:'compact-1',session_id:session,compact_metadata:{trigger:'manual',pre_tokens:1000,post_tokens:200,duration_ms:3000}},
      {type:'result',subtype:'success',uuid:assistant,session_id:session},
    ];
    const runtime=ensureClaudeRuntime(session,'/tmp');
    await runtime.compact();
    await vi.waitFor(()=>expect(sdk.queries).toHaveLength(1));
    expect((await sdk.queries[0].prompt[Symbol.asyncIterator]().next()).value).toMatchObject({message:{content:'/compact'}});
    await vi.waitFor(()=>expect(runtime.runtime().state).toBe('idle'));
    expect(runtime.snapshot().compaction).toMatchObject({id:'compact-1',status:'completed',duration_ms:3000});
    expect(runtime.snapshot().messages.find(message=>message.presentation==='compaction_summary')).toMatchObject({
      role:'assistant',phase:'commentary',compaction:{before_tokens:1000,after_tokens:200,duration_ms:3000},
    });
  });
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
    expect(runtime.runtime()).toMatchObject({state:'idle',completed_turn_id:expect.any(String)});
    resolve({type:'result',subtype:'success',uuid:assistant,session_id:session});await vi.waitFor(()=>expect(runtime.runtime().state).toBe('idle'));expect(await runtime.stopTurn(turn)).toBe(false);
  });
  it('finishes the turn when result arrives before the streaming input closes',async()=>{
    sdk.messages=[
      stream({type:'message_start',message:{id:'result-first'}}),
      stream({type:'content_block_start',index:0,content_block:{type:'text',text:'Complete.'}}),
      {type:'result',subtype:'success',uuid:assistant,session_id:session},
      new Promise(()=>{}),
    ];
    const runtime=ensureClaudeRuntime(session,'/tmp');
    await runtime.submit('Complete');
    await vi.waitFor(()=>expect(runtime.runtime().state).toBe('idle'),{timeout:1000});
    expect(runtime.snapshot().busy).toBe(false);
    expect(runtime.snapshot().stage).toBe('idle');
    expect(runtime.runtime().state).toBe('idle');
    expect(runtime.runtime().completed_turn_id).toBeTruthy();
    expect(sdk.queries.at(-1)?.closed).toBe(true);
    expect(runtime.snapshot().messages.find(message=>message.text==='Complete.')).toMatchObject({
      phase:'final',
      streaming:false,
    });
  });
  it('interrupts the current query and immediately continues with a running follow-up',async()=>{
    let release!:(value:any)=>void;sdk.messages=[new Promise(done=>{release=done;})];
    const runtime=ensureClaudeRuntime(session,'/tmp');
    expect(await runtime.submit('Start work','client-start')).toBe(true);
    const input=sdk.queries[0].prompt[Symbol.asyncIterator]();
    const first=await input.next();expect(first.value).toMatchObject({
      message:{role:'user',content:'Start work'},
    });
    expect(await runtime.submit('Insert this guidance','client-steer')).toBe(true);
    expect(runtime.snapshot().messages.find(message=>message.client_id==='client-steer')).toMatchObject({queued:false});
    expect(sdk.interrupts).toBe(1);
    expect(runtime.snapshot().messages.filter(message=>message.role==='user').map(message=>message.client_id))
      .toEqual(['client-start','client-steer']);
    const emitted=[{type:'result',subtype:'success',uuid:assistant,session_id:session}];
    sdk.messages.push(...emitted);release(emitted);
    await vi.waitFor(()=>expect(sdk.queries).toHaveLength(2));
    const next=await sdk.queries[1].prompt[Symbol.asyncIterator]().next();
    expect(next.value).toMatchObject({message:{content:'Insert this guidance'}});
    sdk.messages.push({type:'result',subtype:'success',uuid:assistant,session_id:session});
    release({type:'result',subtype:'success',uuid:assistant,session_id:session});
    await vi.waitFor(()=>expect(runtime.runtime().state).toBe('idle'));
    expect(runtime.snapshot().messages.filter(message=>message.role==='user')).toHaveLength(2);
    expect(runtime.snapshot().messages).toEqual(expect.arrayContaining([
      expect.objectContaining({role:'user',text:'Insert this guidance',client_id:'client-steer',queued:false}),
    ]));
  });
  it('rekeys the initial live user message to its native receipt before history can load',async()=>{
    const nativeUser='d3587c44-6f5d-4d52-9a6c-484eac61880f';
    sdk.messages=[
      {type:'user',uuid:nativeUser,session_id:session,parent_tool_use_id:null,message:{role:'user',content:'Initial task'}},
      {type:'result',subtype:'success',uuid:assistant,session_id:session},
    ];
    const runtime=ensureClaudeRuntime(session,'/tmp');
    await runtime.submit('Initial task','client-initial');
    await vi.waitFor(()=>expect(runtime.runtime().state).toBe('idle'));
    const users=runtime.snapshot().messages.filter(message=>message.role==='user');
    expect(users).toEqual([
      expect.objectContaining({
        id:conversationMessageId('','user',nativeUser),
        turn_id:nativeUser,
        client_id:'client-initial',
      }),
    ]);
  });
  it('removes only a matching queued Claude message',async()=>{
    let release!:(value:any)=>void;sdk.messages=[new Promise(done=>{release=done;})];
    const runtime=ensureClaudeRuntime(session,'/tmp'),internal:any=runtime;
    (runtime as any).busy=true;
    const originalInput=internal.input;
    internal.input=null;
    await runtime.submit('Keep this','client-keep');
    await runtime.submit('Cancel this','client-cancel');
    await runtime.cancelQueued('client-cancel');
    expect(runtime.snapshot().messages.filter(message=>message.role==='user').map(message=>message.client_id))
      .toEqual(['client-keep']);
    await expect(runtime.cancelQueued('client-cancel')).rejects.toThrow('等待队列');
    internal.input=originalInput;
  });
  it('exposes the completed native turn so the dashboard can clear its busy state',async()=>{
    sdk.messages=[
      {type:'result',subtype:'success',uuid:assistant,session_id:session},
    ];
    const runtime=ensureClaudeRuntime(session,'/tmp');
    await runtime.submit('Finish this turn','client-turn');
    await vi.waitFor(()=>expect(runtime.runtime().state).toBe('idle'));
    expect(runtime.runtime()).toMatchObject({
      state:'idle',completed_turn_id:expect.any(String),last_turn_ended_at:expect.any(String),
    });
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
    expect(assistants.map(message=>({phase:message.phase,streaming:message.streaming}))).toEqual([
      {phase:'commentary',streaming:false},
      {phase:'final',streaming:false},
    ]);
    expect(final.activities).toEqual([expect.objectContaining({id:'tool-1',label:'读取文件 · /tmp/demo.ts',status:'completed'})]);
    expect(assistants[0].content_blocks).toEqual([
      {type:'text',index:0,text:'我先读取。'},
      {type:'tool_use',index:1,id:'tool-1',name:'Read',input:{file_path:'/tmp/demo.ts'},status:'completed',result:'ok'},
    ]);
  });
  it('keeps Claude thinking blocks separate from answer text while streaming',async()=>{
    sdk.messages=[
      stream({type:'message_start',message:{id:'thinking-message'}}),
      stream({type:'content_block_start',index:0,content_block:{type:'thinking',thinking:''}}),
      stream({type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'Checking the'}}),
      stream({type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:' request.'}}),
      stream({type:'content_block_stop',index:0}),
      stream({type:'content_block_start',index:1,content_block:{type:'text',text:''}}),
      stream({type:'content_block_delta',index:1,delta:{type:'text_delta',text:'Done.'}}),
      {type:'assistant',uuid:assistant,session_id:session,parent_tool_use_id:null,message:{id:'thinking-message',content:[{type:'thinking',thinking:'Checking the request.'},{type:'text',text:'Done.'}]}},
      {type:'result',subtype:'success',uuid:assistant,session_id:session},
    ];
    const runtime=ensureClaudeRuntime(session,'/tmp');
    await runtime.submit('Check');
    await vi.waitFor(()=>expect(runtime.runtime().state).toBe('idle'));
    const message=runtime.snapshot().messages.find(item=>item.role==='assistant')!;
    expect(message.text).toBe('Done.');
    expect(message.content_blocks).toEqual([
      {type:'thinking',index:0,text:'Checking the request.'},
      {type:'text',index:1,text:'Done.'},
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
    expect(frames.some(frame=>frame.activities.some((activity:any)=>activity.id==='tool-late'&&activity.status==='running'&&activity.after_message_id===conversationMessageId('','assistant','late-native-message')))).toBe(true);
    expect(frames.at(-1)?.activities).toEqual([
      expect.objectContaining({
        id:'tool-late',
        status:'completed',
        result_preview:'/tmp/demo',
        after_message_id:conversationMessageId('','assistant','late-native-message'),
      }),
    ]);
  });
  it('keeps all tool activities in one progress slot for the current input',async()=>{
    sdk.messages=[
      stream({type:'message_start',message:{id:'tools-round'}}),
      stream({type:'content_block_start',index:0,content_block:{type:'tool_use',id:'first',name:'Bash',input:{command:'pwd'}}}),
      {type:'user',uuid:'019ff001-1212-7212-8212-121212121214',session_id:session,parent_tool_use_id:'first',message:{content:[{type:'tool_result',tool_use_id:'first',content:'/tmp'}]}},
      stream({type:'content_block_start',index:0,content_block:{type:'tool_use',id:'second',name:'Bash',input:{command:'git status'}}}),
      {type:'result',subtype:'success',uuid:'019ff001-1212-7212-8212-121212121215',session_id:session},
    ];
    const runtime=ensureClaudeRuntime(session,'/tmp');
    await runtime.submit('Inspect');
    await vi.waitFor(()=>expect(runtime.runtime().state).toBe('idle'));
    const activities=runtime.snapshot().activities;
    expect(activities).toHaveLength(2);
    expect(new Set(activities.map(activity=>activity.after_message_id)).size).toBe(1);
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
  it('keeps tool rounds in progress and finalizes only the conclusion',async()=>{
    sdk.messages=[
      stream({type:'message_start',message:{id:'tool-round'}}),
      stream({type:'content_block_start',index:0,content_block:{type:'tool_use',id:'read-one',name:'Read',input:{file_path:'/p/README.md'}}}),
      {type:'assistant',uuid:assistant,session_id:session,parent_tool_use_id:null,message:{id:'tool-round',content:[{type:'tool_use',id:'read-one',name:'Read',input:{file_path:'/p/README.md'}}]}},
      {type:'user',uuid:'019ff001-1212-7212-8212-121212121214',session_id:session,parent_tool_use_id:'read-one',message:{content:[{type:'tool_result',tool_use_id:'read-one',content:'README'}]}},
      stream({type:'message_start',message:{id:'answer-round'}}),
      stream({type:'content_block_start',index:0,content_block:{type:'text',text:'Project summary'}}),
      {type:'assistant',uuid:'019ff001-1212-7212-8212-121212121215',session_id:session,parent_tool_use_id:null,message:{id:'answer-round',content:[{type:'text',text:'Project summary'}]}},
      {type:'result',subtype:'success',uuid:'019ff001-1212-7212-8212-121212121216',session_id:session},
    ];
    const runtime=ensureClaudeRuntime(session,'/tmp');
    await runtime.submit('Inspect');
    await vi.waitFor(()=>expect(runtime.runtime().state).toBe('idle'));
    const assistants=runtime.snapshot().messages.filter(message=>message.role==='assistant');
    expect(assistants.map(message=>({id:message.id,phase:message.phase,tools:message.content_blocks?.filter(block=>block.type==='tool_use').map(block=>block.name)}))).toEqual([
      {id:conversationMessageId('','assistant','tool-round'),phase:'commentary',tools:['Read']},
      {id:conversationMessageId('','assistant','answer-round'),phase:'final',tools:[]},
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
