import {afterEach,describe,expect,it,vi} from 'vitest';

const sdk=vi.hoisted(()=>({messages:[] as any[],queries:[] as any[],interrupts:0}));
vi.mock('@anthropic-ai/claude-agent-sdk',()=>({
  query:(request:any)=>{
    const handle={
      ...request,
      interrupt:async()=>{sdk.interrupts++;},
      close:()=>{handle.closed=true;},
    };
    sdk.queries.push(handle);
    return {
    async *[Symbol.asyncIterator](){for(const message of sdk.messages){await Promise.resolve();yield message;}},
    setModel:async(model:string)=>{handle.setModel=model;},
    interrupt:handle.interrupt,
    close:handle.close,
  };},
}));

import {claudeRuntime,ensureClaudeRuntime,releaseClaudeRuntime} from '../src/services/agents/claude/sdk-runtime.js';
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
  it('keeps an upstream 503 as an error card instead of final prose',async()=>{
    sdk.messages=[
      {type:'result',subtype:'error_during_execution',uuid:assistant,session_id:session,errors:['API Error: 503 {"error":{"message":"No available accounts: no available accounts","type":"api_error"},"type":"error"}']},
    ];
    const runtime=ensureClaudeRuntime(session,'/tmp');
    await runtime.submit('介绍你自己');
    await vi.waitFor(()=>expect(runtime.runtime().state).toBe('idle'));
    const error=runtime.snapshot().messages.find(message=>message.role==='assistant');
    expect(error).toMatchObject({
      phase:'error',
      text:expect.stringContaining('No available accounts'),
      error:{code:'provider_unavailable',will_retry:false},
    });
  });
  it('keeps the same 429 error identity in the SDK stream and on history reload',async()=>{
    const text='API Error: Request rejected (429) · Daily usage quota exhausted for this platform.';
    const message={id:'synthetic-rate-limit',model:'<synthetic>',role:'assistant',stop_reason:'stop_sequence',content:[{type:'text',text}]};
    sdk.messages=[
      {type:'assistant',uuid:assistant,session_id:session,parent_tool_use_id:null,error:'rate_limit',message},
      {type:'result',subtype:'error_during_execution',uuid:'result',errors:[text]},
    ];
    const runtime=ensureClaudeRuntime(session,'/tmp');
    await runtime.submit('Send a message');
    await vi.waitFor(()=>expect(runtime.snapshot().busy).toBe(false));
    const persisted=parseClaudeMessage(Buffer.from(JSON.stringify({
      type:'assistant',uuid:assistant,isApiErrorMessage:true,error:'rate_limit',message,
    })));
    expect(runtime.snapshot().messages.filter(item=>item.role==='assistant')).toEqual([
      expect.objectContaining({id:persisted?.failure?.id,text,phase:'error',error:{code:'rate_limit',will_retry:false}}),
    ]);
  });
  it('continues an already submitted follow-up after a tool interruption diagnostic',async()=>{
    let deliverInitial!:(value:unknown)=>void;
    let deliverDiagnostic!:(value:unknown)=>void;
    let deliverFollowup!:(value:unknown)=>void;
    sdk.messages=[
      new Promise(resolve=>{deliverInitial=resolve;}),
      new Promise(resolve=>{deliverDiagnostic=resolve;}),
      new Promise(resolve=>{deliverFollowup=resolve;}),
      {type:'assistant',uuid:assistant,session_id:session,parent_tool_use_id:null,message:{id:'followup-answer',stop_reason:'end_turn',content:[{type:'text',text:'Follow-up complete'}]}},
    ];
    const runtime=ensureClaudeRuntime(session,'/tmp');
    await runtime.submit('Use a tool','initial');
    await vi.waitFor(()=>expect(sdk.queries).toHaveLength(1));
    const input=sdk.queries[0].prompt[Symbol.asyncIterator]();
    deliverInitial((await input.next()).value);
    await runtime.submit('Continue','followup');
    const followup=(await input.next()).value;
    deliverDiagnostic({type:'result',subtype:'error_during_execution',uuid:'diagnostic',errors:[
      '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use',
    ]});
    deliverFollowup(followup);
    await vi.waitFor(()=>expect(runtime.snapshot().busy).toBe(false));
    expect(runtime.snapshot().messages.filter(item=>item.role==='assistant')).toEqual([
      expect.objectContaining({phase:'final',text:'Follow-up complete'}),
    ]);
    expect(sdk.queries).toHaveLength(1);
  });
  it('injects only the bound Provider credentials and model into the SDK process',async()=>{
    sdk.messages=[{type:'result',subtype:'success',uuid:assistant,session_id:session}];
    const runtime=ensureClaudeRuntime(session,'/tmp',undefined,{model:'claude-a',effort:''},false,{
      id:'gateway',name:'Gateway',baseUrl:'https://gateway.example',authToken:'private-token',
      models:['claude-a','claude-b'],defaultModel:'claude-a',haikuModel:null,subagentModel:null,effort:null,autoCompactWindow:null,adaptiveThinking:true,contextWindow:200000,maxOutputTokens:64000,
    });
    await runtime.submit('provider-bound');
    await vi.waitFor(()=>expect(runtime.runtime().state).toBe('idle'));
    expect(sdk.queries).toHaveLength(1);
    expect(sdk.queries[0].options).toMatchObject({
      model:'claude-a',
      thinking:{type:'adaptive'},
      env:{
        ANTHROPIC_BASE_URL:'https://gateway.example',
        ANTHROPIC_AUTH_TOKEN:'private-token',
        ANTHROPIC_API_KEY:'',
        ANTHROPIC_MODEL:'claude-a',
        ANTHROPIC_DEFAULT_OPUS_MODEL:'claude-a',
        ANTHROPIC_DEFAULT_SONNET_MODEL:'claude-a',
        ANTHROPIC_DEFAULT_HAIKU_MODEL:'claude-a',
        CLAUDE_CODE_SUBAGENT_MODEL:'claude-a',
        CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL:'claude-a',
        ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES:'adaptive_thinking',
        ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES:'adaptive_thinking',
        ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES:'adaptive_thinking',
        CLAUDE_CODE_MAX_CONTEXT_TOKENS:'200000',
        CLAUDE_CODE_MAX_OUTPUT_TOKENS:'64000',
      },
    });
    expect(runtime.selectedModel()).toBe('claude-a');
  });
  it('uses an updated Provider key on the next request in the same session',async()=>{
    const {createTestDatabase}=await import('./helpers/database.js');
    const database=createTestDatabase();
    try{
      const {agentContext,getAgent}=await import('../src/services/agents/index.js');
      const {createClaudeProvider,updateClaudeProvider}=await import('../src/services/agents/claude/providers.js');
      createClaudeProvider({id:'gateway',apiKey:'fixture-old-key',fields:{
        baseUrl:'https://gateway.example',models:['claude-a'],defaultModel:'claude-a',
      }});
      const context=agentContext({claude_session_id:session,agent_environment_id:'claude-provider:gateway'},
        {projectPath:database.dir});
      const input=getAgent('claude').input;
      sdk.messages=[{type:'result',subtype:'success',uuid:assistant,session_id:session}];
      expect(await input.submit(context,'First request')).toBe(true);
      await vi.waitFor(()=>expect(claudeRuntime(session)?.runtime().state).toBe('idle'));
      expect(sdk.queries[0].options.env.ANTHROPIC_AUTH_TOKEN).toBe('fixture-old-key');

      updateClaudeProvider('gateway',{apiKey:'fixture-new-key',fields:{}});
      expect(await input.submit(context,'Next request')).toBe(true);
      await vi.waitFor(()=>expect(sdk.queries).toHaveLength(2));
      await vi.waitFor(()=>expect(claudeRuntime(session)?.runtime().state).toBe('idle'));
      expect(sdk.queries[1].options).toMatchObject({resume:session,env:{ANTHROPIC_AUTH_TOKEN:'fixture-new-key'}});
    }finally{
      releaseClaudeRuntime(session);
      database.cleanup();
    }
  });
  it('uses adaptive thinking for claude-sonnet-5-5 provider requests',async()=>{
    sdk.messages=[{type:'result',subtype:'success',uuid:assistant,session_id:session}];
    const runtime=ensureClaudeRuntime(session,'/tmp',undefined,{model:'claude-sonnet-5-5',effort:''},false,{
      id:'anthropic',name:'Anthropic',baseUrl:'https://xindu.xyz',authToken:'private-token',
      models:['claude-sonnet-5-5'],defaultModel:'claude-sonnet-5-5',haikuModel:null,subagentModel:null,effort:null,autoCompactWindow:null,adaptiveThinking:true,
      contextWindow:1000000,maxOutputTokens:null,
    });
    await runtime.submit('介绍你自己');
    await vi.waitFor(()=>expect(runtime.runtime().state).toBe('idle'));
    expect(sdk.queries.at(-1)?.options).toMatchObject({
      model:'claude-sonnet-5-5',
      thinking:{type:'adaptive'},
    });
  });
  it('keeps simultaneously active Claude providers isolated by session runtime',async()=>{
    sdk.messages=[{type:'result',subtype:'success',uuid:assistant,session_id:session}];
    const other='019ff001-1212-7212-8212-121212121299';
    const first=ensureClaudeRuntime(session,'/tmp',undefined,{model:'provider-a-model',effort:''},false,{
      id:'provider-a',name:'Provider A',baseUrl:'https://a.example',authToken:'token-a',
      models:['provider-a-model'],defaultModel:'provider-a-model',haikuModel:null,subagentModel:null,effort:null,autoCompactWindow:null,adaptiveThinking:false,contextWindow:null,maxOutputTokens:null,
    });
    const second=ensureClaudeRuntime(other,'/tmp',undefined,{model:'provider-b-model',effort:''},false,{
      id:'provider-b',name:'Provider B',baseUrl:'https://b.example',authToken:'token-b',
      models:['provider-b-model'],defaultModel:'provider-b-model',haikuModel:null,subagentModel:null,effort:null,autoCompactWindow:null,adaptiveThinking:false,contextWindow:null,maxOutputTokens:null,
    });
    await Promise.all([first.submit('A'),second.submit('B')]);
    await vi.waitFor(()=>expect(sdk.queries).toHaveLength(2));
    expect(sdk.queries.map(query=>query.options)).toEqual(expect.arrayContaining([
      expect.objectContaining({model:'provider-a-model',env:expect.objectContaining({ANTHROPIC_BASE_URL:'https://a.example',ANTHROPIC_AUTH_TOKEN:'token-a',ANTHROPIC_MODEL:'provider-a-model'})}),
      expect.objectContaining({model:'provider-b-model',env:expect.objectContaining({ANTHROPIC_BASE_URL:'https://b.example',ANTHROPIC_AUTH_TOKEN:'token-b',ANTHROPIC_MODEL:'provider-b-model'})}),
    ]));
    expect(()=>first.configure({id:'provider-b',name:'Provider B',baseUrl:'https://b.example',authToken:'token-b',models:['provider-b-model'],defaultModel:'provider-b-model',haikuModel:null,subagentModel:null,effort:null,autoCompactWindow:null,adaptiveThinking:false,contextWindow:null,maxOutputTokens:null})).toThrow('另一个 Provider');
    releaseClaudeRuntime(other);
  });
  it('maps every Claude model alias to the concrete model selected for this request',async()=>{
    sdk.messages=[{type:'result',subtype:'success',uuid:assistant,session_id:session}];
    const runtime=ensureClaudeRuntime(session,'/tmp',undefined,{model:'claude-fable-5',effort:''},false,{
      id:'anthropic',name:'Anthropic',baseUrl:'https://xindu.xyz',authToken:'private-token',
      models:['claude-fable-5','opus','sonnet','haiku'],defaultModel:'claude-fable-5',haikuModel:null,subagentModel:null,effort:null,autoCompactWindow:null,contextWindow:null,maxOutputTokens:null,
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
      models:['catalog-model'],defaultModel:'catalog-model',haikuModel:null,subagentModel:null,effort:null,autoCompactWindow:null,contextWindow:null,maxOutputTokens:null,
    });
    expect(()=>runtime.setModel({model:'other-model',effort:''})).toThrow('不属于当前 Provider');
    releaseClaudeRuntime(session);
  });
  it('restores a legacy Claude preference without silently switching models',async()=>{
    sdk.messages=[{type:'result',subtype:'success',uuid:assistant,session_id:session}];
    const runtime=ensureClaudeRuntime(session,'/tmp',undefined,{model:'claude-legacy',effort:''},true,{
      id:'provider',name:'Provider',baseUrl:'https://provider.example',authToken:'token',
      models:['claude-current'],defaultModel:'claude-current',haikuModel:null,subagentModel:null,effort:null,autoCompactWindow:null,contextWindow:null,maxOutputTokens:null,
    });
    await runtime.submit('Restore legacy');
    await vi.waitFor(()=>expect(runtime.runtime().state).toBe('idle'));
    expect(sdk.queries.at(-1)?.options).toMatchObject({model:'claude-legacy'});
  });
  it('reports when the upstream returns a different model than the selected one',async()=>{
    sdk.messages=[
      {type:'assistant',uuid:assistant,session_id:session,parent_tool_use_id:null,message:{id:'wrong-model',model:'grok-4.6',content:[{type:'text',text:'Wrong model response.'}]}},
      {type:'result',subtype:'success',uuid:assistant,session_id:session},
    ];
    const runtime=ensureClaudeRuntime(session,'/tmp',undefined,{model:'claude-opus-4-8',effort:''},false,{
      id:'anthropic',name:'Anthropic',baseUrl:'https://xindu.xyz',authToken:'private-token',
      models:['claude-opus-4-8'],defaultModel:'claude-opus-4-8',haikuModel:null,subagentModel:null,effort:null,autoCompactWindow:null,contextWindow:null,maxOutputTokens:null,
    });
    await runtime.submit('Use the selected model');
    await vi.waitFor(()=>expect(runtime.runtime().state).toBe('idle'));
    expect(runtime.snapshot().messages.find(message=>message.error?.code==='model_mismatch')).toMatchObject({
      text:expect.stringContaining('grok-4.6'),
      error:{code:'model_mismatch',will_retry:false},
    });
  });
  it('accepts a declared Haiku model as the same Provider routing choice',async()=>{
    sdk.messages=[
      {type:'assistant',uuid:assistant,session_id:session,parent_tool_use_id:null,message:{id:'deepseek-normal',model:'deepseek-flash',content:[{type:'text',text:'OK.'}]}},
      {type:'result',subtype:'success',uuid:assistant,session_id:session},
    ];
    const runtime=ensureClaudeRuntime(session,'/tmp',undefined,{model:'deepseek-flash[1m]',effort:''},false,{
      id:'deepseek',name:'DeepSeek',baseUrl:'https://api.deepseek.com/anthropic',authToken:'token',
      models:['deepseek-flash[1m]','deepseek-flash'],defaultModel:'deepseek-flash[1m]',
      haikuModel:'deepseek-flash',subagentModel:'deepseek-flash',effort:'max',autoCompactWindow:786432,adaptiveThinking:false,contextWindow:null,maxOutputTokens:null,
    });
    await runtime.submit('Use identity');
    await vi.waitFor(()=>expect(runtime.runtime().state).toBe('idle'));
    expect(runtime.snapshot().messages.some(message=>message.error?.code==='model_mismatch')).toBe(false);
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
  it('settles one brief submission when the native UUID echo has a different browser identity',async()=>{
    const clientId='5d8a188787520799de08474941aeee20';
    let deliverEcho!: (message: unknown) => void;
    sdk.messages=[
      new Promise(resolve=>{deliverEcho=resolve;}),
      {type:'assistant',uuid:assistant,session_id:session,parent_tool_use_id:null,message:{id:'assistant-brief',role:'assistant',stop_reason:'end_turn',content:[{type:'text',text:'brief answer'}]}},
      {type:'result',subtype:'success',uuid:assistant,session_id:session},
    ];
    const runtime=ensureClaudeRuntime(session,'/tmp');
    await runtime.submit('brief input',clientId);
    await vi.waitFor(()=>expect(sdk.queries).toHaveLength(1));
    const nativeInput=await sdk.queries[0].prompt[Symbol.asyncIterator]().next();
    const nativeUser=nativeInput.value.uuid!;
    const frames:any[]=[];runtime.observe(frame=>frames.push(frame));
    expect(frames[0].messages.filter((message:any)=>message.role==='user')).toMatchObject([
      {id:conversationMessageId('','user',nativeUser),client_id:clientId,native_client_id:clientId},
    ]);
    deliverEcho({type:'user',uuid:nativeUser,session_id:session,parent_tool_use_id:null,message:{role:'user',content:'brief input'}});
    await vi.waitFor(()=>expect(runtime.runtime().state).toBe('idle'));
    for(const frame of frames.slice(-1)){
      const users=frame.messages.filter((message:any)=>message.role==='user');
      expect(users).toHaveLength(1);
      expect(users[0]).toMatchObject({
        id:conversationMessageId('','user',nativeUser),
        client_id:clientId,
        native_client_id:clientId,
        text:'brief input',
      });
    }
  });
  it('uses one user identity for the first Claude Code input from launch through durable history',async()=>{
    const {createTestDatabase}=await import('./helpers/database.js');const database=createTestDatabase();
    let nativeId:string|undefined;
    let deliverEcho!: (message: unknown) => void;
    sdk.messages=[new Promise(resolve=>{deliverEcho=resolve;})];
    try{
      const {claudeAdapter}=await import('../src/services/agents/claude/adapter.js');
      const launch=await claudeAdapter.launch.prepare({session:{id:'first-claude'},projectPath:database.dir} as any,'你好，介绍你自己',undefined,false,'browser-first');
      nativeId=launch.nativeId;
      const live=await vi.waitFor(()=>{const message=claudeRuntime(nativeId!)?.snapshot().messages.find(item=>item.role==='user');expect(message).toBeTruthy();return message!;});
      expect(live.client_id).toBe('browser-first');expect(launch.initialMessageId).toBe(live.id);
      deliverEcho({type:'user',uuid:'019ff001-1212-7212-8212-121212121250',session_id:nativeId,parent_tool_use_id:null,message:{role:'user',content:'你好，介绍你自己'}});
      await vi.waitFor(()=>expect(claudeRuntime(nativeId!)?.snapshot().messages.find(item=>item.role==='user')).toMatchObject({
        id:conversationMessageId('','user','019ff001-1212-7212-8212-121212121250'),
        client_id:'browser-first',native_client_id:'browser-first',
      }));
    }finally{
      deliverEcho({type:'result',subtype:'success',session_id:nativeId});
      if(nativeId)releaseClaudeRuntime(nativeId);
      database.cleanup();
    }
  });
  it('stops only the matching active turn',async()=>{
    let resolve!:(value:any)=>void;sdk.messages=[new Promise(done=>{resolve=done;})];
    const runtime=ensureClaudeRuntime(session,'/tmp');expect(await runtime.submit('Work')).toBe(true);
    const turn=runtime.snapshot().turn_id!;expect(await runtime.stopTurn('old-turn')).toBe(false);expect(sdk.interrupts).toBe(0);
    expect(await runtime.stopTurn(turn)).toBe(true);expect(sdk.interrupts).toBe(1);
    expect(runtime.runtime()).toMatchObject({state:'idle',completed_turn_id:expect.any(String)});
    resolve({type:'result',subtype:'success',uuid:assistant,session_id:session});await vi.waitFor(()=>expect(runtime.runtime().state).toBe('idle'));expect(await runtime.stopTurn(turn)).toBe(false);
  });
  it('publishes idle immediately when the SDK interrupt RPC never settles',async()=>{
    let resolve!:(value:any)=>void;sdk.messages=[new Promise(done=>{resolve=done;})];
    const runtime=ensureClaudeRuntime(session,'/tmp');
    expect(await runtime.submit('Work')).toBe(true);
    const turn=runtime.snapshot().turn_id!;
    vi.spyOn(sdk.queries.at(-1),'interrupt').mockImplementation(()=>new Promise(()=>{}));
    const started=Date.now();
    expect(await runtime.stopTurn(turn)).toBe(true);
    expect(Date.now()-started).toBeLessThan(100);
    expect(runtime.runtime().state).toBe('idle');
    expect(runtime.snapshot().busy).toBe(false);
    resolve({type:'result',subtype:'success',uuid:assistant,session_id:session});
    await vi.waitFor(()=>expect(runtime.runtime().state).toBe('idle'));
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
  it('finishes the turn from a native end_turn when the SDK result never arrives',async()=>{
    sdk.messages=[
      stream({type:'message_start',message:{id:'end-turn-first'}}),
      stream({type:'content_block_start',index:0,content_block:{type:'text',text:'Already complete.'}}),
      {
        type:'assistant',
        uuid:assistant,
        session_id:session,
        parent_tool_use_id:null,
        message:{
          id:'end-turn-first',
          role:'assistant',
          stop_reason:'end_turn',
          content:[{type:'text',text:'Already complete.'}],
        },
      },
      new Promise(()=>{}),
    ];
    const runtime=ensureClaudeRuntime(session,'/tmp');
    await runtime.submit('Complete without result');
    await vi.waitFor(()=>expect(runtime.runtime().state).toBe('idle'),{timeout:1000});
    expect(runtime.snapshot().busy).toBe(false);
    expect(runtime.snapshot().stage).toBe('idle');
    expect(sdk.queries.at(-1)?.closed).toBe(true);
    expect(runtime.snapshot().messages.find(message=>message.text==='Already complete.')).toMatchObject({
      phase:'final',
      streaming:false,
    });
  });
  it('keeps the turn active when an end_turn thinking block precedes the final text',async()=>{
    let publishFinal!:(value:unknown)=>void;
    const completed={type:'assistant',uuid:assistant,session_id:session,parent_tool_use_id:null};
    const message={id:'split-final',role:'assistant',stop_reason:'end_turn'};
    sdk.messages=[
      {...completed,message:{...message,content:[{type:'thinking',thinking:'Checking'}]}},
      new Promise(resolve=>{publishFinal=resolve;}),
      new Promise(()=>{}),
    ];
    const runtime=ensureClaudeRuntime(session,'/tmp');
    await runtime.submit('Complete split response');
    await vi.waitFor(()=>expect(runtime.snapshot().messages.some(item=>item.content_blocks?.some(block=>block.type==='thinking'))).toBe(true));
    expect(runtime.snapshot().busy).toBe(true);
    expect(runtime.snapshot().messages.some(item=>item.phase==='final')).toBe(false);
    publishFinal({...completed,message:{...message,content:[{type:'text',text:'Split reply complete.'}]}});
    await vi.waitFor(()=>expect(runtime.snapshot()).toMatchObject({busy:false,stage:'idle'}));
    expect(runtime.snapshot().messages.filter(item=>item.phase==='final')).toMatchObject([{
      text:'Split reply complete.',streaming:false,
      content_blocks:[{type:'thinking',text:'Checking'},{type:'text',text:'Split reply complete.'}],
    }]);
  });
  it('settles a thinking-only response at the SDK result without promoting earlier progress to Final',async()=>{
    const reply=(id:string,content:unknown[],stop_reason:string)=>({
      type:'assistant',uuid:assistant,session_id:session,parent_tool_use_id:null,
      message:{id,role:'assistant',content,stop_reason},
    });
    sdk.messages=[
      reply('progress',[{type:'text',text:'Checking files.'},{type:'tool_use',id:'read',name:'Read',input:{}}],'tool_use'),
      reply('thinking',[{type:'thinking',thinking:'Checking the result'}],'end_turn'),
      {type:'result',subtype:'success',uuid:assistant,session_id:session},
    ];
    const runtime=ensureClaudeRuntime(session,'/tmp');
    await runtime.submit('Complete without a visible reply');
    await vi.waitFor(()=>expect(runtime.snapshot()).toMatchObject({busy:false,stage:'idle'}));
    expect(runtime.snapshot().messages.find(item=>item.text==='Checking files.')?.phase).toBe('commentary');
    expect(runtime.snapshot().messages.some(item=>item.phase==='final')).toBe(false);
  });
  it('matches a follow-up echo arriving before the first user echo even when both inputs repeat the same text',async()=>{
    let echoFollowup!:(message:unknown)=>void;
    let echoFirst!:(message:unknown)=>void;
    sdk.messages=[new Promise(resolve=>{echoFollowup=resolve;}),new Promise(resolve=>{echoFirst=resolve;})];
    const runtime=ensureClaudeRuntime(session,'/tmp');
    await runtime.submit('Continue','browser-first');
    await vi.waitFor(()=>expect(sdk.queries).toHaveLength(1));
    const input=sdk.queries[0].prompt[Symbol.asyncIterator]();
    const first=(await input.next()).value;
    await runtime.submit('Continue','browser-followup');
    const followup=(await input.next()).value;
    echoFollowup(followup);
    await vi.waitFor(()=>expect(runtime.snapshot().messages.filter(item=>item.role==='user')).toMatchObject([
      {id:conversationMessageId('','user',first.uuid),client_id:'browser-first'},
      {id:conversationMessageId('','user',followup.uuid),client_id:'browser-followup',turn_id:followup.uuid},
    ]));
    echoFirst(first);
    await vi.waitFor(()=>expect(runtime.snapshot().busy).toBe(false));
    expect(runtime.snapshot().messages.filter(item=>item.role==='user').map(item=>item.id)).toEqual([
      conversationMessageId('','user',first.uuid),conversationMessageId('','user',followup.uuid),
    ]);
  });
  it('inserts a running follow-up into the current query and continues after interrupt',async()=>{
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
    expect((await input.next()).value).toMatchObject({message:{content:'Insert this guidance'}});
    expect(runtime.snapshot().messages.filter(message=>message.role==='user').map(message=>message.client_id))
      .toEqual(['client-start','client-steer']);
    const emitted=[{type:'result',subtype:'success',uuid:assistant,session_id:session}];
    sdk.messages.push(...emitted);release(emitted);
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
      {type:'user',uuid:'019ff001-1212-7212-8212-121212121214',session_id:session,parent_tool_use_id:'tool-late',message:{content:[{type:'tool_result',tool_use_id:'tool-late',content:'/tmp/demo'}]}},
      {type:'assistant',uuid:assistant,session_id:session,parent_tool_use_id:null,message:{id:'late-native-message',content:[{type:'text',text:'检查中'},{type:'tool_use',id:'tool-late',name:'Bash',input:{command:'pwd'}}]}},
      {type:'result',subtype:'success',uuid:'019ff001-1212-7212-8212-121212121215',session_id:session},
    ];
    const runtime=ensureClaudeRuntime(session,'/tmp');
    const frames:any[]=[];const stop=runtime.observe(frame=>frames.push(frame));
    await runtime.submit('检查');
    await vi.waitFor(()=>expect(runtime.runtime().state).toBe('idle'));
    stop();
    const assistants=frames.at(-1).messages.filter((message:any)=>message.role==='assistant');
    expect(assistants).toHaveLength(1);
    const firstResult=frames.findIndex(frame=>frame.activities.some((activity:any)=>activity.id==='tool-late'&&activity.status==='completed'));
    expect(firstResult).toBeGreaterThan(0);
    expect(frames.slice(0,firstResult).some(frame=>frame.activities.some((activity:any)=>activity.id==='tool-late'&&activity.status==='running'&&activity.input_preview==='pwd'))).toBe(true);
    expect(frames.slice(firstResult).every(frame=>frame.activities.find((activity:any)=>activity.id==='tool-late')?.status==='completed')).toBe(true);
    expect(assistants[0]).toMatchObject({
      id:conversationMessageId('','assistant','late-native-message'),
      text:'检查中',
      content_blocks:[{type:'text',index:0,text:'检查中'}],
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
    const frames:any[]=[];const stop=runtime.observe(frame=>frames.push(frame));
    await runtime.submit('Inspect');
    await vi.waitFor(()=>expect(runtime.runtime().state).toBe('idle'));
    stop();
    const activities=runtime.snapshot().activities;
    expect(activities).toHaveLength(2);
    expect(new Set(activities.map(activity=>activity.after_message_id)).size).toBe(1);
    const started=frames.find(frame=>frame.activities.some((activity:any)=>activity.id==='first'&&activity.status==='running'));
    expect(started).toBeDefined();
    expect(started.messages.some((message:any)=>message.id===started.activities[0].after_message_id)).toBe(false);
    expect(runtime.snapshot().messages.filter(message=>message.role==='assistant'&&message.content_blocks?.some(block=>block.type==='tool_use'))).toEqual([]);
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
