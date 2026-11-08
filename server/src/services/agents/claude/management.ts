import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { AgentDescriptor, AgentManagementPort, AgentProviderState } from '../types.js';
import { commonManagement } from '../management-common.js';
import { findExecutable, runCli } from '../management-cli.js';
import { readClaudeControls } from './controls.js';
import { managedEnv, readManagedEnvironment, updateManagedEnvironment } from '../environment-store.js';
import type { AgentEnvironmentVariable } from '../types.js';

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
      const models = (await readClaudeControls({ session: {}, nativeId: null, projectPath: process.cwd() })).models.map(item => item.model);
      const providers: AgentProviderState[] = [{
        id: 'anthropic',
        name: 'Anthropic',
        kind: 'official',
        enabled: true,
        managed: false,
        status: 'ready',
        statusText: '由 Claude Code / Agent SDK 原生配置管理',
        authentication: { status: 'unknown', method: 'Claude 登录或 ANTHROPIC_API_KEY' },
        models,
        defaultModel: managedEnv('ANTHROPIC_MODEL') || null,
        fields: [],
      }];
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
  const inspect = async (force = false) => ({ ...await base.inspect(force), environment: environment() });
  return {
    ...base,
    inspect,
    update: async input => ({ ...await base.update(input), environment: environment() }),
    action: async action => ({ ...await base.action(action), environment: environment() }),
    createProvider: async input => ({ ...await base.createProvider(input), environment: environment() }),
    updateProvider: async (providerId, input) => ({ ...await base.updateProvider(providerId, input), environment: environment() }),
    deleteProvider: async providerId => ({ ...await base.deleteProvider(providerId), environment: environment() }),
    providerAction: async (providerId, action) => ({ ...await base.providerAction(providerId, action), environment: environment() }),
    updateEnvironment: async input => {
      const allowed = new Set(CLAUDE_ENVIRONMENT.map(variable => variable.name));
      const values = Object.fromEntries(Object.entries(input.values || {}).filter(([name]) => allowed.has(name)));
      const clear = (input.clear || []).filter(name => allowed.has(name));
      updateManagedEnvironment({ values, clear });
      for (const [name, value] of Object.entries(values)) process.env[name] = value;
      for (const name of clear) delete process.env[name];
      return environment();
    },
    detectModels: async () => {
      const controls = await readClaudeControls({ session: {}, nativeId: null, projectPath: process.cwd() });
      return controls.models.map(item => ({ model: item.model, name: item.name, description: item.description }));
    },
    saveSelectedModels: async (models, defaultModel) => {
      const aliases = new Set(['default', 'sonnet', 'opus', 'haiku']);
      const unique = [...new Set(models.filter(model => typeof model === 'string' && model.trim()).map(model => model.trim()))];
      if (!unique.length) throw Object.assign(Error('至少选择一个 Claude 模型'), { statusCode: 400 });
      const selectedDefault = defaultModel && unique.includes(defaultModel) ? defaultModel : unique[0];
      const values: Record<string,string> = { ANTHROPIC_MODEL: selectedDefault };
      const defaults = unique.filter(model => !aliases.has(model));
      if (defaults[0]) values.ANTHROPIC_DEFAULT_OPUS_MODEL = defaults[0];
      if (defaults[1] || defaults[0]) values.ANTHROPIC_DEFAULT_SONNET_MODEL = defaults[1] || defaults[0];
      if (defaults[2] || defaults[1] || defaults[0]) values.ANTHROPIC_DEFAULT_HAIKU_MODEL = defaults[2] || defaults[1] || defaults[0];
      updateManagedEnvironment({ values, clear: [] });
      for (const [name, value] of Object.entries(values)) process.env[name] = value;
      return environment();
    },
  };
}
