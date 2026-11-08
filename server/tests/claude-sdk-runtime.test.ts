import {afterEach,describe,expect,it,vi} from 'vitest';

const sdk=vi.hoisted(()=>({messages:[] as any[],queries:[] as any[]}));
vi.mock('@anthropic-ai/claude-agent-sdk',()=>({
  query:(request:any)=>{
    sdk.queries.push(request);
    return {
    async *[Symbol.asyncIterator](){for(const message of sdk.messages){await Promise.resolve();yield message;}},
    interrupt:async()=>{},
    close:()=>{},
  };},
}));

import {ensureClaudeRuntime,releaseClaudeRuntime} from '../src/services/agents/claude/sdk-runtime.js';

const session='019ff001-1212-7212-8212-121212121212';
const assistant='019ff001-1212-7212-8212-121212121213';
let uuid=0;
const stream=(event:any)=>({type:'stream_event',uuid:`019ff001-1212-7212-8212-${String(++uuid).padStart(12,'0')}`,session_id:session,parent_tool_use_id:null,event});

afterEach(()=>{releaseClaudeRuntime(session);sdk.queries=[];sdk.messages=[];uuid=0;});

describe('Claude Agent SDK runtime',()=>{
  it('uses protocol envelopes instead of per-chunk UUIDs and preserves text around tools',async()=>{
    sdk.messages=[
      stream({type:'message_start',message:{id:'api-message-one'}}),
      stream({type:'content_block_start',index:0,content_block:{type:'text',text:'我先'}}),
      stream({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'读取。'}}),
      stream({type:'content_block_stop',index:0}),
      stream({type:'content_block_start',index:1,content_block:{type:'tool_use',id:'tool-1',name:'Read',input:{file_path:'/tmp/demo.ts'}}}),
      stream({type:'content_block_stop',index:1}),
      stream({type:'message_stop'}),
      {type:'assistant',uuid:assistant,session_id:session,parent_tool_use_id:null,message:{content:[{type:'text',text:'我先读取。'},{type:'tool_use',id:'tool-1',name:'Read',input:{file_path:'/tmp/demo.ts'}}]}},
      {type:'user',uuid:'019ff001-1212-7212-8212-121212121214',session_id:session,parent_tool_use_id:'tool-1',message:{content:[{type:'tool_result',tool_use_id:'tool-1',content:'ok'}]}},
      stream({type:'message_start',message:{id:'api-message-two'}}),
      stream({type:'content_block_start',index:0,content_block:{type:'text',text:''}}),
      stream({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'读取'}}),
      stream({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'完成。'}}),
      stream({type:'content_block_stop',index:0}),
      stream({type:'message_stop'}),
      {type:'assistant',uuid:'019ff001-1212-7212-8212-121212121216',session_id:session,parent_tool_use_id:null,message:{content:[{type:'text',text:'读取完成。'}]}},
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
    expect(new Set(assistants.map((message:any)=>message.id)).size).toBe(2);
    expect(assistants).toEqual(assistants.map((message:any)=>expect.objectContaining({phase:'final',streaming:false})));
    expect(final.activities).toEqual([expect.objectContaining({id:'tool-1',label:'读取文件 · /tmp/demo.ts',status:'completed'})]);
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
  it('resumes an existing SDK session after process recovery',async()=>{
    sdk.messages=[{type:'result',subtype:'success',uuid:assistant,session_id:session}];
    const runtime=ensureClaudeRuntime(session,'/tmp',undefined,undefined,true);
    expect(await runtime.submit('继续')).toBe(true);
    await vi.waitFor(()=>expect(runtime.runtime().state).toBe('idle'));
    expect(sdk.queries).toHaveLength(1);
    expect(sdk.queries[0].options).toMatchObject({resume:session});
    expect(sdk.queries[0].options).not.toHaveProperty('sessionId');
  });
});
