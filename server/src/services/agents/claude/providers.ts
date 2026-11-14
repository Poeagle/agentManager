import { getDb } from '../../../db/index.js';
import {
  openAgentSecret,
  readAgentManagement,
  sealAgentSecret,
  updateAgentManagement,
  type StoredProvider,
} from '../management-store.js';
import type {
  AgentModelDetectionInput,
  AgentProviderInput,
  AgentProviderState,
} from '../types.js';
import { environmentUserOverride } from '../environment-access.js';
import { readManagedEnvironment, updateManagedEnvironment } from '../environment-store.js';

const ID_RE = /^[a-z][a-z0-9_.-]{0,63}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
const secretKey = (providerId: string) =>
  `agent_management_claude_provider_secret:${providerId}`;
const secretPurpose = (providerId: string) => `claude-provider:${providerId}`;
export const claudeEnvironmentName = (providerId: string) =>
  `claude-provider:${providerId}`;

export interface ClaudeProviderRuntime {
  id: string;
  name: string;
  baseUrl: string;
  authToken: string;
  models: string[];
  defaultModel: string | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
}

function stringField(
  provider: StoredProvider,
  key: string,
  fallback = '',
): string {
  return typeof provider.fields[key] === 'string'
    ? (provider.fields[key] as string)
    : fallback;
}

function modelField(provider: StoredProvider): string[] {
  const value = provider.fields.models;
  return Array.isArray(value)
    ? [
        ...new Set(
          value.filter(
            (model): model is string =>
              typeof model === 'string' && MODEL_RE.test(model.trim()),
          ),
        ),
      ]
    : [];
}

function configuredProviders(): StoredProvider[] {
  return readAgentManagement('claude').providers;
}

/** Native Anthropic uses the same encrypted provider store after migration. */
function nativeProviderState(): AgentProviderState {
  const stored=readAgentManagement('claude').providers.find(provider=>provider.id==='anthropic');
  if(stored)return claudeProviderState(stored);
  const env = readManagedEnvironment();
  const models = [
    ...new Set(
      [
        env.ANTHROPIC_MODEL,
        env.ANTHROPIC_DEFAULT_OPUS_MODEL,
        env.ANTHROPIC_DEFAULT_SONNET_MODEL,
        env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
        'default',
        'sonnet',
        'opus',
        'haiku',
      ].filter((model): model is string => typeof model === 'string' && !!model.trim()),
    ),
  ];
  const configured = !!env.ANTHROPIC_AUTH_TOKEN || !!env.ANTHROPIC_API_KEY;
  const baseUrl = env.ANTHROPIC_BASE_URL || '';
  return {
    id: 'anthropic',
    name: 'Anthropic',
    kind: 'official',
    enabled: true,
    managed: true,
    status: configured && baseUrl ? 'ready' : 'warning',
    statusText: configured && baseUrl ? '原生配置可切换' : configured ? '缺少 API 地址' : '缺少 API Key',
    authentication: { status: configured ? 'authenticated' : 'missing', method: 'ANTHROPIC_AUTH_TOKEN（原生配置）' },
    models,
    defaultModel: env.ANTHROPIC_MODEL || null,
    fields: [
      { key: 'baseUrl', label: 'API 地址', type: 'text', value: baseUrl, required: true, description: '此 Provider 的 Anthropic 兼容网关根地址。' },
      { key: 'envKey', label: 'API Key', type: 'password', value: '', configured, required: true, description: '保存后写回此 Provider 的配置；密钥不会回显。' },
      { key: 'models', label: '模型', type: 'string-list', value: models, required: true, description: '此 Provider 可用模型。' },
      { key: 'defaultModel', label: '默认模型', type: 'text', value: env.ANTHROPIC_MODEL || models[0] || '', description: '新建会话默认模型。' },
      { key: 'contextWindow', label: '上下文窗口', type: 'text', value: env.CLAUDE_CODE_MAX_CONTEXT_TOKENS || '', placeholder: '可选，例如 200000' },
      { key: 'maxOutputTokens', label: '最大输出 Token', type: 'text', value: env.CLAUDE_CODE_MAX_OUTPUT_TOKENS || '', placeholder: '可选' },
    ],
    configFiles: [],
  };
}

