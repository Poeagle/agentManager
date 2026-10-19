import {afterEach, describe, expect, it, vi} from 'vitest';
import {callModel, type ModelMessage} from '../src/services/platform-ai/model.js';
import type {AiConfig} from '../src/services/platform-ai/config.js';

const config: AiConfig = {enabled:true,endpoint:'https://gateway.example/v1',model:'test',api_key:'secret',timeout_ms:1000,max_tool_rounds:8,observation_interval_seconds:15,assessment_interval_seconds:90,notification_interval_seconds:300};
const messages: ModelMessage[] = [{role:'user',content:'你好'}];
const frame = (delta: unknown, finish_reason: string | null = null) => `data: ${JSON.stringify({choices:[{delta,finish_reason}]})}\r\n\r\n`;
const streamed = (text: string, fragment = false) => new Response(new ReadableStream({start(controller) {
  const bytes = new TextEncoder().encode(text);
  if (fragment) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
  else controller.enqueue(bytes);
  controller.close();
}}), {headers:{'Content-Type':'text/event-stream'}});
afterEach(() => vi.unstubAllGlobals());

describe('streamed platform model replies', () => {
  it('publishes visible text before the response finishes and handles split Unicode/CRLF frames', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream<Uint8Array>({start(value) {controller = value;}}),{headers:{'Content-Type':'text/event-stream'}});
    const fetchMock = vi.fn().mockResolvedValue(response); vi.stubGlobal('fetch',fetchMock);
    const onContent = vi.fn();
    const result = callModel(config,messages,undefined,undefined,{onContent});
    controller.enqueue(new TextEncoder().encode(frame({content:'你好'})));
    await vi.waitFor(() => expect(onContent).toHaveBeenCalledWith('你好'));
    for (const byte of new TextEncoder().encode(frame({content:'，正在查询。'}) + frame({},'stop'))) controller.enqueue(Uint8Array.of(byte));
    controller.close();
    expect((await result).content).toBe('你好，正在查询。');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).stream).toBe(true);
  });
  it('assembles fragmented tool names and arguments only after a completed turn', async () => {
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(streamed(
      frame({tool_calls:[{index:0,id:'call-1',type:'function',function:{name:'start_',arguments:'{"project'}}]}) +
      frame({tool_calls:[{index:0,function:{name:'work',arguments:'_id":"p"}'}}]}) + frame({},'tool_calls'), true)));
    const response = await callModel(config,messages,undefined,undefined,{onContent:()=>{}});
    expect(response.tool_calls).toEqual([{id:'call-1',type:'function',function:{name:'start_work',arguments:'{"project_id":"p"}'}}]);
  });
  it.each([
    [frame({content:'尚未完成'}),'提前断开'],
    [frame({content:'部分回复'}) + frame({},'length'),'截断'],
    ['data: invalid-json\n\n','无效 JSON'],
    [frame({tool_calls:[{index:9,id:'x'}]}),'索引无效'],
  ])('rejects interrupted or malformed turns without returning partial tool calls', async (wire, error) => {
    const fetchMock = vi.fn().mockResolvedValue(streamed(wire));vi.stubGlobal('fetch',fetchMock);
    await expect(callModel(config,messages,undefined,undefined,{onContent:()=>{}})).rejects.toThrow(error);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('accepts a provider returning JSON despite the stream option', async () => {
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({choices:[{message:{content:'完整回复'}}]}))));
    const onContent=vi.fn();
    expect((await callModel(config,messages,undefined,undefined,{onContent})).content).toBe('完整回复');
    expect(onContent).toHaveBeenCalledWith('完整回复');
  });
  it('falls back only after an explicit streaming rejection, never after authentication failure', async () => {
    const fetchMock=vi.fn().mockResolvedValueOnce(new Response('{}',{status:400})).mockResolvedValueOnce(new Response(JSON.stringify({choices:[{message:{content:'兼容回复'}}]})));
    vi.stubGlobal('fetch',fetchMock);
    expect((await callModel(config,messages,undefined,undefined,{onContent:()=>{}})).content).toBe('兼容回复');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).stream).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).not.toHaveProperty('stream');
    fetchMock.mockReset().mockResolvedValue(new Response('{}',{status:401}));
    await expect(callModel(config,messages,undefined,undefined,{onContent:()=>{}})).rejects.toThrow('401');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
