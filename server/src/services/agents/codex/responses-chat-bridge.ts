import type { FastifyPluginAsync } from 'fastify';
import { deriveAgentSecret, readAgentManagement } from '../management-store.js';
import { providerApiKey } from './management.js';
import { providerApiUrl, providerErrorCode } from './provider-probe.js';

type JsonObject = Record<string, any>;

function isLoopback(address = ''): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
    || address.startsWith('::ffff:127.');
}

export function responsesInputToChatMessages(body: JsonObject): JsonObject[] {
  const messages: JsonObject[] = [];
  if (typeof body.instructions === 'string' && body.instructions) {
    messages.push({ role: 'system', content: body.instructions });
  }
  if (typeof body.input === 'string') {
    messages.push({ role: 'user', content: body.input });
    return messages;
  }
  if (!Array.isArray(body.input)) return messages;
  for (const item of body.input) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'message') {
      const role = ['system', 'developer', 'assistant'].includes(item.role) ? item.role : 'user';
      const content = Array.isArray(item.content)
        ? item.content.map((part: JsonObject) => part.type === 'input_text' || part.type === 'output_text'
          ? { type: 'text', text: part.text }
          : part.type === 'input_image' && part.image_url
            ? { type: 'image_url', image_url: { url: part.image_url } }
            : null).filter(Boolean)
        : item.content;
      messages.push({ role, content });
    } else if (item.type === 'function_call_output') {
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: String(item.output ?? '') });
    } else if (item.type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: item.call_id,
          type: 'function',
          function: { name: item.name, arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}) },
        }],
      });
    }
  }
  return messages;
}

function toChatTools(tools: unknown): JsonObject[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const mapped = tools.flatMap((tool: JsonObject) => tool?.type === 'function' && tool.name
    ? [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters ?? {} } }]
    : []);
  return mapped.length ? mapped : undefined;
}

export function responsesRequestToChat(body: JsonObject): JsonObject {
  const toolChoice = typeof body.tool_choice === 'object' && body.tool_choice?.type === 'function'
    ? { type: 'function', function: { name: body.tool_choice.name } }
    : body.tool_choice;
  const additionalTools = Array.isArray(body.input)
    ? body.input.flatMap((item: JsonObject) => item?.type === 'additional_tools' && Array.isArray(item.tools) ? item.tools : [])
    : [];
  const effectiveTools = toChatTools([...(body.tools ?? []), ...additionalTools]);
  const textFormat = body.text?.format;
  return {
    model: body.model,
    messages: responsesInputToChatMessages(body),
    ...(effectiveTools ? { tools: effectiveTools } : {}),
    ...(body.tool_choice && effectiveTools ? { tool_choice: toolChoice } : {}),
    ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
    ...(typeof body.top_p === 'number' ? { top_p: body.top_p } : {}),
    ...(typeof body.max_output_tokens === 'number' ? { max_completion_tokens: body.max_output_tokens } : {}),
    ...(typeof body.stop === 'string' || Array.isArray(body.stop) ? { stop: body.stop } : {}),
    ...(body.parallel_tool_calls === false ? { parallel_tool_calls: false } : {}),
    ...(body.reasoning?.effort ? { reasoning_effort: body.reasoning.effort } : {}),
    ...(textFormat?.type === 'json_schema' ? { response_format: { type: 'json_schema', json_schema: textFormat } }
      : textFormat?.type === 'json_object' ? { response_format: { type: 'json_object' } } : {}),
    ...(body.stream === true ? { stream: true } : {}),
  };
}

export function chatCompletionToResponse(chat: JsonObject): JsonObject {
  const choice = chat.choices?.[0];
  const message = choice?.message ?? {};
  const output: JsonObject[] = [];
  if (typeof message.refusal === 'string' && message.refusal) {
    output.push({ id: `msg_${chat.id}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'refusal', refusal: message.refusal }] });
  }
  if (typeof message.content === 'string' && message.content) {
    output.push({ id: `msg_${chat.id}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: message.content, annotations: [] }] });
  }
  for (const call of message.tool_calls ?? []) {
    output.push({ id: call.id, type: 'function_call', status: 'completed', call_id: call.id, name: call.function?.name ?? '', arguments: call.function?.arguments ?? '{}' });
  }
  return {
    id: `resp_${chat.id ?? Date.now()}`,
    object: 'response',
    created_at: chat.created ?? Math.floor(Date.now() / 1000),
    status: 'completed',
    error: null,
    incomplete_details: null,
    model: chat.model,
    output,
    output_text: typeof message.content === 'string' ? message.content : '',
    usage: chat.usage ? {
      input_tokens: chat.usage.prompt_tokens ?? 0,
      output_tokens: chat.usage.completion_tokens ?? 0,
      total_tokens: chat.usage.total_tokens ?? 0,
      input_tokens_details: { cached_tokens: chat.usage.prompt_tokens_details?.cached_tokens ?? 0 },
      output_tokens_details: { reasoning_tokens: chat.usage.completion_tokens_details?.reasoning_tokens ?? 0 },
    } : null,
  };
}