function providerOrThrow(providerId: string): StoredProvider {
  const provider = configuredProviders().find((item) => item.id === providerId);
  if (!provider)
    throw Object.assign(Error('Claude Provider 不存在'), {
      statusCode: 404,
    });
  return provider;
}

export function claudeProviderApiKey(providerId: string): string {
  const row = getDb()
    .prepare('SELECT value FROM settings WHERE key=?')
    .get(secretKey(providerId)) as { value: string } | undefined;
  return row?.value
    ? openAgentSecret(row.value, secretPurpose(providerId))
    : '';
}

export function nativeClaudeProviderState(): AgentProviderState {
  return nativeProviderState();
}

export function nativeClaudeProviderApiKey(): string {
  return claudeProviderApiKey('anthropic')
    || readManagedEnvironment().ANTHROPIC_AUTH_TOKEN
    || readManagedEnvironment().ANTHROPIC_API_KEY
    || '';
}

/** Materialize an unmigrated native environment without changing it. This lets
 * old sessions and every new native session use the same resolved provider. */
export function ensureNativeClaudeProvider(): void {
  if(readAgentManagement('claude').providers.some(provider=>provider.id==='anthropic'))return;
  const env=readManagedEnvironment();
  const models=[...new Set([
    env.ANTHROPIC_MODEL,
    env.ANTHROPIC_DEFAULT_OPUS_MODEL,
    env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    'default','sonnet','opus','haiku',
  ].filter((model):model is string=>typeof model==='string'&&!!model.trim()))];
  const baseUrl=env.ANTHROPIC_BASE_URL;
  const apiKey=env.ANTHROPIC_AUTH_TOKEN||env.ANTHROPIC_API_KEY;
  if(!baseUrl||!models.length||!apiKey)return;
  const fields=validateFields({baseUrl,models,defaultModel:env.ANTHROPIC_MODEL||models[0]});
  updateAgentManagement('claude',current=>({
    ...current,
    providers:[...current.providers.filter(provider=>provider.id!=='anthropic'),{id:'anthropic',name:'Anthropic',kind:'official',enabled:true,fields}],
  }));
  saveProviderApiKey('anthropic',apiKey);
}

export function updateNativeClaudeProvider(input: AgentProviderInput): void {
  const env = readManagedEnvironment();
  const models = Array.isArray(input.fields?.models)
    ? (input.fields!.models as unknown[]).filter(
        (model): model is string =>
          typeof model === 'string' && MODEL_RE.test(model.trim()),
      )
    : [];
  const baseUrl =
    typeof input.fields?.baseUrl === 'string'
      ? validEndpoint(input.fields.baseUrl)
      : env.ANTHROPIC_BASE_URL || '';
  const defaultModel =
    typeof input.fields?.defaultModel === 'string'
      ? input.fields.defaultModel.trim()
      : env.ANTHROPIC_MODEL || models[0] || '';
  if (!baseUrl) throw Object.assign(Error('请填写 API 地址'), { statusCode: 400 });
  if (!models.length) throw Object.assign(Error('至少选择一个 Claude 模型'), { statusCode: 400 });
  if (defaultModel && !models.includes(defaultModel))
    throw Object.assign(Error('默认模型必须来自已选模型'), { statusCode: 400 });
  const contextWindow =
    typeof input.fields?.contextWindow === 'string'
      ? input.fields.contextWindow.trim()
      : env.CLAUDE_CODE_MAX_CONTEXT_TOKENS || '';
  const maxOutputTokens =
    typeof input.fields?.maxOutputTokens === 'string'
      ? input.fields.maxOutputTokens.trim()
      : env.CLAUDE_CODE_MAX_OUTPUT_TOKENS || '';
  boundedNumber(contextWindow, '上下文窗口', 1, 10_000_000);
  boundedNumber(maxOutputTokens, '最大输出 Token', 1, 10_000_000);
  updateAgentManagement('claude',(current)=>({
    ...current,
    providers:[
      ...current.providers.filter(provider=>provider.id!=='anthropic'),
      {
        id:'anthropic',name:'Anthropic',kind:'official',enabled:true,
        fields:validateFields({baseUrl,models,defaultModel,contextWindow,maxOutputTokens}),
      },
    ],
  }));
  saveProviderApiKey('anthropic',input.apiKey);
}

