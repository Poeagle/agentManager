import { createHash } from 'node:crypto';
import { allCodexEnvironments } from './environments.js';
import { canControlEnvironment, canUseEnvironment } from '../environment-access.js';
import { readEngineModelsForEnvironment } from './controls.js';
import { cachedAccountStatus } from './account-status.js';
import type { AgentCollaborationEnvironment, AgentCollaborationSelection } from '../types.js';

export async function codexCollaborationOptions(userId: string, _projectId: string, includeQuota: boolean, environmentId: string): Promise<AgentCollaborationEnvironment[]> {
  const environments = allCodexEnvironments().filter(env => env.id === environmentId && env.enabled && canUseEnvironment('codex', env.id, userId));
  const options: AgentCollaborationEnvironment[] = [];
  for (const env of environments) {
    const canConfigure = canControlEnvironment(env.id, userId);
    const models = canConfigure ? await readEngineModelsForEnvironment(env.id).catch(() => []) : [];
    let quota;
    if (includeQuota) {
      if (env.kind === 'provider') quota = { status: 'not_applicable', windows: [] };
      else if (!canConfigure) quota = { status: 'restricted', windows: [] };
      else {
        const account = cachedAccountStatus(env.id, env);
        const email: unknown = account.account?.email;
        const group = typeof email === 'string' && email ? createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 16) : null;
        const windows = (account.windows as Array<{ usedPercent: number; windowDurationMins: number | null; resetsAt: number | null }>).map(window => ({
          remaining_percent: Math.min(100, Math.max(0, 100 - window.usedPercent)),
          duration_minutes: window.windowDurationMins,
          resets_at: window.resetsAt !== null && Number.isFinite(window.resetsAt) ? new Date(window.resetsAt * 1000).toISOString() : null,
        }));
        quota = { status: account.reason === 'not_applicable' ? 'not_applicable' : account.stale ? 'stale' : windows.length ? 'available' : 'unknown',
          observed_at: account.checked_at, group_id: group, windows };
      }
    }
    options.push({ agent_id: 'codex', environment_id: env.id, name: env.name, quota,
      status: canConfigure ? 'available' : 'default_only',
      models: models.map(model => ({ model_id: model.model, reasoning_efforts: model.efforts.map(effort => effort.value),
        default_reasoning_effort: model.defaultEffort, service_tiers: ['default', ...(model.service_tiers || []).map(tier => tier.id).filter(id => id !== 'default')] })) });
  }
  return options;
}

export async function validateCodexCollaborationLaunch(userId: string, _projectId: string, selection: AgentCollaborationSelection) {
  if (selection.model_id === undefined) return { error: '指定推理强度或速度时也需要指定模型' };
  const environment = selection.environment_id || 'native';
  if (!canUseEnvironment('codex', environment, userId) || !canControlEnvironment(environment, userId)) return { error: '当前身份无法配置该 Codex 环境' };
  const models = await readEngineModelsForEnvironment(environment).catch(() => []);
  const model = models.find(item => item.model === selection.model_id);
  if (!model) return { error: '所选 Codex 模型不可用' };
  const effort = selection.reasoning_effort ?? model.defaultEffort;
  if (!model.efforts.some(item => item.value === effort)) return { error: '所选模型不支持该推理强度' };
  if (selection.service_tier && selection.service_tier !== 'default' && !model.service_tiers?.some(tier => tier.id === selection.service_tier))
    return { error: '所选模型不支持该速度档位' };
  return { preference: { model: model.model, effort, provider: model.provider, service_tier: selection.service_tier || undefined } };
}
