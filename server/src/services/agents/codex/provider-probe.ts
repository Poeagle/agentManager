import { detectedModelMetadata } from '../provider-pricing.js';
import type {
  AgentModelMetadata,
  AgentProviderDetection,
} from '../types.js';

export type ProviderWireApi = 'responses' | 'chat_completions';

type DetectedModel = AgentModelMetadata & {
  provider?: string;
  model: string;
  name: string;
  description?: string;
  efforts?: Array<{ value: string; description: string }>;
};

function trimEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, '');
}

export function providerWireApi(value: unknown): ProviderWireApi {
  return value === 'chat_completions' ? 'chat_completions' : 'responses';
}

export function providerApiUrl(
  endpoint: string,
  path: 'models' | 'responses' | 'chat/completions',
): string {
  const url = new URL(trimEndpoint(endpoint));
  const suffix = path === 'chat/completions' ? '/chat/completions' : `/${path}`;
  const knownSuffixes = ['/chat/completions', '/responses', '/models'];
  for (const known of knownSuffixes) {
    if (url.pathname.endsWith(known)) {
      url.pathname = url.pathname.slice(0, -known.length);
      break;
    }
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${suffix}`;
  return url.toString();
}

function providerErrorBody(value: string): string {
  try {
    const parsed = JSON.parse(value) as {
      error?: { message?: unknown; code?: unknown } | string;
      message?: unknown;
    };
    const error = parsed.error;
    const message = typeof error === 'string'
      ? error
      : typeof error?.message === 'string'
        ? error.message
        : typeof parsed.message === 'string'
          ? parsed.message
          : value;
    return String(message).replace(/\s+/g, ' ').trim().slice(0, 500);
  } catch {
    return value.replace(/\s+/g, ' ').trim().slice(0, 500);
  }
}

export async function probeProviderModels(
  endpoint: string,
  apiKey: string,
): Promise<DetectedModel[]> {
  const response = await fetch(providerApiUrl(endpoint, 'models'), {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw Error(`模型探测失败 (${response.status})`);
  const body = await response.json() as { data?: Array<Record<string, unknown>> };
  if (!Array.isArray(body.data)) throw Error('模型列表格式无效');
  return body.data.flatMap(item => typeof item?.id === 'string' && item.id.trim()
    ? [{
        model: item.id.trim(),
        name: typeof item.name === 'string' ? item.name : item.id.trim(),
        ...detectedModelMetadata(item.id.trim(), endpoint, item),
      }]
    : []);
}

async function probeGenerationRoute(
  endpoint: string,
  apiKey: string,
  protocol: ProviderWireApi,
): Promise<boolean> {
  const chat = protocol === 'chat_completions';
  const response = await fetch(providerApiUrl(endpoint, chat ? 'chat/completions' : 'responses'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: '{}',
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  await response.body?.cancel().catch(() => {});
  if ([404, 405, 501].includes(response.status)) return false;
  if (response.status === 401 || response.status === 403) {
    throw Object.assign(Error(`上游认证失败 (${response.status})`), { statusCode: 502 });
  }
  return response.ok || [400, 422].includes(response.status);
}

/** Verify both the model directory and a real generation route. */
export async function detectProviderProtocol(
  endpoint: string,
  apiKey: string,
): Promise<AgentProviderDetection> {
  const models = await probeProviderModels(endpoint, apiKey);
  if (!models.length) throw Error('Provider 未返回可用模型，无法确认接口模式');
  const routes = await Promise.allSettled([
    probeGenerationRoute(endpoint, apiKey, 'responses'),
    probeGenerationRoute(endpoint, apiKey, 'chat_completions'),
  ]);
  const rejected = routes.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (rejected.length === routes.length) {
    const error = rejected[0].reason;
    if (error && typeof error === 'object' && 'statusCode' in error) throw error;
    throw Object.assign(Error('无法连接 Provider 的生成接口'), { statusCode: 502 });
  }
  const responses = routes[0].status === 'fulfilled' && routes[0].value;
  const chatCompletions = routes[1].status === 'fulfilled' && routes[1].value;
  if (!responses && !chatCompletions) {
    throw Object.assign(
      Error('该地址提供模型列表，但 Responses 与 Chat Completions 生成接口均不可用'),
      { statusCode: 409 },
    );
  }
  return { protocol: responses ? 'responses' : 'chat_completions', models };
}