function saveProviderApiKey(providerId: string, apiKey?: string): void {
  if (apiKey === undefined) return;
  const sealed = apiKey.trim()
    ? sealAgentSecret(apiKey.trim(), secretPurpose(providerId))
    : '';
  getDb()
    .prepare(
      'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    )
    .run(secretKey(providerId), sealed);
}

function deleteProviderSecret(providerId: string): void {
  getDb().prepare('DELETE FROM settings WHERE key=?').run(secretKey(providerId));
}

function validEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw Object.assign(Error('Provider 地址无效'), { statusCode: 400 });
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw Object.assign(Error('Provider 地址必须是 HTTP(S) URL，且不能包含凭据'), {
      statusCode: 400,
    });
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

function boundedNumber(
  value: string | boolean | string[] | null | undefined,
  label: string,
  minimum: number,
  maximum: number,
): number | null {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum)
    throw Object.assign(Error(`${label}必须在 ${minimum}–${maximum} 之间`), {
      statusCode: 400,
    });
  return number;
}

function validateFields(
  fields: AgentProviderInput['fields'],
  current?: StoredProvider,
): StoredProvider['fields'] {
  const next = { ...(current?.fields || {}), ...(fields || {}) };
  if (fields?.baseUrl !== undefined || !current) {
    if (typeof fields?.baseUrl !== 'string')
      throw Object.assign(Error('请填写 Provider 地址'), { statusCode: 400 });
    next.baseUrl = validEndpoint(fields.baseUrl);
  }
  if (fields?.models !== undefined) {
    if (
      !Array.isArray(fields.models) ||
      !fields.models.length ||
      fields.models.length > 256
    )
      throw Object.assign(Error('至少选择一个 Claude 模型'), {
        statusCode: 400,
      });
    next.models = [
      ...new Set(
        fields.models.map((model) => {
          if (typeof model !== 'string' || !MODEL_RE.test(model.trim()))
            throw Object.assign(Error('模型 ID 无效'), { statusCode: 400 });
          return model.trim();
        }),
      ),
    ];
  }
  if (fields?.defaultModel !== undefined) {
    const model =
      typeof fields.defaultModel === 'string' ? fields.defaultModel.trim() : '';
    if (
      model &&
      !((next.models as string[] | undefined) || []).includes(model)
    )
      throw Object.assign(Error('默认模型必须来自已选模型'), {
        statusCode: 400,
      });
    next.defaultModel = model;
  }
  for (const [key, label] of [
    ['contextWindow', '上下文窗口'],
    ['maxOutputTokens', '最大输出 Token'],
  ] as const) {
    if (fields?.[key] !== undefined) {
      boundedNumber(fields[key], label, 1, 10_000_000);
      next[key] = fields[key] as string;
    }
  }
  return next;
}

export function enabledClaudeProviders(): AgentProviderState[] {
  ensureNativeClaudeProvider();
  const stored=configuredProviders();
  return [stored.some(provider=>provider.id==='anthropic')?claudeProviderState(stored.find(provider=>provider.id==='anthropic')!):nativeProviderState(), ...stored
    .filter(provider=>provider.id!=='anthropic')
    .filter((provider) => provider.enabled)
    .map((provider) => claudeProviderState(provider))];
}