function writeEvent(reply: any, event: string, data: JsonObject): void {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function forwardStream(upstream: Response, reply: any, signal: AbortSignal): Promise<void> {
  if (!upstream.body) throw Error('上游未返回流式响应');
  const responseId = `resp_${Date.now()}`;
  let text = '';
  let buffer = '';
  const toolCalls = new Map<number, JsonObject>();
  const startedTools = new Set<number>();
  const toolOutputIndexes = new Map<number, number>();
  let textOutputIndex: number | null = null;
  let nextOutputIndex = 0;
  let finished = false;
  writeEvent(reply, 'response.created', { type: 'response.created', response: { id: responseId, object: 'response', status: 'in_progress', output: [] } });
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const payload = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
        if (!payload || payload === '[DONE]') continue;
        let chunk: JsonObject;
        try { chunk = JSON.parse(payload); } catch { continue; }
        for (const choice of chunk.choices ?? []) {
          const delta = choice.delta ?? {};
          if (typeof delta.content === 'string' && delta.content) {
            if (textOutputIndex === null) {
              textOutputIndex = nextOutputIndex++;
              writeEvent(reply, 'response.output_item.added', { type: 'response.output_item.added', output_index: textOutputIndex, item: { id: `${responseId}_msg`, type: 'message', status: 'in_progress', role: 'assistant', content: [] } });
              writeEvent(reply, 'response.content_part.added', { type: 'response.content_part.added', item_id: `${responseId}_msg`, output_index: textOutputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
            }
            text += delta.content;
            writeEvent(reply, 'response.output_text.delta', { type: 'response.output_text.delta', item_id: `${responseId}_msg`, output_index: textOutputIndex, content_index: 0, delta: delta.content });
          }
          for (const part of delta.tool_calls ?? []) {
            const index = Number(part.index ?? 0);
            const call = toolCalls.get(index) ?? { id: '', name: '', arguments: '' };
            if (!toolOutputIndexes.has(index)) toolOutputIndexes.set(index, nextOutputIndex++);
            const outputIndex = toolOutputIndexes.get(index)!;
            if (part.id) call.id = part.id;
            if (part.function?.name) call.name += part.function.name;
            if (!startedTools.has(index) && call.id) {
              startedTools.add(index);
              writeEvent(reply, 'response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item: { id: call.id, type: 'function_call', status: 'in_progress', call_id: call.id, name: call.name, arguments: '' } });
            }
            if (part.function?.arguments) {
              call.arguments += part.function.arguments;
              if (call.id) writeEvent(reply, 'response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: call.id, output_index: outputIndex, delta: part.function.arguments });
            }
            toolCalls.set(index, call);
          }
          if (choice.finish_reason && !finished) {
            finished = true;
            const output: JsonObject[] = [];
            if (text) {
              const item = { id: `${responseId}_msg`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] };
              writeEvent(reply, 'response.output_text.done', { type: 'response.output_text.done', item_id: item.id, output_index: textOutputIndex, content_index: 0, text });
              writeEvent(reply, 'response.content_part.done', { type: 'response.content_part.done', item_id: item.id, output_index: textOutputIndex, content_index: 0, part: item.content[0] });
              writeEvent(reply, 'response.output_item.done', { type: 'response.output_item.done', output_index: textOutputIndex, item });
              output.push(item);
            }
            for (const [index, call] of toolCalls) {
              const item = { id: call.id, type: 'function_call', status: 'completed', call_id: call.id, name: call.name, arguments: call.arguments };
              const outputIndex = toolOutputIndexes.get(index) ?? nextOutputIndex++;
              if (!startedTools.has(index)) writeEvent(reply, 'response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item: { ...item, status: 'in_progress' } });
              writeEvent(reply, 'response.function_call_arguments.done', { type: 'response.function_call_arguments.done', item_id: call.id, output_index: outputIndex, arguments: call.arguments });
              writeEvent(reply, 'response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item });
              output.push(item);
            }
            output.sort((left, right) => {
              const leftIndex = left.type === 'message' ? textOutputIndex ?? 0 : [...toolCalls.entries()].find(([_, call]) => call.id === left.id)?.[0] ?? 0;
              const rightIndex = right.type === 'message' ? textOutputIndex ?? 0 : [...toolCalls.entries()].find(([_, call]) => call.id === right.id)?.[0] ?? 0;
              return leftIndex - rightIndex;
            });
            writeEvent(reply, 'response.completed', { type: 'response.completed', response: { id: responseId, object: 'response', status: 'completed', output } });
          }
        }
      }
      if (done) break;
    }
    if (!finished && !signal.aborted) {
      const output: JsonObject[] = [];
      if (text) output.push({ id: `${responseId}_msg`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] });
      for (const call of toolCalls.values()) output.push({ id: call.id, type: 'function_call', status: 'completed', call_id: call.id, name: call.name, arguments: call.arguments });
      writeEvent(reply, 'response.completed', { type: 'response.completed', response: { id: responseId, object: 'response', status: 'completed', output } });
    }
  } finally {
    reader.releaseLock();
  }
  reply.raw.end(finished && !signal.aborted ? 'data: [DONE]\n\n' : undefined);
}

export const codexProviderProxyPlugin: FastifyPluginAsync = async app => {
  app.post<{ Params: { providerId: string }; Body: JsonObject }>('/codex-providers/:providerId/v1/responses', async (request, reply) => {
    if (!isLoopback(request.raw.socket.remoteAddress)) return reply.code(403).send({ error: { message: '本机 Provider 代理仅允许本机访问', type: 'invalid_request_error' } });
    const providerId = request.params.providerId;
    const expected = deriveAgentSecret(`codex-responses-bridge:${providerId}`);
    const authorization = request.headers.authorization ?? '';
    if (authorization !== `Bearer ${expected}`) return reply.code(401).send({ error: { message: 'Provider 代理凭证无效', type: 'authentication_error' } });
    const provider = readAgentManagement('codex').providers.find(item => item.id === providerId);
    if (!provider || provider.fields.protocol !== 'chat_completions') return reply.code(404).send({ error: { message: 'Provider 不存在或不需要协议转换', type: 'invalid_request_error' } });
    const envKey = typeof provider.fields.envKey === 'string' ? provider.fields.envKey : '';
    const apiKey = providerApiKey(providerId) || (envKey ? process.env[envKey] ?? '' : '');
    if (!apiKey) return reply.code(502).send({ error: { message: 'Provider API Key 不可用', type: 'server_error' } });
    const endpoint = typeof provider.fields.baseUrl === 'string' ? provider.fields.baseUrl : '';
    const controller = new AbortController();
    request.raw.socket.on('close', () => controller.abort());
    reply.raw.once('close', () => { if (!reply.raw.writableEnded) controller.abort(); });
    const timeout = setTimeout(() => controller.abort(), 120_000);
    timeout.unref();
    try {
      const upstream = await fetch(providerApiUrl(endpoint, 'chat/completions'), {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: request.body.stream ? 'text/event-stream' : 'application/json' },
        body: JSON.stringify(responsesRequestToChat(request.body)),
        redirect: 'error',
        signal: controller.signal,
      });
      if (!upstream.ok) {
        const code = upstream.status === 401 || upstream.status === 403
          ? await providerErrorCode(upstream)
          : null;
        return reply.code(upstream.status).send({ error: {
          message: `上游 Chat Completions 请求失败 (${upstream.status}${code ? `: ${code}` : ''})`,
          type: 'upstream_error',
        } });
      }
      if (request.body.stream) {
        reply.hijack();
        reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        await forwardStream(upstream, reply, controller.signal);
        return reply;
      }
      return chatCompletionToResponse(await upstream.json() as JsonObject);
    } catch (error) {
      clearTimeout(timeout);
      if (controller.signal.aborted) return reply;
      if (reply.raw.headersSent) {
        reply.raw.end();
        return reply;
      }
      request.log.warn({ err: error, providerId }, 'Codex Provider protocol bridge failed');
      return reply.code(502).send({ error: { message: '上游 Chat Completions 请求失败', type: 'upstream_error' } });
    } finally {
      clearTimeout(timeout);
    }
  });
};
