import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { AgentDescriptor, AgentManagementPort, AgentProviderState } from '../types.js';
import { commonManagement } from '../management-common.js';
import { findExecutable, runCli } from '../management-cli.js';
import { managedEnv, updateManagedEnvironment } from '../environment-store.js';
import type { AgentEnvironmentVariable } from '../types.js';
import {
  claudeEnvironmentName,
  claudeRuntimeProvider,
  claudeProviderState,
  createClaudeProvider,
  deleteClaudeProvider,
  detectClaudeProviderModels,
  enabledClaudeProviders,
  ensureNativeClaudeProvider,
  nativeClaudeProviderState,
  nativeClaudeProviderApiKey,
  persistDetectedClaudeModels,
  toggleClaudeProvider,
  verifyAndCreateClaudeProvider,
  updateClaudeProvider,
  updateNativeClaudeProvider,
} from './providers.js';
import { readAgentManagement } from '../management-store.js';

const CLAUDE_ENVIRONMENT: Array<{name:string;description:string;secret?:boolean}> = [
  { name: 'ANTHROPIC_AUTH_TOKEN', description: 'Claude 网关或 Anthropic API 认证令牌', secret: true },
  { name: 'ANTHROPIC_API_KEY', description: 'Anthropic API Key 的备用变量', secret: true },
  { name: 'ANTHROPIC_BASE_URL', description: 'Claude Code 使用的 API 网关地址' },
  { name: 'ANTHROPIC_MODEL', description: 'Claude 默认模型（主模型）' },
  { name: 'ANTHROPIC_DEFAULT_OPUS_MODEL', description: 'Opus 别名映射到的模型' },
  { name: 'ANTHROPIC_DEFAULT_SONNET_MODEL', description: 'Sonnet 别名映射到的模型' },
  { name: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', description: 'Haiku 别名映射到的模型' },
  { name: 'CLAUDE_CODE_MAX_CONTEXT_TOKENS', description: 'Claude Code 上下文窗口上限' },
];

export function claudeManagement(descriptor: AgentDescriptor): AgentManagementPort {
  const environment = (): AgentEnvironmentVariable[] => CLAUDE_ENVIRONMENT.map(variable => {
    const value = managedEnv(variable.name);
    return {
      ...variable,
      value: variable.secret ? '' : value,
      configured: !!value,
      source: 'LaunchAgent 环境变量',
      editable: true,
    };
  });
  const base = commonManagement({
    descriptor,
    executable: 'claude',
    versionArgs: ['--version'],
    installCommand: 'npm install -g @anthropic-ai/claude-code@latest',
    updateCommand: 'claude update',
    configFiles: [
      { path: '~/.claude/settings.json', format: 'JSON', description: 'Claude Code 用户设置' },
      { path: '~/.claude.json', format: 'JSON', description: 'Claude Code 账户与项目状态' },
      { path: '~/.claude/settings.local.json', format: 'JSON', description: 'Claude Code 本地覆盖设置' },
      { path: '~/.claude/plugins/known_marketplaces.json', format: 'JSON', description: 'Claude 插件市场配置' },
      { path: '~/.claude/history.jsonl', format: 'JSONL', description: 'Claude 历史索引' },
    ],
    defaultFields: [
      { key: 'runtime', label: '运行方式', type: 'text', value: 'Claude Agent SDK（平台托管）', readOnly: true },
      { key: 'permission', label: '权限模式', type: 'text', value: 'bypassPermissions', readOnly: true, description: '平台托管会话沿用现有权限策略。' },
      { key: 'model', label: '默认模型', type: 'text', value: '', placeholder: '留空使用 Claude 账号默认模型', description: '用于新建 Claude 会话；当前会话请在对话底部控制条切换。' },
    ],
    authentication: async () => {
      const executable = await findExecutable('claude');
      if (!executable) return { status: 'unknown', method: '未检测', detail: 'Claude Code 未安装。' };
      const result = await runCli(executable, ['auth', 'status']);
      try {
        const status = JSON.parse(result.stdout || result.stderr) as Record<string, unknown>;
        return {
          status: status.loggedIn ? 'authenticated' : 'missing',
          method: String(status.authMethod || status.apiProvider || 'Claude 账号'),
          detail: status.loggedIn ? '已登录，凭据由 Claude Code 原生存储管理。' : '请在服务器终端运行 claude auth login。',
        };
      } catch {
        return {
          status: result.ok ? 'authenticated' : 'unknown',
          method: 'Claude Code 原生认证',
          detail: result.ok ? 'Claude Code 认证命令返回成功。' : '无法读取认证状态，可在服务器终端运行 claude auth status 检查。',
        };
      }
    },
    providers: async (): Promise<AgentProviderState[]> => {
      const providers: AgentProviderState[] = enabledClaudeProviders();
      if (managedEnv('CLAUDE_CODE_USE_BEDROCK') === '1') providers.push({
        id: 'bedrock',
        name: 'Amazon Bedrock',
        kind: 'cloud',
        enabled: true,
        managed: false,
        status: 'ready',
        statusText: '通过服务端环境变量启用',
        authentication: { status: 'unknown', method: 'AWS 凭据链' },
        models: [],
        defaultModel: null,
        fields: [],
      });
      if (managedEnv('CLAUDE_CODE_USE_VERTEX') === '1') providers.push({
        id: 'vertex',
        name: 'Google Vertex AI',
        kind: 'cloud',
        enabled: true,
        managed: false,
        status: 'ready',
        statusText: '通过服务端环境变量启用',
        authentication: { status: 'unknown', method: 'Google Cloud 凭据链' },
        models: [],
        defaultModel: null,
        fields: [],
      });
      return providers;
    },
    update: async () => {
      const executable = await findExecutable('claude');
      if (!executable) throw Object.assign(Error('Claude Code 未安装'), { statusCode: 409 });
      const result = await runCli(executable, ['update'], { timeout: 120_000 });
      if (!result.ok) throw Object.assign(Error(result.stderr || result.stdout || 'Claude Code 升级失败'), { statusCode: 502 });
    },
    diagnose: async () => {
      const home = join(homedir(), '.claude');
      const executable = await findExecutable('claude');
      return [
        {
          id: 'config-home',
          status: existsSync(home) ? 'ready' : 'warning',
          label: 'Claude 配置目录',
          detail: existsSync(home) ? home : `尚未创建 ${home}；首次启动 Claude 时会生成。`,
        },
        {
          id: 'sdk',
          status: 'ready',
          label: 'Agent SDK',
          detail: 'Claude 会话由 @anthropic-ai/claude-agent-sdk 托管，原生 CLI 用于安装、认证和诊断。',
        },
        ...(executable ? [] : [{ id: 'cli', status: 'error' as const, label: 'Claude CLI', detail: '未找到 claude 命令。' }]),
      ];
    },
  });
  const inspect = async (force = false) => {
    const state = await base.inspect(force);
    const stored = readAgentManagement('claude').providers.filter(provider => provider.id !== 'anthropic');
    return {
      ...state,
      environment: environment(),
      providers: state.providers,
      providerManagement: {
        ...state.providerManagement,
        create: true,
        update: true,
        delete: true,
        actions: ['enable', 'disable', 'test'],
        fields: [],
      },
      applySemantics: {
        ...state.applySemantics,
        providers: 'new_session' as const,
        detail: 'Claude Provider 绑定新会话；原生环境保留旧会话并继续由 LaunchAgent 环境变量管理。',
      },
    };
  };
  return {
    ...base,
    inspect,
    update: async input => ({ ...await base.update(input), environment: environment() }),
    action: async action => ({ ...await base.action(action), environment: environment() }),
    createProvider: async input => {
      await verifyAndCreateClaudeProvider(input).catch(async (error) => {
        // A temporary network failure must not strand an otherwise valid
        // configuration. Explicit model/protocol rejection still fails closed.
        if ((error as { code?: string })?.code === 'model_protocol_unavailable') throw error;
        createClaudeProvider(input);
        throw Object.assign(
          Error(`${error instanceof Error ? error.message : '模型预检失败'}；配置已保存，可稍后重新测试连接。`),
          { statusCode: 502 },
        );
      });
      return inspect(true);
    },
    updateProvider: async (providerId, input) => {
      if (providerId === 'anthropic') updateNativeClaudeProvider(input);
      else
      updateClaudeProvider(providerId, input);
      return inspect(true);
    },
    deleteProvider: async providerId => {
      deleteClaudeProvider(providerId);
      return inspect(true);
    },
    providerAction: async (providerId, action) => {
      if(providerId==='anthropic')throw Object.assign(Error('原生 Provider 由 Claude Code 环境配置管理，不能停用或删除'),{statusCode:409});
      if (action === 'test') {
        const provider = claudeRuntimeProvider({agent_environment_id:`claude-provider:${providerId}`});
        if (!provider?.defaultModel) throw Error('Provider 尚未配置默认模型');
        await (await import('./providers.js')).verifyClaudeProviderModel(provider, provider.defaultModel);
      } else if (action === 'enable') {
        toggleClaudeProvider(providerId, true);
      } else if (action === 'disable') {
        toggleClaudeProvider(providerId, false);
      } else {
        throw Object.assign(Error(`不支持的 Provider 操作: ${action}`), { statusCode: 400 });
      }
      return inspect(true);
    },
    inspectProvider: async providerId => {
      if (providerId === 'anthropic') {
        return nativeClaudeProviderState();
      }
      const provider = readAgentManagement('claude').providers.find(item => item.id === providerId);
      return provider ? claudeProviderState(provider) : null;
    },
    updateEnvironment: async input => {
      const allowed = new Set(CLAUDE_ENVIRONMENT.map(variable => variable.name));
      const values = Object.fromEntries(Object.entries(input.values || {}).filter(([name]) => allowed.has(name)));
      const clear = (input.clear || []).filter(name => allowed.has(name));
      updateManagedEnvironment({ values, clear });
      for (const [name, value] of Object.entries(values)) process.env[name] = value;
      for (const name of clear) delete process.env[name];
      return environment();
    },
    detectModels: async input => {
      const providerId = input?.providerId;
      const native = providerId === 'anthropic';
      if (native) ensureNativeClaudeProvider();
      const models = await detectClaudeProviderModels({
        ...input,
        endpoint:
          input?.endpoint ||
          (native ? claudeProviderStateForDetection() : undefined),
        apiKey:
          input?.apiKey || (native ? nativeClaudeProviderApiKey() : undefined),
      });
      if (providerId) await persistDetectedClaudeModels(providerId, models);
      return models;
    },
    saveSelectedModels: async (models, defaultModel) => {
      const unique = [...new Set(models.filter(model => typeof model === 'string' && model.trim()).map(model => model.trim()))];
      if (!unique.length) throw Object.assign(Error('至少选择一个 Claude 模型'), { statusCode: 400 });
      const selectedDefault = defaultModel && unique.includes(defaultModel) ? defaultModel : unique[0];
      const values: Record<string,string> = {
        ANTHROPIC_MODEL: selectedDefault,
        ANTHROPIC_DEFAULT_OPUS_MODEL: selectedDefault,
        ANTHROPIC_DEFAULT_SONNET_MODEL: selectedDefault,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: selectedDefault,
      };
      updateManagedEnvironment({ values, clear: [] });
      for (const [name, value] of Object.entries(values)) process.env[name] = value;
      return environment();
    },
  };
}

function claudeProviderStateForDetection(): string {
  const field = nativeClaudeProviderState().fields.find(item => item.key === 'baseUrl');
  return typeof field?.value === 'string' ? field.value : '';
}