export function claudeProviderState(
  provider: StoredProvider,
  options: { resolveSecret?: boolean } = {},
): AgentProviderState {
  const models = modelField(provider);
  const configured = !!(
    options.resolveSecret
      ? claudeProviderApiKey(provider.id)
      : getDb()
          .prepare('SELECT 1 FROM settings WHERE key=? AND length(value)>0')
          .get(secretKey(provider.id))
  );
  const address = stringField(provider, 'baseUrl');
  return {
    id: provider.id,
    name: provider.name,
    kind: provider.kind || 'anthropic-compatible',
    enabled: provider.enabled,
    managed: true,
    status: provider.enabled && configured && address ? 'ready' : provider.enabled ? 'warning' : 'unavailable',
    statusText: !provider.enabled
      ? '已停用'
      : !configured
        ? '缺少 API Key'
        : !address
          ? '缺少 API 地址'
          : '可安全注入独立 SDK 会话',
    authentication: {
      status: configured ? 'authenticated' : 'missing',
      method: 'ANTHROPIC_AUTH_TOKEN（加密存储）',
    },
    models,
    defaultModel:
      stringField(provider, 'defaultModel') || models[0] || null,
    fields: [
      {
        key: 'baseUrl',
        label: 'API 地址',
        type: 'text',
        value: address,
        required: true,
        description: 'Claude Code 请求使用的 Anthropic 兼容网关地址。',
      },
      {
        key: 'envKey',
        label: 'API Key',
        type: 'password',
        value: '',
        configured,
        required: true,
        description: '加密保存，仅注入绑定此 Provider 的 SDK 会话。',
      },
      {
        key: 'models',
        label: '模型',
        type: 'string-list',
        value: models,
        required: true,
        description: '可通过网关使用、并会在会话模型选择中出现的模型 ID。',
      },
      {
        key: 'defaultModel',
        label: '默认模型',
        type: 'text',
        value: stringField(provider, 'defaultModel') || models[0] || '',
        description: '新建会话默认使用的模型。',
      },
      {
        key: 'contextWindow',
        label: '上下文窗口',
        type: 'text',
        value: stringField(provider, 'contextWindow'),
        placeholder: '可选，例如 200000',
        description: '可选。通过 CLAUDE_CODE_MAX_CONTEXT_TOKENS 传给该 Provider 的会话。',
      },
      {
        key: 'maxOutputTokens',
        label: '最大输出 Token',
        type: 'text',
        value: stringField(provider, 'maxOutputTokens'),
        placeholder: '可选',
        description: '可选。通过 CLAUDE_CODE_MAX_OUTPUT_TOKENS 传给该 Provider 的会话。',
      },
    ],
    configFiles: [],
  };
}

export function createClaudeProvider(
  input: AgentProviderInput,
): void {
  const id = input.id?.trim() || '';
  if (!ID_RE.test(id))
    throw Object.assign(Error('Provider ID 无效'), { statusCode: 400 });
  if (id === 'anthropic' || id === 'native')
    throw Object.assign(Error('Provider ID 与保留环境冲突'), { statusCode: 400 });
  const current = readAgentManagement('claude');
  if (current.providers.some((provider) => provider.id === id))
    throw Object.assign(Error('Provider 已存在'), { statusCode: 409 });
  const fields = validateFields(input.fields);
  if (!input.apiKey?.trim())
    throw Object.assign(Error('请填写 API Key'), { statusCode: 400 });
  updateAgentManagement('claude', (value) => ({
    ...value,
    providers: [
      ...value.providers,
      {
        id,
        name: input.name?.trim() || id,
        kind: input.kind?.trim() || 'anthropic-compatible',
        enabled: input.enabled !== false,
        fields,
      },
    ],
  }));
  try {
    saveProviderApiKey(id, input.apiKey);
  } catch (error) {
    updateAgentManagement('claude', (value) => ({
      ...value,
      providers: value.providers.filter((provider) => provider.id !== id),
    }));
    throw error;
  }
}

export function updateClaudeProvider(
  providerId: string,
  input: AgentProviderInput,
): void {
  const current = providerOrThrow(providerId);
  const fields = validateFields(input.fields, current);
  if (
    typeof fields.baseUrl !== 'string' ||
    !Array.isArray(fields.models)
  )
    throw Object.assign(Error('Provider 配置不完整'), { statusCode: 400 });
  updateAgentManagement('claude', (value) => ({
    ...value,
    providers: value.providers.map((provider) =>
      provider.id === providerId
        ? {
            ...provider,
            name: input.name?.trim() || provider.name,
            kind: input.kind?.trim() || provider.kind,
            enabled: input.enabled ?? provider.enabled,
            fields,
          }
        : provider,
    ),
  }));
  saveProviderApiKey(providerId, input.apiKey);
}

