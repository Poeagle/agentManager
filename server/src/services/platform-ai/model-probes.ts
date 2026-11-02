import {aiSourceSchema,isClientSource} from '../ai-source.js';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { readAiConfig, validateHttpUrl, type AiConfig } from './config.js';
import { callModel, ModelRequestError, modelApiUrl, requestModelJson } from './model.js';

const draftSchema = z.object({
  source:aiSourceSchema.optional(),
  endpoint: z.string().trim().max(2048),
  model: z.string().trim().max(160).optional(),
  api_key: z.string().max(4096).optional(),
  timeout_ms: z.number().int().min(1000).max(120000).optional(),
}).strict();

/** Draft-only: no settings writes, worker activation or real platform tool execution. */
function resolveDraft(input: unknown, requireModel: boolean): AiConfig {
  const draft = draftSchema.parse(input);
  const saved = readAiConfig();
  if(isClientSource(draft.source))return {...saved,...draft,source:draft.source,enabled:true,model:draft.model||''};
  const endpoint = validateHttpUrl(draft.endpoint);
  if (!draft.api_key && saved.api_key && (!saved.endpoint || modelApiUrl(endpoint, 'chat/completions') !== modelApiUrl(saved.endpoint, 'chat/completions'))) {
    throw new Error('API 地址已更改，请重新输入 API Key 后再探测或测试');
  }
  const api_key = draft.api_key || saved.api_key;
  if (!api_key) throw new Error('请先输入 API Key');
  if (requireModel && !draft.model) throw new Error('请先选择或输入模型名称');
  return {...saved, ...draft, endpoint, api_key, model: draft.model || '', enabled: true};
}

export async function discoverModels(input: unknown) {
  const config = resolveDraft(input, false);
  if(isClientSource(config.source))throw Error('本机客户端沿用登录账号的可用模型；可留空使用默认模型，或填写模型名后测试');
  const data = await requestModelJson(config, 'models');
  if (!Array.isArray(data?.data)) throw new Error('模型列表格式无效；仍可手动输入模型名称并测试');
  const models = [...new Set<string>(data.data.flatMap((item: unknown) => {
    const id = (item as {id?: unknown})?.id;
    return typeof id === 'string' && id.trim() && id.length <= 160 ? [id.trim()] : [];
  }))].sort((a, b) => a.localeCompare(b));
  return {models};
}

export interface ProbeCheck { status: 'passed' | 'failed' | 'skipped'; message: string }
export interface ModelProbeResult {
  ok: boolean; model: string; elapsed_ms: number;
  checks: {connection: ProbeCheck; response: ProbeCheck; tools: ProbeCheck};
}

export async function testModelConnection(input: unknown): Promise<ModelProbeResult> {
  const config = resolveDraft(input, true);
  const started = Date.now();
  const checks: ModelProbeResult['checks'] = {
    connection: {status: 'skipped', message: '尚未请求'},
    response: {status: 'skipped', message: '未测试'},
    tools: {status: 'skipped', message: '模型响应通过后测试'},
  };
  try {
    const message = await callModel(config, [{role: 'user', content: 'This is a connectivity test. Reply with OK.'}], undefined, undefined, {maxTokens: 128});
    checks.connection = {status: 'passed', message: '接口已连接并通过认证'};
    if (!message.content?.trim() || message.tool_calls?.length) throw new ModelRequestError('模型未返回有效的普通文本回复', true);
    checks.response = {status: 'passed', message: '所选模型已返回有效回复'};
  } catch (error) {
    const reachable = error instanceof ModelRequestError && error.reachable;
    const message = error instanceof ModelRequestError ? error.message : '模型请求失败';
    checks.connection = {status: reachable ? 'passed' : 'failed', message: reachable ? '接口可达；认证及模型结果见下方' : message};
    checks.response = {status: 'failed', message};
    return {ok: false, model: config.model, elapsed_ms: Date.now() - started, checks};
  }
  try {
    const challenge = randomBytes(12).toString('hex');
    const name = 'platform_connection_probe';
    const message = await callModel(config, [{role: 'user', content: `Call ${name} with token exactly "${challenge}". This is a test only.`}], [{
      type: 'function', function: {name, description: 'Return the supplied connectivity test token. No actions are performed.',
        parameters: {type: 'object', properties: {token: {type: 'string'}}, required: ['token'], additionalProperties: false}},
    }], undefined, {maxTokens: 256});
    const calls = message.tool_calls || [];
    let valid = false;
    try { valid = calls.length === 1 && calls[0].function.name === name && JSON.parse(calls[0].function.arguments).token === challenge; }
    catch { /* Invalid function arguments do not prove tool support. */ }
    checks.tools = valid ? {status: 'passed', message: '模型返回了有效的结构化工具调用；测试工具未执行平台操作'}
      : {status: 'failed', message: '未收到预期的结构化工具调用，请更换支持工具调用的模型或检查网关配置'};
  } catch (error) {
    checks.tools = {status: 'failed', message: error instanceof ModelRequestError ? error.message : '工具调用测试失败'};
  }
  return {ok: checks.tools.status === 'passed', model: config.model, elapsed_ms: Date.now() - started, checks};
}
