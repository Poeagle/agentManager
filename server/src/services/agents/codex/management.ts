import { existsSync, mkdirSync, unlinkSync } from 'fs';
import { readFile, rm, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { spawn, spawnSync } from 'child_process';
import WebSocket from 'ws';
import { getDb } from '../../../db/index.js';
import { config } from '../../../config.js';
import type {
  AgentDescriptor,
  AgentManagementPort,
  AgentManagementState,
  AgentProviderInput,
  AgentProviderState,
  AgentModelConfig,
  AgentModelConfigUpdate,
  AgentOperationReporter,
} from '../types.js';
import { findExecutable, firstVersion, runCli } from '../management-cli.js';
import { expandHome } from '../management-common.js';
import { managedLaunchCommand, openAgentSecret, readAgentManagement, sealAgentSecret, updateAgentManagement, writeAgentManagement, type StoredProvider } from '../management-store.js';
import { configuredCodexEngines } from './engine-context.js';
import { clearManagedCodexRuntimeSocket, managedCodexSocket, managedCodexRuntimeSocket, setManagedCodexRuntimeSocket } from './provider-config.js';
import {
  disableLegacyCodexLaunchAgents,
  ensureNativeCodexEngine,
  inspectNativeCodexEngine,
  nativeEngineLaunchDescription,
  restartNativeCodexEngine,
  stopNativeCodexEngine,
} from './native-engine.js';
import { nativeEngineConfig, updateNativeEngineConfig } from './native-engine-config.js';
import { displayEngineCommand, normalizeEngineArgs, normalizeEngineCommand } from './engine-command.js';

const processes = new Map<string, { pid: number; startedAt: string }>();
const startupErrors = new Map<string, string>();
let bundledModelTemplate: Promise<Record<string, unknown> | null> | undefined;
const configPath = () => join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml');
const validId = (id: string) => /^[a-z][a-z0-9_.-]{0,63}$/.test(id);
const stringField = (provider: StoredProvider, key: string, fallback = '') =>
  typeof provider.fields[key] === 'string' ? provider.fields[key] as string : fallback;
const listField = (provider: StoredProvider, key: string) =>
  Array.isArray(provider.fields[key]) ? (provider.fields[key] as unknown[]).filter((value): value is string => typeof value === 'string') : [];
const secretKeyName = (providerId: string) => `agent_management_codex_provider_secret:${providerId}`;
const secretPurpose = (providerId: string) => `codex-provider:${providerId}`;

/** Codex requires every catalog model to carry its agent instructions. Reuse
 * the installed CLI's bundled template so custom Providers remain compatible
 * as Codex evolves, instead of pinning a thousands-line prompt in this repo. */
function loadBundledModelTemplate(): Promise<Record<string, unknown> | null> {
  bundledModelTemplate ||= (async () => {
    const executable = await findExecutable('codex');
    if (!executable) return null;
    const result = await runCli(executable, ['debug', 'models', '--bundled'], { timeout: 15_000 });
    if (!result.ok) return null;
    try {
      const parsed = JSON.parse(result.stdout) as { models?: unknown };
      if (!Array.isArray(parsed.models)) return null;
      return parsed.models.find(item => item && typeof item === 'object'
        && typeof (item as Record<string, unknown>).model_messages === 'object') as Record<string, unknown> | undefined || null;
    } catch { return null; }
  })();
  return bundledModelTemplate;
}

async function catalogInstructions(): Promise<Record<string, unknown>> {
  const template = await loadBundledModelTemplate();
  const base = typeof template?.base_instructions === 'string' ? template.base_instructions : null;
  const messages = template?.model_messages && typeof template.model_messages === 'object'
    ? template.model_messages as Record<string, unknown> : null;
  if (!base && !messages?.instructions_template) {
    throw Object.assign(Error('当前 Codex CLI 未提供模型指令模板，无法生成有效的模型目录'), { statusCode: 409 });
  }
  return {
    ...(base ? { base_instructions: base } : {}),
    ...(messages?.instructions_template ? {
      model_messages: {
        instructions_template: messages.instructions_template,
        ...(messages.instructions_variables && typeof messages.instructions_variables === 'object'
          ? { instructions_variables: messages.instructions_variables } : {}),
        approvals: null,
        auto_review: null,
        permissions: null,
      },
    } : {}),
    include_skills_usage_instructions: false,
    default_reasoning_summary: 'none',
    apply_patch_tool_type: 'freeform',
    web_search_tool_type: 'text_and_image',
    supports_parallel_tool_calls: true,
  };
}

function providerApiKey(providerId: string): string {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(secretKeyName(providerId)) as {value:string}|undefined;
  return row?.value ? openAgentSecret(row.value, secretPurpose(providerId)) : '';
}

function catalogPathFromConfig(config: string): string | null {
  return config.match(/^\s*model_catalog_json\s*=\s*"([^"]+)"/m)?.[1] || null;
}

async function providerCatalogPath(providerId: string): Promise<{path:string;content:string}|null> {
  if (providerId === 'native') {
    const config = existsSync(configPath()) ? await readFile(configPath(), 'utf8') : '';
    const path = catalogPathFromConfig(config);
    if (path) return { path, content: await readFile(path, 'utf8') };
    return null;
  }
  const provider = readAgentManagement('codex').providers.find(item => item.id === providerId);
  if (!provider) return null;
  const configFile = join(providerCodexHome(provider), 'config.toml');
  const config = existsSync(configFile) ? await readFile(configFile, 'utf8') : '';
  const configuredPath = catalogPathFromConfig(config);
  const path = configuredPath || join(providerCodexHome(provider), 'model-catalog.json');
  if (!existsSync(path)) return null;
  return { path, content: await readFile(path, 'utf8') };
}

function modelConfigsFromCatalog(content: string, sourceFile: string, provider?: string): AgentModelConfig[] {
  const catalog = JSON.parse(content) as { models?: Array<Record<string, unknown>> };
  return (catalog.models || []).flatMap(item => {
    if (typeof item.slug !== 'string') return [];
    const input = Array.isArray(item.input_modalities) ? item.input_modalities.filter((value): value is string => typeof value === 'string') : ['text'];
    return [{
      ...(provider ? { provider } : {}), model: item.slug,
      name: typeof item.display_name === 'string' ? item.display_name : item.slug,
      contextWindow: typeof item.context_window === 'number' ? item.context_window : null,
      maxContextWindow: typeof item.max_context_window === 'number' ? item.max_context_window : null,
      effectiveContextWindowPercent: typeof item.effective_context_window_percent === 'number' ? item.effective_context_window_percent : null,
      inputModalities: input,
      supportsImages: input.includes('image'),
      sourceFile,
    }];
  });
}