export function deleteClaudeProvider(providerId: string): void {
  providerOrThrow(providerId);
  const active = getDb()
    .prepare(
      "SELECT 1 FROM sessions WHERE agent_environment_id=? AND status IN ('running','detached') LIMIT 1",
    )
    .get(`claude-provider:${providerId}`);
  if (active)
    throw Object.assign(Error('仍有运行中的 Claude 会话绑定此 Provider'), {
      statusCode: 409,
    });
  updateAgentManagement('claude', (value) => ({
    ...value,
    providers: value.providers.filter((provider) => provider.id !== providerId),
  }));
  deleteProviderSecret(providerId);
}

export function toggleClaudeProvider(
  providerId: string,
  enabled: boolean,
): void {
  providerOrThrow(providerId);
  updateAgentManagement('claude', (value) => ({
    ...value,
    providers: value.providers.map((provider) =>
      provider.id === providerId ? { ...provider, enabled } : provider,
    ),
  }));
}

export function claudeProviderIdForSession(
  session: { agent_environment_id?: string | null },
): string | null {
  const id = session.agent_environment_id || '';
  if(id==='claude-provider:anthropic')return 'anthropic';
  return id.startsWith('claude-provider:') ? id.slice(16) : null;
}

export function canUseClaudeEnvironment(
  environmentId: string,
  userId: string,
): boolean {
  const admin =
    (getDb()
      .prepare('SELECT role FROM users WHERE id=? AND disabled=0')
      .get(userId) as { role?: string } | undefined)?.role === 'admin';
  if (!environmentId) return admin;
  const providerId = environmentId.startsWith('claude-provider:')
    ? environmentId.slice(16)
    : '';
  const provider = configuredProviders().find(
    (item) => item.id === providerId,
  );
  if (!provider) return false;
  if (admin) return true;
  if (!provider.enabled) return false;
  const override = environmentUserOverride(environmentId, userId);
  return override === null ? true : override;
}

export function canControlClaudeEnvironment(
  environmentId: string,
  userId: string,
): boolean {
  if (!canUseClaudeEnvironment(environmentId, userId)) return false;
  if (!environmentId) return true;
  const override = environmentUserOverride(environmentId, userId);
  if (override !== null) return override;
  return (
    (getDb()
      .prepare('SELECT role FROM users WHERE id=?')
      .get(userId) as { role?: string } | undefined)?.role === 'admin'
  );
}

export function claudeRuntimeProvider(
  session: { agent_environment_id?: string | null },
  environmentAccess?: (environmentId: string) => boolean,
): ClaudeProviderRuntime | null {
  ensureNativeClaudeProvider();
  const providerId = claudeProviderIdForSession(session);
  if (!providerId) return null;
  if (environmentAccess && !environmentAccess(`claude-provider:${providerId}`))
    return null;
  const provider = configuredProviders().find(
    (item) => item.id === providerId && item.enabled,
  );
  if (!provider)
    throw Object.assign(Error('Claude Provider 不存在或已停用'), {
      statusCode: 409,
    });
  const authToken = providerId==='anthropic'
    ? nativeClaudeProviderApiKey()
    : claudeProviderApiKey(providerId);
  const baseUrl = stringField(provider, 'baseUrl');
  if (!authToken || !baseUrl)
    throw Object.assign(Error('Claude Provider 缺少 API 地址或密钥'), {
      statusCode: 409,
    });
  const models = modelField(provider);
  const requested = stringField(provider, 'defaultModel');
  return {
    id: provider.id,
    name: provider.name,
    baseUrl,
    authToken,
    models,
    defaultModel: models.includes(requested) ? requested : models[0] || null,
    contextWindow: boundedNumber(
      provider.fields.contextWindow,
      '上下文窗口',
      1,
      10_000_000,
    ),
    maxOutputTokens: boundedNumber(
      provider.fields.maxOutputTokens,
      '最大输出 Token',
      1,
      10_000_000,
    ),
  };
}

export function claudeNativeRuntimeProvider(
  environmentAccess?: (environmentId: string) => boolean,
): ClaudeProviderRuntime | null {
  ensureNativeClaudeProvider();
  const stored=readAgentManagement('claude').providers.find(provider=>provider.id==='anthropic');
  if(stored)return claudeRuntimeProvider({agent_environment_id:'claude-provider:anthropic'},environmentAccess);
  return null;
}

