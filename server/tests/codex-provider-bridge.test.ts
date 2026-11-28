import { afterEach, expect, it, vi } from 'vitest';
import { detectProviderProtocol, probeProviderModels, providerApiUrl } from '../src/services/agents/codex/provider-probe.js';
import {
  chatCompletionToResponse,
  forwardStream,
  responsesRequestToChat,
} from '../src/services/agents/codex/responses-chat-bridge.js';

afterEach(() => vi.unstubAllGlobals());

it('normalizes provider URLs and detects a Chat Completions-only gateway without generating output', async () => {
  expect(providerApiUrl('https://gateway.example/v1/chat/completions', 'models'))
    .toBe('https://gateway.example/v1/models');
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(Response.json({ data: [{ id: 'deepseek-v4.1-flash' }] }))
    .mockResolvedValueOnce(new Response('not found', { status: 404 }))
    .mockResolvedValueOnce(new Response(null, { status: 405 }));
  vi.stubGlobal('fetch', fetchMock);

  const result = await detectProviderProtocol('https://gateway.example/v1', 'fixture-key');

  expect(result.protocol).toBe('chat_completions');
  expect(result.models.map(model => model.model)).toEqual(['deepseek-v4.1-flash']);
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
    'https://gateway.example/v1/models',
    'https://gateway.example/v1/responses',
    'https://gateway.example/v1/chat/completions',
  ]);
  expect(fetchMock.mock.calls.slice(1).map(([, options]) => options?.method)).toEqual(['OPTIONS', 'OPTIONS']);
  expect(fetchMock.mock.calls.slice(1).every(([, options]) => !options?.body)).toBe(true);
});

it('reports a bounded upstream authentication code when model discovery is rejected', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    error: { code: 'qq_bind_required', message: 'private upstream details' },
  }, { status: 403 })));

  await expect(probeProviderModels('https://gateway.example/v1', 'fixture-key'))
    .rejects.toThrow('模型探测失败 (403: qq_bind_required)');
});

it('preserves a Chat Completions authentication error when the other protocol is absent', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(Response.json({ data: [{ id: 'model-a' }] }))
    .mockResolvedValueOnce(new Response('not found', { status: 404 }))
    .mockResolvedValueOnce(Response.json({
      error: { code: 'qq_bind_required', message: 'private upstream details' },
    }, { status: 403 }));
  vi.stubGlobal('fetch', fetchMock);

  await expect(detectProviderProtocol('https://gateway.example/v1', 'fixture-key'))
    .rejects.toThrow('上游认证失败 (403: qq_bind_required)');
});

it('lowers Responses instructions, messages, tools and generation settings to Chat Completions', () => {
  expect(responsesRequestToChat({
    model: 'deepseek-v4.1-flash',
    instructions: 'Be concise',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      { type: 'additional_tools', tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }] },
    ],
    tools: [],
    tool_choice: { type: 'function', name: 'lookup' },
    max_output_tokens: 300,
    reasoning: { effort: 'high' },
    text: { format: { type: 'json_object' } },
  })).toEqual({
    model: 'deepseek-v4.1-flash',
    messages: [
      { role: 'system', content: 'Be concise' },
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ],
    tools: [{ type: 'function', function: { name: 'lookup', description: undefined, parameters: { type: 'object' } } }],
    tool_choice: { type: 'function', function: { name: 'lookup' } },
    max_completion_tokens: 300,
    reasoning_effort: 'high',
    response_format: { type: 'json_object' },
  });
});

it('maps non-stream responses and preserves usage and tool calls', () => {
  expect(chatCompletionToResponse({
    id: 'chat-1', model: 'model-1', created: 42,
    choices: [{ message: { content: 'done', tool_calls: [{ id: 'call-1', function: { name: 'lookup', arguments: '{"q":"x"}' } }] } }],
    usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
  })).toMatchObject({
    id: 'resp_chat-1', status: 'completed', created_at: 42,
    output_text: 'done',
    output: [
      { type: 'message', content: [{ type: 'output_text', text: 'done' }] },
      { type: 'function_call', call_id: 'call-1', name: 'lookup', arguments: '{"q":"x"}' },
    ],
    usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
  });
});

it('emits tool item creation before argument deltas and completes once', async () => {
  const frames = [
    { id: 'chat-1', model: 'model-1', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'lookup', arguments: '{"q":' } }] } }] },
    { id: 'chat-1', model: 'model-1', choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }, finish_reason: 'tool_calls' }] },
  ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n';
  const encoder = new TextEncoder();
  const upstream = new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(frames)); controller.close(); } }));
  const writes: string[] = [];
  const reply = { raw: { write: (value: string) => writes.push(value), end: (value?: string) => { if (value) writes.push(value); } } };

  await forwardStream(upstream, reply, new AbortController().signal);

  const body = writes.join('');
  expect(body.indexOf('response.output_item.added')).toBeLessThan(body.indexOf('response.function_call_arguments.delta'));
  expect(body.match(/event: response.completed/g)).toHaveLength(1);
  expect(body).toContain('"arguments":"{\\"q\\":\\"x\\"}"');
});
