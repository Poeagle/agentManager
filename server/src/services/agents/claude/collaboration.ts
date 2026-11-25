import { canUseClaudeEnvironment, claudeEnvironmentId, claudeProviderModelsForEnvironment, enabledClaudeProviders } from './providers.js';
import { canUseEnvironment } from '../environment-access.js';
import type { AgentCollaborationEnvironment, AgentCollaborationSelection } from '../types.js';

export async function claudeCollaborationOptions(userId: string, _projectId: string, includeQuota: boolean, environmentId: string): Promise<AgentCollaborationEnvironment[]> {
  const environments = [{ id: 'anthropic', name: 'Anthropic 原生' },
    ...enabledClaudeProviders().filter(provider => provider.id !== 'anthropic').map(provider => ({ id: `claude-provider:${provider.id}`, name: provider.name }))];
  return environments.filter(env => claudeEnvironmentId(env.id) === environmentId && canUseEnvironment('claude', env.id, userId)).map(env => ({
    agent_id: 'claude', environment_id: environmentId, name: env.name,
    models: claudeProviderModelsForEnvironment(env.id).map(id => ({ model_id: id, reasoning_efforts: [], service_tiers: [] })),
    quota: includeQuota ? { status: 'unknown', windows: [] } : undefined,
  }));
}

export async function validateClaudeCollaborationLaunch(userId: string, _projectId: string, selection: AgentCollaborationSelection) {
  const environment = selection.environment_id || 'anthropic';
  if (!canUseClaudeEnvironment(claudeEnvironmentId(environment), userId)) return { error: '当前身份无法使用该 Claude 环境' };
  if (selection.reasoning_effort || selection.service_tier) return { error: '当前 Claude 适配器未提供独立推理强度和速度档位' };
  const model = selection.model_id;
  return model && claudeProviderModelsForEnvironment(environment).includes(model)
    ? { preference: { model, effort: '' } }
    : { error: '所选 Claude 模型不可用' };
}