async function readModelConfigsForProvider(providerId: string): Promise<AgentModelConfig[]> {
  const target = await providerCatalogPath(providerId);
  return target ? modelConfigsFromCatalog(target.content, target.path, providerId === 'native' ? 'wanzhao' : providerId) : [];
}

async function updateModelConfigsForProvider(providerId: string, updates: AgentModelConfigUpdate[]): Promise<AgentModelConfig[]> {
  const target = await providerCatalogPath(providerId);
  if (!target) throw Object.assign(Error('该 Provider 没有可读取的模型目录'), { statusCode: 409 });
  const catalog = JSON.parse(target.content) as { models?: Array<Record<string, unknown>> };
  const updateMap = new Map(updates.map(update => [update.model, update]));
  catalog.models = (catalog.models || []).map(item => {
    if (typeof item.slug !== 'string') return item;
    const update = updateMap.get(item.slug);
    if (!update) return item;
    const next = { ...item };
    for (const key of ['contextWindow', 'maxContextWindow', 'effectiveContextWindowPercent'] as const) {
      const value = update[key];
      const catalogKey = key === 'contextWindow' ? 'context_window' : key === 'maxContextWindow' ? 'max_context_window' : 'effective_context_window_percent';
      if (value !== undefined) next[catalogKey] = value;
    }
    if (update.supportsImages !== undefined) {
      const modalities = Array.isArray(next.input_modalities) ? next.input_modalities.filter((value): value is string => typeof value === 'string' && value !== 'image') : ['text'];
      next.input_modalities = update.supportsImages ? [...new Set([...modalities, 'image'])] : modalities;
    }
    return next;
  });
  await writeFile(target.path, JSON.stringify(catalog, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  return modelConfigsFromCatalog(JSON.stringify(catalog), target.path, providerId === 'native' ? 'wanzhao' : providerId);
}

function saveProviderApiKey(providerId: string, apiKey?: string): void {
  if (apiKey === undefined) return;
  const sealed = apiKey.trim() ? sealAgentSecret(apiKey.trim(), secretPurpose(providerId)) : '';
  getDb().prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(secretKeyName(providerId), sealed);
}

async function externalProviders(): Promise<AgentProviderState[]> {
  const stored = readAgentManagement('codex');
  const routes = configuredCodexEngines();
  const known = new Set(stored.providers.map(provider => provider.id));
  const discovered: StoredProvider[] = [];
  await Promise.all(stored.providers.map(provider => ensureManagedProviderCatalog(provider).catch(() => {})));
  for (const engine of routes.filter(item => item.provider && !known.has(item.provider))) {
    const provider = {
      id: engine.provider!, name: engine.provider!, kind: 'responses', enabled: true,
      fields: { baseUrl: '', envKey: '', codexHome: process.env.CODEX_HOME || join(homedir(), '.codex'), models: engine.models || [], defaultModel: engine.models?.[0] || '' },
    };
    discovered.push(provider); known.add(provider.id);
  }
  if (discovered.length) writeAgentManagement('codex', { ...stored, providers: [...stored.providers, ...discovered] });
  return Promise.all(stored.providers.flatMap(provider => {
    const engine = routes.find(item => item.provider === provider.id);
    if (!engine) return [];
    return [socketPid(engine.socket).then(pid => {
      const recovered = recoverRuntimeProviderState(provider.id);
      if (recovered) return {
        ...managedProviderState(provider), socket: recovered.socket, pid: recovered.pid,
        status: 'ready' as const, statusText: `独立 Engine 运行中 · PID ${recovered.pid}`,
      };
      return {
        ...managedProviderState(provider), socket: engine.socket, pid,
        status: pid ? 'ready' as const : 'warning' as const,
        statusText: pid ? `独立 Engine 运行中 · PID ${pid}` : '独立 Engine 已配置，等待启动',
      };
    })];
  }));
}

function recoverRuntimeProviderState(providerId: string): { pid: number; socket: string } | null {
  const result = spawnSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' });
  const line = (result.stdout || '').split('\n').find(item => item.includes('codex app-server')
    && (item.includes(`model_providers.${providerId}.`) || item.includes(`model_provider="${providerId}"`)));
  if (!line) return null;
  const pid = Number(line.trim().split(/\s+/, 1)[0]);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const socket = discoverProviderSocket(pid);
  if (!socket) return null;
  processes.set(providerId, { pid, startedAt: new Date().toISOString() });
  setManagedCodexRuntimeSocket(providerId, socket);
  return { pid, socket };
}

async function socketPid(socket: string): Promise<number | null> {
  if (!existsSync(socket)) return null;
  try {
    const { stdout } = await new Promise<{stdout:string}>((resolve, reject) => {
      const child = spawn('lsof', ['-nP', '-Fp', socket], { stdio: ['ignore', 'pipe', 'ignore'] });
      let output = '';
      child.stdout?.on('data', chunk => { output += String(chunk); });
      child.once('error', reject);
      child.once('close', () => resolve({stdout:output}));
    });
    const match = stdout.match(/^p(\d+)$/m);
    if (match) return Number(match[1]);
  } catch { return null; }
  return null;
}

/** Resolve a persisted provider back to its configured engine route. */
function engineForStoredProvider(providerId: string) {
  return configuredCodexEngines().find(engine => engine.provider === providerId);
}

function nativeProviders(): AgentProviderState[] {
  const engine = inspectNativeCodexEngine();
  const codexHome = join(dirname(configPath()));
  const launchConfig = nativeEngineConfig();
  const launch = nativeEngineLaunchDescription();
  return [{
    id: 'native',
    name: 'OpenAI / Codex 原生',
    kind: 'native',
    enabled: true,
    managed: true,
    status: engine.status,
    statusText: engine.statusText,
    authentication: { status: existsSync(join(codexHome, 'auth.json')) ? 'authenticated' : 'unknown', method: 'Codex 登录或原生 Provider' },
    models: [],
    defaultModel: null,
    socket: engine.socket,
    pid: engine.pid,
    codexHome,
    launchCommand: displayEngineCommand(launch.command, launch.args),
    launchArgs: launch.args,
    configFiles: ['config.toml', 'models_cache.json', 'models.json', 'model-catalog.json', 'model-catalog-all.json',
      'model-catalog-grok-4.6.json', 'auth.json', '.codex-global-state.json', 'history.jsonl']
      .map(name => ({
        path: join(codexHome, name),
        exists: existsSync(join(codexHome, name)),
        format: name.endsWith('.toml') ? 'TOML' : name.endsWith('.jsonl') ? 'JSONL' : 'JSON',
        description: name === 'config.toml' ? 'Codex 原生配置' : name === 'auth.json' ? 'Codex 原生凭据'
          : name === 'history.jsonl' ? 'Codex 历史索引' : name.includes('model') ? 'Codex 模型配置' : 'Codex 全局状态',
        purpose: name === 'config.toml' ? '控制默认 Provider、默认模型、登录方式和 Codex 运行行为。'
          : name === 'auth.json' ? '保存登录令牌与认证信息；只读展示存在状态，避免泄露凭据。'
          : name === 'history.jsonl' ? 'Codex 原生输入历史索引，可能包含提示词；不是当前会话记录。'
          : name === 'models_cache.json' ? 'Codex 发现模型的本地缓存，用于模型列表和能力读取。'
          : name === '.codex-global-state.json' ? 'Codex 的全局界面与运行状态，不决定 Provider 认证。'
          : '定义模型名称、上下文长度、推理强度和输入模态能力。',
        writable: !['auth.json'].includes(name),
        ...(name === 'auth.json' ? { sensitive: true } : {}),
      })),
    fields: [
      {
        key: 'command',
        label: '启动命令',
        type: 'text',
        value: launchConfig.command,
        required: true,
        description: '作为无 shell 的可执行文件路径或 PATH 中的命令名启动。',
      },
      {
        key: 'launchArgs',
        label: '附加启动参数',
        type: 'string-list',
        value: launchConfig.extraArgs,
        description: '每行一个 argv；追加到 AgentManager 生成的基础 app-server 参数之后，重启 Engine 后生效。',
      },
    ],
  }];
}

function providerLaunch(provider: StoredProvider): { command: string; args: string[] } {
  const socket = managedCodexSocket(provider.id);
  const defaultModel = stringField(provider, 'defaultModel') || listField(provider, 'models')[0];
  const envKey = 'AGENTMANAGER_PROVIDER_API_KEY';
  const base = [
    'app-server', '--listen', `unix://${socket}`,
    '-c', `model_provider=${JSON.stringify(provider.id)}`,
    '-c', `model_providers.${provider.id}.name=${JSON.stringify(provider.name)}`,
    '-c', `model_providers.${provider.id}.base_url=${JSON.stringify(stringField(provider, 'baseUrl'))}`,
    '-c', `model_providers.${provider.id}.wire_api="responses"`,
    '-c', `model_providers.${provider.id}.env_key=${JSON.stringify(envKey)}`,
    ...(defaultModel ? ['-c', `model=${JSON.stringify(defaultModel)}`] : []),
  ];
  return {
    command: normalizeEngineCommand(provider.fields.command, 'codex'),
    args: [...base, ...normalizeEngineArgs(provider.fields.launchArgs)],
  };
}

function managedProviderState(provider: StoredProvider): AgentProviderState {
  const processInfo = processes.get(provider.id) || (() => { recoverRuntimeProviderState(provider.id); return processes.get(provider.id); })();
  const socket = managedCodexRuntimeSocket(provider.id) || managedCodexSocket(provider.id);
  const envKey = stringField(provider, 'envKey');
  const codexHome = externalProviderCodexHome(provider);
  const storedApiKey = providerApiKey(provider.id);
  const environmentApiKey = envKey && process.env[envKey] ? `环境变量 ${envKey}` : '';
  const effectiveApiKey = storedApiKey || environmentApiKey;
  const running = !!processInfo;
  const startupError = startupErrors.get(provider.id);
  const launch = providerLaunch(provider);
  return {
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    enabled: provider.enabled,
    managed: true,
    status: !provider.enabled ? 'unavailable' : startupError ? 'error' : running ? 'ready' : 'warning',
    statusText: !provider.enabled ? '已停用' : startupError ? `启动失败：${startupError}` : running
      ? `Engine 运行中 · PID ${processInfo.pid}`
      : '已启用，Engine 尚未运行',
    authentication: {
      status: effectiveApiKey ? 'authenticated' : 'missing',
      method: storedApiKey ? '加密 API Key' : environmentApiKey || '缺少认证',
    },
    models: listField(provider, 'models'),
    defaultModel: stringField(provider, 'defaultModel') || null,
    codexHome,
    authenticationConfigured: !!storedApiKey,
    socket,
    pid: processInfo?.pid ?? null,
    launchCommand: displayEngineCommand(launch.command, launch.args),
    launchArgs: launch.args,
    configFiles: [
      { path: join(codexHome, 'config.toml'), exists: existsSync(join(codexHome, 'config.toml')), format: 'TOML', description: 'Provider Engine 启动配置', writable: true, purpose: '决定该 Provider 的 API 地址、默认模型、API Key 环境变量和 CODEX_HOME。' },
      { path: join(codexHome, 'model-catalog.json'), exists: existsSync(join(codexHome, 'model-catalog.json')), format: 'JSON', description: '可选模型目录与能力声明', writable: true, purpose: '定义模型上下文长度、有效比例、图片输入等能力，并供模型选择使用。' },
      { path: join(codexHome, 'models_cache.json'), exists: existsSync(join(codexHome, 'models_cache.json')), format: 'JSON', description: 'Codex 模型发现缓存', writable: true, purpose: '保存模型发现结果；通常由 Codex 自动更新。' },
    ],
    fields: [
      { key: 'baseUrl', label: 'Responses API 地址', type: 'text', value: stringField(provider, 'baseUrl'), required: true },
      { key: 'envKey', label: 'API Key', type: 'password', value: '', configured: !!effectiveApiKey,
        placeholder: effectiveApiKey ? '已安全保存；输入新值可替换' : '输入 API Key',
        description: storedApiKey ? '密钥加密保存在本机平台凭据。' : environmentApiKey ? '由独立 Engine 的启动环境提供。' : '密钥加密保存到本机平台凭据，仅用于启动该 Provider。' },
      { key: 'codexHome', label: '独立 CODEX_HOME', type: 'text', value: codexHome },
      { key: 'models', label: '模型', type: 'string-list', value: listField(provider, 'models'), required: true },
      { key: 'defaultModel', label: '默认模型', type: 'text', value: stringField(provider, 'defaultModel') },
      {
        key: 'command',
        label: '启动命令',
        type: 'text',
        value: normalizeEngineCommand(provider.fields.command, 'codex'),
        required: true,
        description: '作为无 shell 的可执行文件路径或 PATH 中的命令名启动。',
      },
      {
        key: 'launchArgs',
        label: '附加启动参数',
        type: 'string-list',
        value: normalizeEngineArgs(provider.fields.launchArgs),
        description: '每行一个 argv；追加到 AgentManager 生成的 Provider 参数之后，重启 Engine 后生效。',
      },
    ],
  };
}

function validateProvider(input: AgentProviderInput, prior?: StoredProvider): StoredProvider {
  const id = (input.id || prior?.id || '').trim();
  if (!validId(id)) throw Object.assign(Error('Provider ID 必须以小写字母开头，只能包含字母、数字、点、横线和下划线'), { statusCode: 400 });
  const fields = { ...(prior?.fields || {}), ...(input.fields || {}) };
  const baseUrl = typeof fields.baseUrl === 'string' ? fields.baseUrl.trim() : '';
  const models = Array.isArray(fields.models)
    ? fields.models.filter(value => typeof value === 'string' && value.trim()).slice(0, 100).map(value => String(value).trim())
    : [];
  if (!/^https?:\/\/\S+$/.test(baseUrl)) throw Object.assign(Error('Responses API 地址无效'), { statusCode: 400 });
  if (!models.length) throw Object.assign(Error('至少配置一个模型'), { statusCode: 400 });
  const envKey = typeof fields.envKey === 'string' ? fields.envKey.trim() : '';
  if (envKey && !/^[A-Z_][A-Z0-9_]*$/.test(envKey)) throw Object.assign(Error('API Key 环境变量名无效'), { statusCode: 400 });
  const command = normalizeEngineCommand(fields.command, 'codex');
  const launchArgs = normalizeEngineArgs(fields.launchArgs);
  return {
    id,
    name: input.name?.trim() || prior?.name || id,
    kind: input.kind?.trim() || prior?.kind || 'responses',
    enabled: input.enabled ?? prior?.enabled ?? true,
    fields: { ...fields, baseUrl, models, envKey, command, launchArgs },
  };
}

async function startProvider(provider: StoredProvider, report?: AgentOperationReporter): Promise<void> {
  if (processes.has(provider.id) && existsSync(managedCodexSocket(provider.id))) return;
  startupErrors.delete(provider.id);
  report?.({ stage: 'command', message: '校验 Engine 启动命令', progress: 10 });
  const launch = providerLaunch(provider);
  const executable = await findExecutable(launch.command);
  if (!executable) throw Object.assign(Error(`Engine 命令不可执行：${launch.command}`), { statusCode: 409 });
  report?.({ stage: 'prepare', message: '准备 CODEX_HOME、socket 与启动参数', progress: 25 });
  const socket = managedCodexSocket(provider.id);
  const codexHome = expandHome(stringField(provider, 'codexHome', `~/.codex-agentmanager/${provider.id}`));
  mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const defaultModel = stringField(provider, 'defaultModel') || listField(provider, 'models')[0];
  const envKey = 'AGENTMANAGER_PROVIDER_API_KEY';
  const credentialName = stringField(provider, 'envKey');
  const apiKey = providerApiKey(provider.id)
    || (credentialName && process.env[credentialName])
    || '';
  const configFile = join(codexHome, 'config.toml');
  if (!existsSync(configFile)) {
    await writeFile(configFile, [
      `model_provider = ${JSON.stringify(provider.id)}`,
      `model = ${JSON.stringify(defaultModel)}`,
      `[model_providers.${provider.id}]`,
      `name = ${JSON.stringify(provider.name)}`,
      `base_url = ${JSON.stringify(stringField(provider, 'baseUrl'))}`,
      'wire_api = "responses"',
      ...(envKey ? [`env_key = ${JSON.stringify(envKey)}`] : []),
      '',
    ].join('\n'), { encoding: 'utf8', mode: 0o600 });
  }
  try { unlinkSync(socket); } catch { /* stale socket */ }
  const args = launch.args;
  report?.({ stage: 'spawn', message: '启动 Codex app-server', progress: 45 });
  const child = spawn(executable, args, {
    env: { ...process.env, CODEX_HOME: codexHome, ...(apiKey ? { [envKey]: apiKey } : {}) },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  if (!child.pid) throw Object.assign(Error('Codex Provider Engine 启动失败'), { statusCode: 502 });
  processes.set(provider.id, { pid: child.pid, startedAt: new Date().toISOString() });
  child.once('exit', () => processes.delete(provider.id));
  report?.({ stage: 'socket', message: '等待 Engine socket 就绪', progress: 70 });
  let connectedSocket = '';
  for (let attempt = 0; attempt < 50 && !connectedSocket; attempt++) {
    connectedSocket = discoverProviderSocket(child.pid);
    if (!connectedSocket) await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!connectedSocket) {
    processes.delete(provider.id);
    try { process.kill(child.pid, 'SIGTERM'); } catch { /* already exited */ }
    const log = providerStartupLog(codexHome);
    const message = log
      ? `Codex Provider Engine 未创建可连接的 socket。启动日志：${log}`
      : 'Codex Provider Engine 未创建可连接的 socket';
    startupErrors.set(provider.id, message);
    throw Object.assign(Error(message), { statusCode: 502 });
  }
  setManagedCodexRuntimeSocket(provider.id, connectedSocket);
  report?.({ stage: 'confirm', message: '确认 Engine 进程与 socket 状态', progress: 95 });
  child.once('exit', () => {
    processes.delete(provider.id);
    clearManagedCodexRuntimeSocket(provider.id);
  });
  if (child.exitCode != null) {
    processes.delete(provider.id);
    throw Object.assign(Error('Codex Provider Engine 启动失败'), { statusCode: 502 });
  }
}

function discoverProviderSocket(pid: number): string {
  const result = spawnSync('lsof', ['-a', '-p', String(pid), '-U', '-Fn'], { encoding: 'utf8' });
  const lines = (result.stdout || '').split('\n').filter(line => line.startsWith('n/'));
  return lines.map(line => line.slice(1)).find(path => existsSync(path)) || '';
}

function providerStartupLog(codexHome: string): string {
  const database = join(codexHome, 'logs_2.sqlite');
  if (!existsSync(database)) return '';
  const result = spawnSync('sqlite3', [database, "SELECT message FROM logs WHERE level IN ('ERROR','WARN') ORDER BY rowid DESC LIMIT 3;"], { encoding: 'utf8' });
  return (result.stdout || '').trim().replace(/\s+/g, ' ').slice(0, 500);
}

/** Persist provider config into its own CODEX_HOME before a restart. */
async function writeProviderConfigFile(provider: StoredProvider): Promise<void> {
  const home = providerCodexHome(provider);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const models = listField(provider, 'models');
  const catalogPath = join(home, 'model-catalog.json');
  const defaultModel = stringField(provider, 'defaultModel') || models[0] || '';
  const previous = existsSync(catalogPath)
    ? await readFile(catalogPath, 'utf8').then(value => JSON.parse(value) as { models?: Array<Record<string, unknown>> }).catch(() => null)
    : null;
  const previousModels = new Map((previous?.models || []).flatMap(item =>
    typeof item.slug === 'string' ? [[item.slug, item] as const] : []));
  const instructions = await catalogInstructions();
  const fallback = (model: string) => ({
    slug: model, display_name: model, description: `${model} via ${provider.name}`,
    default_reasoning_level: 'medium',
    supported_reasoning_levels: [
      { effort: 'low', description: 'Fast responses' },
      { effort: 'medium', description: 'Balanced reasoning' },
      { effort: 'high', description: 'Greater reasoning depth' },
    ],
    shell_type: 'shell_command', visibility: 'list', supported_in_api: true,
    priority: models.indexOf(model), upgrade: null, context_window: 200000, max_context_window: 200000,
    support_verbosity: true, default_verbosity: 'low',
    truncation_policy: { mode: 'tokens', limit: 10_000 },
    comp_hash: '3000', effective_context_window_percent: 95, experimental_supported_tools: [],
    input_modalities: ['text'], supports_search_tool: true, supports_image_detail_original: true,
    use_responses_lite: false, tool_mode: null, multi_agent_version: 'v2',
    ...instructions,
  });
  await writeFile(catalogPath, JSON.stringify({
    models: models.map(model => ({ ...fallback(model), ...previousModels.get(model) })),
  }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  await writeFile(join(home, 'config.toml'), [
    `model_provider = ${JSON.stringify(provider.id)}`,
    `model = ${JSON.stringify(defaultModel)}`,
    `model_catalog_json = ${JSON.stringify(catalogPath)}`,
    `[model_providers.${provider.id}]`,
    `name = ${JSON.stringify(provider.name)}`,
    `base_url = ${JSON.stringify(stringField(provider, 'baseUrl'))}`,
    'wire_api = "responses"',
    'env_key = "AGENTMANAGER_PROVIDER_API_KEY"',
    '',
  ].join('\n'), { encoding: 'utf8', mode: 0o600 });
}

/** Fill fields introduced by a newer Codex without discarding user-managed
 * model context, modality, or instruction customization. */
export async function ensureManagedProviderCatalog(provider: StoredProvider): Promise<boolean> {
  const home = providerCodexHome(provider);
  const catalogPath = join(home, 'model-catalog.json');
  if (!existsSync(catalogPath)) {
    await writeProviderConfigFile(provider);
    return true;
  }
  try {
    const value = JSON.parse(await readFile(catalogPath, 'utf8')) as { models?: unknown };
    const instructions = await catalogInstructions().catch(() => null);
    if (!Array.isArray(value.models) || !value.models.length) throw Error('empty model catalog');
    let changed = false;
    const models = value.models as unknown[];
    const normalizedModels = models.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
      const model = item as Record<string, unknown>;
      const normalized = { ...model };
      if (typeof normalized.support_verbosity !== 'boolean') {
        normalized.support_verbosity = true;
        changed = true;
      }
      if (typeof normalized.default_verbosity !== 'string') {
        normalized.default_verbosity = 'low';
        changed = true;
      }
      if (!normalized.truncation_policy || typeof normalized.truncation_policy !== 'object' || Array.isArray(normalized.truncation_policy)) {
        normalized.truncation_policy = { mode: 'tokens', limit: 10_000 };
        changed = true;
      }
      const missingInstructions = !normalized.base_instructions
        && !(normalized.model_messages && typeof normalized.model_messages === 'object'
          && typeof (normalized.model_messages as Record<string, unknown>).instructions_template === 'string');
      if (missingInstructions && instructions) {
        Object.assign(normalized, instructions);
        changed = true;
      }
      return normalized;
    });
    const invalid = normalizedModels.some(item => !item || typeof item !== 'object' || Array.isArray(item)
      || typeof (item as Record<string, unknown>).slug !== 'string');
    if (invalid) throw Error('invalid model catalog');
    value.models = normalizedModels;
    if (changed) {
      await writeFile(catalogPath, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    }
    return changed;
  } catch { /* Rewrite malformed or empty managed catalogs. */ }
  await writeProviderConfigFile(provider);
  return true;
}

function providerCodexHome(provider: StoredProvider): string {
  return externalProviderCodexHome(provider);
}

async function removeProviderDirectory(providerId: string): Promise<void> {
  const provider = readAgentManagement('codex').providers.find(item => item.id === providerId);
  if (!provider) return;
  const home = providerCodexHome(provider);
  const defaultHomes = [
    join(homedir(), '.codex-agentmanager', providerId),
    join(homedir(), `.codex-${providerId}`),
  ];
  const expected = defaultHomes.includes(home) || home.includes(`.codex-agentmanager/${providerId}`)
    || home === join(process.env.CODEX_HOME || '', `../.codex-${providerId}`)
    || home.startsWith(join(dirname(getDb().name || '' ), 'codex-agentmanager'));
  if (!expected) throw Object.assign(Error('拒绝删除非 AgentManager 管理的 Provider 目录'), { statusCode: 409 });
  if (!existsSync(home)) return;
  await rm(home, { recursive: true, force: true });
}

/** Exposed only to the Codex adapter's focused tests; not a route or CLI port. */
export async function removeManagedProviderStorage(providerId: string): Promise<void> {
  await removeProviderDirectory(providerId);
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(secretKeyName(providerId));
  updateAgentManagement('codex', current => ({
    ...current,
    providers: current.providers.filter(item => item.id !== providerId),
  }));
}

function externalProviderCodexHome(provider: StoredProvider): string {
  return expandHome(stringField(provider, 'codexHome', join(homedir(), `.codex-${provider.id}`)));
}

function allowedProviderConfigPath(provider: StoredProvider, path: string): boolean {
  const home = providerCodexHome(provider);
  return path === join(home, 'config.toml')
    || path === join(home, 'model-catalog.json')
    || path === join(home, 'models_cache.json');
}

function nativeConfigPaths(): string[] {
  const home = dirname(configPath());
  return [
    join(home, 'config.toml'),
    join(home, 'models_cache.json'),
    join(home, 'models.json'),
    join(home, 'model-catalog.json'),
    join(home, 'model-catalog-all.json'),
    join(home, 'model-catalog-grok-4.6.json'),
    join(home, '.codex-global-state.json'),
    join(home, 'history.jsonl'),
    join(home, 'auth.json'),
  ];
}

function isNativeSensitivePath(path: string): boolean {
  return path === join(dirname(configPath()), 'auth.json');
}

async function readProviderConfig(provider: StoredProvider, path: string): Promise<string> {
  if (!allowedProviderConfigPath(provider, path)) throw Object.assign(Error('只能编辑该 Provider 的 CODEX_HOME 配置文件'), { statusCode: 403 });
  try { return await readFile(path, 'utf8'); }
  catch (error: any) {
    if (error?.code === 'ENOENT') return '';
    throw Object.assign(Error('无法读取 Provider 配置文件'), { statusCode: 500 });
  }
}

async function probeProviderModels(endpoint: string, apiKey: string): Promise<Array<{ model:string; name:string }>> {
  const base = endpoint.replace(/\/+$/, '');
  const response = await fetch(`${base}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw Error(`模型探测失败 (${response.status})`);
  const body = await response.json() as { data?: Array<{id?:unknown;name?:unknown}> };
  if (!Array.isArray(body.data)) throw Error('模型列表格式无效');
  return body.data.flatMap(item => typeof item?.id === 'string' && item.id.trim()
    ? [{ model: item.id.trim(), name: typeof item.name === 'string' ? item.name : item.id.trim() }]
    : []);
}

function stopProvider(providerId: string): void {
  const processInfo = processes.get(providerId);
  if (processInfo) {
    try { process.kill(processInfo.pid, 'SIGTERM'); } catch { /* already exited */ }
    processes.delete(providerId);
  }
  clearManagedCodexRuntimeSocket(providerId);
  try { unlinkSync(managedCodexSocket(providerId)); } catch { /* socket already gone */ }
}

export async function restoreManagedCodexProviders(): Promise<void> {
  for (const provider of readAgentManagement('codex').providers.filter(item => item.enabled)) {
    const catalogChanged = await ensureManagedProviderCatalog(provider).catch(() => false);
    const engine = configuredCodexEngines().find(item => item.provider === provider.id);
    if (engine && discoverProviderSocketBySocket(engine.socket)) {
      const actual = discoverProviderSocketBySocket(engine.socket);
      if (catalogChanged) {
        const pid = socketPidSync(actual);
        if (pid) {
          try { process.kill(pid, 'SIGTERM'); } catch { /* already exited */ }
          for (let attempt = 0; attempt < 20 && discoverProviderSocketBySocket(engine.socket); attempt++) {
            await new Promise(resolve => setTimeout(resolve, 50));
          }
        }
      } else {
        setManagedCodexRuntimeSocket(provider.id, actual);
        continue;
      }
    }
    await startProvider(provider).catch(() => {});
  }
}

export async function initializeManagedCodexEngines(): Promise<void> {
  const providerIds = readAgentManagement('codex').providers.map(provider => provider.id);
  const takeOverLaunchAgents = !config.isDev && config.takeoverCodexLaunchAgents;
  if (takeOverLaunchAgents) disableLegacyCodexLaunchAgents(providerIds);
  const results = await Promise.allSettled([
    ensureNativeCodexEngine(takeOverLaunchAgents),
    restoreManagedCodexProviders(),
  ]);
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failure) throw failure.reason;
}

function socketPidSync(socket: string): number | null {
  const result = spawnSync('lsof', ['-nP', '-Fp', socket], { encoding: 'utf8' });
  const pid = result.stdout?.match(/^p(\d+)$/m)?.[1];
  return pid ? Number(pid) : null;
}

function discoverProviderSocketBySocket(socket: string): string {
  if (!existsSync(socket)) return '';
  const pid = socketPidSync(socket);
  return pid ? discoverProviderSocket(pid) || socket : '';
}

/** Refresh one Provider route and register its daemon-redirected socket before
 * issuing model RPCs. Status inspection alone previously repaired only its DTO. */
export async function inspectManagedCodexProvider(providerId: string): Promise<AgentProviderState | null> {
  const provider = readAgentManagement('codex').providers.find(item => item.id === providerId);
  if (!provider) return null;
  const engine = engineForStoredProvider(providerId);
  if (engine) {
    const actual = discoverProviderSocketBySocket(engine.socket);
    const pid = actual ? socketPidSync(actual) : null;
    if (actual && pid) {
      processes.set(providerId, { pid, startedAt: new Date().toISOString() });
      setManagedCodexRuntimeSocket(providerId, actual);
    }
  }
  const recovered = recoverRuntimeProviderState(providerId);
  if (recovered) {
    return {
      ...managedProviderState(provider), socket: recovered.socket, pid: recovered.pid,
      status: 'ready', statusText: `独立 Engine 运行中 · PID ${recovered.pid}`,
    };
  }
  return managedProviderState(provider);
}

export function codexManagement(descriptor: AgentDescriptor): AgentManagementPort {
  const inspect = async (force = false): Promise<AgentManagementState> => {
    const executable = await findExecutable('codex');
    const version = executable ? await runCli(executable, ['--version']) : null;
    const doctor = executable && force ? await runCli(executable, ['doctor', '--json'], { timeout: 30_000 }) : null;
    let doctorJson: any = null;
    try { doctorJson = JSON.parse(doctor?.stdout || 'null'); } catch { /* optional diagnostic */ }
    const authStatus = doctorJson?.checks?.auth?.credentials?.status?.status;
    const stored = readAgentManagement('codex');
    const external = await externalProviders();
    return {
      agent: descriptor,
      installation: {
        status: executable ? 'ready' : 'unavailable',
        executable,
        version: version ? firstVersion(`${version.stdout}\n${version.stderr}`) : null,
        latestVersion: null,
        updateAvailable: false,
        installCommand: 'npm install -g @openai/codex@latest',
        updateCommand: 'codex update',
      },
      authentication: {
        status: authStatus === 'pass' ? 'authenticated' : authStatus === 'fail' ? 'missing' : 'unknown',
        method: 'Codex 原生登录或 Provider 环境变量',
        detail: authStatus === 'pass' ? 'Codex 原生凭据可用。' : '可运行 codex login，或为自定义 Provider 配置密钥环境变量。',
      },
      defaults: [
        { key: 'command', label: '启动命令', type: 'text', value: managedLaunchCommand('codex', descriptor.launchCommand || 'codex'), description: '用于后续新开和恢复的 Codex 会话；正在运行的进程不会被改写。' },
        { key: 'model', label: '默认模型', type: 'text', value: typeof stored.defaults.model === 'string' ? stored.defaults.model : '', placeholder: '留空使用 Codex 默认模型', description: '传递给新会话的启动命令；当前会话可即时切换模型。' },
        { key: 'effort', label: '默认推理强度', type: 'select', value: typeof stored.defaults.effort === 'string' ? stored.defaults.effort : '', options: [
          { value: '', label: '使用 Codex 默认值' }, { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' },
          { value: 'high', label: 'High' }, { value: 'xhigh', label: 'XHigh' },
        ] },
      ],
      providers: [...nativeProviders(), ...external, ...stored.providers.filter(provider => !configuredCodexEngines().some(engine => engine.provider === provider.id)).map(managedProviderState)],
      configFiles: [
        { path: configPath(), exists: existsSync(configPath()), format: 'TOML', description: 'Codex 原生配置', writable: true },
        { path: join(dirname(configPath()), 'model-catalog.json'), exists: existsSync(join(dirname(configPath()), 'model-catalog.json')), format: 'JSON', description: 'Codex 原生模型目录', writable: true },
        { path: join(dirname(configPath()), 'auth.json'), exists: existsSync(join(dirname(configPath()), 'auth.json')), format: 'JSON', description: 'Codex 原生凭据，仅显示存在状态', writable: false, sensitive: true },
      ],
      diagnostics: [
        { id: 'installation', status: executable ? 'ready' : 'error', label: 'CLI', detail: executable || '未找到 Codex CLI' },
        ...(doctorJson ? [{ id: 'doctor', status: doctorJson.overallStatus === 'pass' ? 'ready' as const : 'warning' as const, label: 'Codex Doctor', detail: `综合状态：${doctorJson.overallStatus || 'unknown'}` }] : []),
      ],
      actions: [
        { id: 'refresh', label: '重新检测', available: true },
        { id: 'diagnose', label: '运行诊断', available: !!executable },
        { id: 'update', label: '升级', kind: 'primary', confirm: '将执行 codex update', available: !!executable },
      ],
      providerManagement: {
        create: true,
        update: true,
        delete: true,
        actions: ['start', 'stop', 'restart', 'test'],
        fields: [
          { key: 'baseUrl', label: 'Responses API 地址', type: 'text', required: true, placeholder: 'https://api.example.com/v1' },
          { key: 'envKey', label: 'API Key 环境变量', type: 'text', description: '只保存环境变量名，不保存密钥内容。' },
          { key: 'codexHome', label: '独立 CODEX_HOME', type: 'text', placeholder: '~/.codex-agentmanager/provider-id' },
          { key: 'models', label: '模型', type: 'string-list', required: true, placeholder: '每行一个模型 ID' },
          { key: 'defaultModel', label: '默认模型', type: 'text' },
        ],
      },
      applySemantics: {
        settings: 'new_session',
        providers: 'immediate',
        detail: 'Engine 命令、参数与启停由 AgentManager 即时管理；模型默认值用于新开或恢复的会话。正在运行的会话请在对话底部控制条切换。',
      },
      checkedAt: new Date().toISOString(),
    };
  };

  return {
    inspect,
    inspectProvider: async providerId => {
      if (providerId === 'native') return nativeProviders()[0];
      let provider = readAgentManagement('codex').providers.find(item => item.id === providerId);
      if (!provider) {
        await externalProviders();
        provider = readAgentManagement('codex').providers.find(item => item.id === providerId);
      }
      if (!provider) return null;
      return await inspectManagedCodexProvider(providerId) || managedProviderState(provider);
    },
    update: async input => {
      updateAgentManagement('codex', current => ({ ...current, defaults: { ...current.defaults, ...(input.defaults || {}) } }));
      return inspect(true);
    },
    action: async action => {
      if (action === 'update') {
        const executable = await findExecutable('codex');
        if (!executable) throw Object.assign(Error('Codex CLI 未安装'), { statusCode: 409 });
        const result = await runCli(executable, ['update'], { timeout: 120_000 });
        if (!result.ok) throw Object.assign(Error(result.stderr || result.stdout || 'Codex 升级失败'), { statusCode: 502 });
      } else if (!['refresh', 'diagnose'].includes(action)) throw Object.assign(Error(`不支持的操作: ${action}`), { statusCode: 400 });
      return inspect(true);
    },
    createProvider: async input => {
      const provider = validateProvider(input);
      updateAgentManagement('codex', current => {
        if (current.providers.some(item => item.id === provider.id) || provider.id === 'native') {
          throw Object.assign(Error('Provider ID 已存在'), { statusCode: 409 });
        }
        return { ...current, providers: [...current.providers, provider] };
      });
      saveProviderApiKey(provider.id, input.apiKey);
      if (provider.enabled) {
        await writeProviderConfigFile(provider);
        await startProvider(provider);
      }
      return inspect(true);
    },
    updateProvider: async (providerId, input, report) => {
      if (providerId === 'native') {
        report?.({ stage: 'validate', message: '校验 Engine 启动命令与附加参数', progress: 10 });
        updateNativeEngineConfig(input);
        report?.({ stage: 'save', message: '保存原生 Engine 启动配置', progress: 25 });
        await restartNativeCodexEngine(progress => report?.({ ...progress, progress: 25 + progress.progress * 0.75 }));
        return inspect(true);
      }
      let updated: StoredProvider | undefined;
      report?.({ stage: 'validate', message: '校验 Provider 配置', progress: 10 });
      updateAgentManagement('codex', current => {
        const prior = current.providers.find(item => item.id === providerId);
        if (!prior) throw Object.assign(Error('原生 Provider 只能在 Codex config.toml 中编辑'), { statusCode: 409 });
        updated = validateProvider({ ...input, id: providerId }, prior);
        return { ...current, providers: current.providers.map(item => item.id === providerId ? updated! : item) };
      });
      saveProviderApiKey(providerId, input.apiKey);
      if (updated?.enabled) {
        report?.({ stage: 'save', message: '写入 Provider 配置与模型目录', progress: 25 });
        await writeProviderConfigFile(updated);
        report?.({ stage: 'stop', message: '停止现有 Provider Engine', progress: 35 });
        stopProvider(providerId);
        await startProvider(updated, progress => report?.({ ...progress, progress: 35 + progress.progress * 0.65 }));
      } else {
        stopProvider(providerId);
      }
      return inspect(true);
    },
    deleteProvider: async providerId => {
      const provider = readAgentManagement('codex').providers.find(item => item.id === providerId);
      if (!provider) throw Object.assign(Error('Provider 不存在或属于原生配置'), { statusCode: 409 });
      stopProvider(providerId);
      await removeManagedProviderStorage(providerId);
      return inspect(true);
    },
    providerAction: async (providerId, action, report) => {
      if (providerId === 'native') {
        if (action === 'start' || action === 'enable') await ensureNativeCodexEngine(undefined, report);
        else if (action === 'stop' || action === 'disable') await stopNativeCodexEngine(report);
        else if (action === 'restart') await restartNativeCodexEngine(report);
        else throw Object.assign(Error(`不支持的原生 Engine 操作: ${action}`), { statusCode: 400 });
        report?.({ stage: 'complete', message: `${action === 'stop' || action === 'disable' ? 'Engine 已停止' : 'Engine 已就绪'}`, progress: 100 });
        return inspect(true);
      }
      const provider = readAgentManagement('codex').providers.find(item => item.id === providerId);
      if (!provider) throw Object.assign(Error('原生 Provider 不支持此操作'), { statusCode: 409 });
      if (action === 'start' || action === 'enable') {
        report?.({ stage: 'enable', message: '启用 Provider 启动配置', progress: 5 });
        updateAgentManagement('codex', current => ({ ...current, providers: current.providers.map(item => item.id === providerId ? { ...item, enabled: true } : item) }));
        await startProvider({ ...provider, enabled: true }, report);
      } else if (action === 'stop' || action === 'disable') {
        report?.({ stage: 'stop', message: '停止 Provider Engine', progress: 25 });
        stopProvider(providerId);
        updateAgentManagement('codex', current => ({ ...current, providers: current.providers.map(item => item.id === providerId ? { ...item, enabled: false } : item) }));
        report?.({ stage: 'cleanup', message: '清理 socket 与运行状态', progress: 90 });
      } else if (action === 'restart') {
        report?.({ stage: 'stop', message: '停止当前 Provider Engine', progress: 15 });
        stopProvider(providerId);
        await startProvider(provider, progress => report?.({ ...progress, progress: 20 + progress.progress * 0.8 }));
      } else if (action === 'test') {
        report?.({ stage: 'inspect', message: '检查 Provider Engine 路由', progress: 50 });
        if (!configuredCodexEngines().some(engine => engine.provider === providerId)) throw Object.assign(Error('Provider Engine 未启用'), { statusCode: 409 });
      } else throw Object.assign(Error(`不支持的 Provider 操作: ${action}`), { statusCode: 400 });
      report?.({ stage: 'complete', message: 'Engine 状态已更新', progress: 100 });
      return inspect(true);
    },
    detectModels: async input => {
      if (input?.endpoint) {
        const endpoint = new URL(input.endpoint);
        if (!['http:', 'https:'].includes(endpoint.protocol)) throw Object.assign(Error('Responses API 地址无效'), { statusCode: 400 });
        const apiKey = input.apiKey?.trim() || (input.providerId ? providerApiKey(input.providerId) : '');
        if (!apiKey) throw Object.assign(Error('请先输入 API Key'), { statusCode: 400 });
        return probeProviderModels(endpoint.toString(), apiKey);
      }
      const { readEngineModelsForProvider } = await import('./controls.js');
      return readEngineModelsForProvider(input?.providerId, true);
    },
    readModelConfigs: async () => {
      const results = await Promise.all(configuredCodexEngines().flatMap(engine => engine.provider
        ? [readModelConfigsForProvider(engine.provider).catch(() => [])] : []));
      const native = await readModelConfigsForProvider('native').catch(() => []);
      return [...native, ...results.flat()];
    },
    updateModelConfigs: async updates => {
      const grouped = new Map<string, AgentModelConfigUpdate[]>();
      const available = await Promise.all([
        readModelConfigsForProvider('native').catch(() => []),
        ...configuredCodexEngines().flatMap(engine => engine.provider
          ? [readModelConfigsForProvider(engine.provider).catch(() => [])] : []),
      ]);
      const all = available.flat();
      const providerIdFor = (config: AgentModelConfig) =>
        config.provider === 'wanzhao' ? 'native' : config.provider || 'native';
      for (const update of updates) {
        const requestedProvider = update.provider === 'wanzhao' ? 'native' : update.provider;
        const config = all.find(item => item.model === update.model
          && (!requestedProvider || providerIdFor(item) === requestedProvider));
        if (!config) continue;
        const providerId = providerIdFor(config);
        grouped.set(providerId, [...(grouped.get(providerId) || []), update]);
      }
      for (const [providerId, values] of grouped) await updateModelConfigsForProvider(providerId, values);
      return (await Promise.all([
        readModelConfigsForProvider('native').catch(() => []),
        ...configuredCodexEngines().flatMap(engine => engine.provider
          ? [readModelConfigsForProvider(engine.provider).catch(() => [])] : []),
      ])).flat();
    },
    readConfigFile: async file => {
      const owner = readAgentManagement('codex').providers.find(item => allowedProviderConfigPath(item, file.path));
      if (owner) {
        const content = await readProviderConfig(owner, file.path);
        return { path: file.path, content, exists: existsSync(file.path), format: file.path.endsWith('.json') ? 'JSON' : 'TOML' };
      }
      const allowed = nativeConfigPaths();
      if (!allowed.includes(file.path)) throw Object.assign(Error('只能编辑 Codex 已声明的配置文件'), { statusCode: 403 });
      if (isNativeSensitivePath(file.path)) return { path: file.path, content: '', exists: existsSync(file.path), format: 'JSON' };
      try { return { path: file.path, content: await readFile(file.path, 'utf8'), exists: true, format: file.path.endsWith('.json') ? 'JSON' : 'TOML' }; }
      catch (error: any) {
        if (error?.code !== 'ENOENT') throw Object.assign(Error('无法读取 Codex 配置文件'), { statusCode: 500 });
        return { path: file.path, content: '', exists: false, format: file.path.endsWith('.json') ? 'JSON' : 'TOML' };
      }
    },
    writeConfigFile: async file => {
      const owner = readAgentManagement('codex').providers.find(item => allowedProviderConfigPath(item, file.path));
      const allowed = nativeConfigPaths();
      if (!owner && !allowed.includes(file.path)) throw Object.assign(Error('只能编辑 Codex 已声明的配置文件'), { statusCode: 403 });
      if (owner) {
        const current = await readProviderConfig(owner, file.path);
        if (file.expectedContent !== undefined && file.expectedContent !== null && current !== file.expectedContent) {
          throw Object.assign(Error('配置文件已在磁盘上发生变化，请重新加载后再保存'), { statusCode: 409 });
        }
        await writeFile(file.path, file.content, { encoding: 'utf8', mode: 0o600 });
        const route = engineForStoredProvider(owner.id);
        if (route && owner.enabled) {
          stopProvider(owner.id);
          await startProvider(owner);
        }
        return { path: file.path, content: file.content, exists: true, format: file.path.endsWith('.json') ? 'JSON' : 'TOML', restarted: true };
      }
      if (file.expectedContent !== undefined && file.expectedContent !== null) {
        const current = existsSync(file.path) ? await readFile(file.path, 'utf8') : '';
        if (current !== file.expectedContent) throw Object.assign(Error('配置文件已在磁盘上发生变化，请重新加载后再保存'), { statusCode: 409 });
      }
      await writeFile(file.path, file.content, { encoding: 'utf8', mode: 0o600 });
      const nativeEngineFile = file.path === configPath()
        || file.path === join(dirname(configPath()), 'model-catalog.json')
        || file.path === join(dirname(configPath()), 'model-catalog-all.json')
        || file.path === join(dirname(configPath()), 'model-catalog-grok-4.6.json')
        || file.path === join(dirname(configPath()), 'models.json')
        || file.path === join(dirname(configPath()), 'models_cache.json');
      if (nativeEngineFile) await restartNativeCodexEngine();
      return { path: file.path, content: file.content, exists: true, format: file.path.endsWith('.json') ? 'JSON' : 'TOML', restarted: nativeEngineFile };
    },
  };
}