export function claudeProviderForEnvironment(
  environmentId: string,
): ClaudeProviderRuntime | null {
  if (environmentId === 'anthropic') return null;
  if (!environmentId.startsWith('claude-provider:'))
    throw Object.assign(Error('不是 Claude Provider 环境'), {
      statusCode: 400,
    });
  return claudeRuntimeProvider({ agent_environment_id: environmentId });
}

/** Read the bound provider without materializing credentials for status routes. */
export function claudeProviderChoiceForEnvironment(
  environmentId: string,
): {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
  defaultModel: string | null;
  contextWindow: number | null;
} | null {
  if (environmentId === 'anthropic') return null;
  const providerId = environmentId.startsWith('claude-provider:')
    ? environmentId.slice(16)
    : '';
  const provider = configuredProviders().find(
    (item) => item.id === providerId,
  );
  if (!provider)
    throw Object.assign(Error('Claude Provider 不存在或已停用'), {
      statusCode: 404,
    });
  const models = modelField(provider);
  const requested = stringField(provider, 'defaultModel');
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: stringField(provider, 'baseUrl'),
    models,
    defaultModel: models.includes(requested) ? requested : models[0] || null,
    contextWindow: boundedNumber(
      provider.fields.contextWindow,
      '上下文窗口',
      1,
      10_000_000,
    ),
  };
}

export function claudeManagementProviderState(
  providerId: string,
): AgentProviderState | null {
  const provider = configuredProviders().find((item) => item.id === providerId);
  return provider ? claudeProviderState(provider) : null;
}

export function claudeProviderEnvironment(
  provider: ClaudeProviderRuntime | null,
  model?: string,
): Record<string, string> | undefined {
  if (!provider) return undefined;
  return {
    ANTHROPIC_BASE_URL: provider.baseUrl,
    ANTHROPIC_AUTH_TOKEN: provider.authToken,
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_MODEL: model || provider.defaultModel || '',
    ...(provider.contextWindow
      ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(provider.contextWindow) }
      : {}),
    ...(provider.maxOutputTokens
      ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(provider.maxOutputTokens) }
      : {}),
  };
}

export function claudeProviderModelChoices(
  session: { agent_environment_id?: string | null },
) {
  return claudeProviderModels(session).map((model) => ({
    provider:
      claudeRuntimeProvider(session)?.id || "anthropic",
    model,
    name: model,
    description: "Claude 兼容网关模型",
    efforts: [{ value: "", description: "由原生客户端决定" }],
    defaultEffort: "",
  }));
}

export function claudeProviderModels(
  session: { agent_environment_id?: string | null },
  environmentAccess?: (environmentId: string) => boolean,
): string[] {
  return claudeRuntimeProvider(session, environmentAccess)?.models || [];
}

export async function detectClaudeProviderModels(
  input: AgentModelDetectionInput,
): Promise<Array<{ model: string; name: string; description?: string }>> {
  let endpoint = input.endpoint || '';
  let apiKey = input.apiKey || '';
  if (input.providerId) {
    const provider = providerOrThrow(input.providerId);
    endpoint ||= stringField(provider, 'baseUrl');
    apiKey ||= claudeProviderApiKey(provider.id);
  }
  endpoint = validEndpoint(endpoint);
  if (!apiKey.trim())
    throw Object.assign(Error('请先填写 API Key'), { statusCode: 400 });
  const response = await fetch(`${endpoint}/models`, {
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
      'x-api-key': apiKey.trim(),
      'anthropic-version': '2023-06-01',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok)
    throw Object.assign(Error(`模型探测失败 (${response.status})`), {
      statusCode: 502,
    });
  const body = (await response.json()) as {
    data?: Array<{ id?: unknown; display_name?: unknown; name?: unknown }>;
  };
  if (!Array.isArray(body.data))
    throw Object.assign(Error('模型列表格式无效'), { statusCode: 502 });
  return body.data.flatMap((item) => {
    if (typeof item?.id !== 'string' || !MODEL_RE.test(item.id.trim()))
      return [];
    const model = item.id.trim();
    const name =
      typeof item.display_name === 'string'
        ? item.display_name
        : typeof item.name === 'string'
          ? item.name
          : model;
    return [{ model, name, description: '由 Claude 兼容网关返回' }];
  });
}
