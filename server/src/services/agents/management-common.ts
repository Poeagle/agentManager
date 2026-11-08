import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { homedir } from 'os';
import type {
  AgentDescriptor,
  AgentManagementField,
  AgentManagementPort,
  AgentManagementState,
  AgentProviderState,
} from './types.js';
import { findExecutable, firstVersion, runCli } from './management-cli.js';
import { managedLaunchCommand, readAgentManagement, updateAgentManagement } from './management-store.js';

interface CommonManagementOptions {
  descriptor: AgentDescriptor;
  executable: string;
  versionArgs: string[];
  installCommand: string;
  updateCommand: string;
  configFiles: Array<{ path: string; format: string; description: string; writable?: boolean; sensitive?: boolean; purpose?: string }>;
  defaultFields?: AgentManagementField[];
  requirement?: () => string | null;
  authentication: () => Promise<AgentManagementState['authentication']>;
  providers?: (force: boolean) => Promise<AgentProviderState[]>;
  storedProviders?: boolean;
  update?: () => Promise<void>;
  diagnose?: (force: boolean) => Promise<AgentManagementState['diagnostics']>;
}

export function expandHome(path: string): string {
  return path === '~' ? homedir() : path.startsWith('~/') ? `${homedir()}${path.slice(1)}` : path;
}

export function commonManagement(options: CommonManagementOptions): AgentManagementPort {
  const allowedConfigFiles = () => new Set(options.configFiles.map(file => expandHome(file.path)));
  const validateConfigPath = (path: string) => {
    if (!allowedConfigFiles().has(path)) {
      throw Object.assign(Error('只能编辑该 Agent 已声明的配置文件'), { statusCode: 403 });
    }
  };
  const inspect = async (force = false): Promise<AgentManagementState> => {
    const executable = await findExecutable(options.executable);
    const versionResult = executable ? await runCli(executable, options.versionArgs) : null;
    const stored = readAgentManagement(options.descriptor.id);
    const defaults = (options.defaultFields || []).map(field => ({
      ...field,
      value: field.key === 'command'
        ? managedLaunchCommand(options.descriptor.id, String(field.value || options.descriptor.launchCommand || options.executable))
        : Object.prototype.hasOwnProperty.call(stored.defaults, field.key) ? stored.defaults[field.key] : field.value,
    }));
    const requirement = options.requirement?.() ?? null;
    const providers = options.providers ? await options.providers(force) : [];
    const storedProviders: AgentProviderState[] = stored.providers.map(provider => ({
      id: provider.id,
      name: provider.name,
      kind: provider.kind,
      enabled: provider.enabled,
      managed: true,
      status: provider.enabled ? 'unknown' : 'unavailable',
      statusText: provider.enabled ? '等待检测' : '已停用',
      authentication: { status: 'unknown', method: '由 Agent 管理' },
      models: Array.isArray(provider.fields.models) ? provider.fields.models.filter((value): value is string => typeof value === 'string') : [],
      defaultModel: typeof provider.fields.defaultModel === 'string' ? provider.fields.defaultModel : null,
      fields: Object.entries(provider.fields).map(([key, value]) => ({
        key,
        label: key,
        type: Array.isArray(value) ? 'string-list' : typeof value === 'boolean' ? 'toggle' : 'text',
        value,
      })),
    }));
    return {
      agent: options.descriptor,
      installation: {
        status: !executable ? 'unavailable' : requirement ? 'warning' : versionResult?.ok ? 'ready' : 'error',
        executable,
        version: versionResult ? firstVersion(`${versionResult.stdout}\n${versionResult.stderr}`) : null,
        latestVersion: null,
        updateAvailable: false,
        installCommand: options.installCommand,
        updateCommand: options.updateCommand,
        requirement,
      },
      authentication: executable ? await options.authentication() : {
        status: 'unknown',
        method: '未检测',
        detail: '请先安装 Agent。',
      },
      defaults,
      providers: [...providers, ...storedProviders.filter(item => !providers.some(provider => provider.id === item.id))],
      configFiles: options.configFiles.map(file => ({
        ...file, path: expandHome(file.path), exists: existsSync(expandHome(file.path)),
        writable: file.writable !== false,
        purpose: file.description,
      })),
      diagnostics: [
        {
          id: 'installation',
          status: !executable ? 'error' : requirement ? 'warning' : 'ready',
          label: 'CLI 运行环境',
          detail: !executable ? `找不到 ${options.executable}` : requirement || '命令可执行。',
        },
        ...(options.diagnose ? await options.diagnose(force) : []),
      ],
      actions: [
        { id: 'refresh', label: '重新检测', available: true },
        { id: 'update', label: '升级', kind: 'primary', confirm: `将执行 ${options.updateCommand}`, available: !!executable },
      ],
      providerManagement: {
        create: !!options.storedProviders,
        update: !!options.storedProviders,
        delete: !!options.storedProviders,
        actions: options.storedProviders ? ['enable', 'disable', 'test'] : [],
        fields: [],
      },
      applySemantics: {
        settings: 'new_session',
        providers: 'new_session',
        detail: '默认设置对新会话生效；当前会话请在对话底部的会话控制条中即时切换。',
      },
      checkedAt: new Date().toISOString(),
    };
  };

  return {
    inspect,
    update: async input => {
      updateAgentManagement(options.descriptor.id, current => ({
        ...current,
        defaults: { ...current.defaults, ...(input.defaults || {}) },
      }));
      return inspect(true);
    },
    action: async action => {
      if (action === 'update') {
        if (!options.update) throw Object.assign(Error('此 Agent 不支持平台内升级'), { statusCode: 409 });
        await options.update();
      } else if (action !== 'refresh') {
        throw Object.assign(Error(`不支持的操作: ${action}`), { statusCode: 400 });
      }
      return inspect(true);
    },
    readConfigFile: async file => {
      validateConfigPath(file.path);
      const declared = options.configFiles.find(item => expandHome(item.path) === file.path);
      if (declared?.sensitive && file.revealSensitive !== true) {
        return { path: file.path, content: '', exists: existsSync(file.path), format: file.path.endsWith('.json') ? 'JSON' : 'Text' };
      }
      try {
        return { path: file.path, content: await readFile(file.path, 'utf8'), exists: true, format: file.path.endsWith('.json') ? 'JSON' : 'Text' };
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw Object.assign(Error('无法读取配置文件'), { statusCode: 500 });
        return { path: file.path, content: '', exists: false, format: file.path.endsWith('.json') ? 'JSON' : 'Text' };
      }
    },
    writeConfigFile: async file => {
      validateConfigPath(file.path);
      if (file.expectedContent !== undefined && file.expectedContent !== null) {
        const current = existsSync(file.path) ? await readFile(file.path, 'utf8') : '';
        if (current !== file.expectedContent) {
          throw Object.assign(Error('配置文件已在磁盘上发生变化，请重新加载后再保存'), { statusCode: 409 });
        }
      }
      await mkdir(dirname(file.path), { recursive: true, mode: 0o700 });
      await writeFile(file.path, file.content, { encoding: 'utf8', mode: 0o600 });
      return { path: file.path, content: file.content, exists: true, format: file.path.endsWith('.json') ? 'JSON' : 'Text' };
    },
    createProvider: async input => {
      if (!options.storedProviders) throw Object.assign(Error('此 Agent 的 Provider 由原生配置管理'), { statusCode: 409 });
      const id = input.id?.trim();
      if (!id || !/^[a-z][a-z0-9_.-]{0,63}$/.test(id)) throw Object.assign(Error('Provider ID 无效'), { statusCode: 400 });
      updateAgentManagement(options.descriptor.id, current => {
        if (current.providers.some(provider => provider.id === id)) throw Object.assign(Error('Provider 已存在'), { statusCode: 409 });
        return {
          ...current,
          providers: [...current.providers, {
            id,
            name: input.name?.trim() || id,
            kind: input.kind?.trim() || 'custom',
            enabled: input.enabled !== false,
            fields: input.fields || {},
          }],
        };
      });
      return inspect(true);
    },
    updateProvider: async (providerId, input) => {
      if (!options.storedProviders) throw Object.assign(Error('此 Agent 的 Provider 由原生配置管理'), { statusCode: 409 });
      updateAgentManagement(options.descriptor.id, current => {
        const index = current.providers.findIndex(provider => provider.id === providerId);
        if (index < 0) throw Object.assign(Error('Provider 不存在或由原生配置管理'), { statusCode: 404 });
        const providers = [...current.providers];
        providers[index] = {
          ...providers[index],
          name: input.name?.trim() || providers[index].name,
          kind: input.kind?.trim() || providers[index].kind,
          enabled: input.enabled ?? providers[index].enabled,
          fields: { ...providers[index].fields, ...(input.fields || {}) },
        };
        return { ...current, providers };
      });
      return inspect(true);
    },
    deleteProvider: async providerId => {
      if (!options.storedProviders) throw Object.assign(Error('此 Agent 的 Provider 由原生配置管理'), { statusCode: 409 });
      updateAgentManagement(options.descriptor.id, current => {
        if (!current.providers.some(provider => provider.id === providerId)) {
          throw Object.assign(Error('Provider 不存在或由原生配置管理'), { statusCode: 404 });
        }
        return { ...current, providers: current.providers.filter(provider => provider.id !== providerId) };
      });
      return inspect(true);
    },
    providerAction: async (providerId, action) => {
      if (!options.storedProviders) throw Object.assign(Error('此 Agent 的 Provider 由原生配置管理'), { statusCode: 409 });
      if (!['enable', 'disable', 'test'].includes(action)) throw Object.assign(Error(`不支持的 Provider 操作: ${action}`), { statusCode: 400 });
      if (action !== 'test') {
        updateAgentManagement(options.descriptor.id, current => {
          if (!current.providers.some(provider => provider.id === providerId)) throw Object.assign(Error('Provider 不存在或由原生配置管理'), { statusCode: 404 });
          return {
            ...current,
            providers: current.providers.map(item => item.id === providerId ? { ...item, enabled: action === 'enable' } : item),
          };
        });
      }
      return inspect(true);
    },
  };
}
