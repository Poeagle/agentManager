import { getDb } from '../../db/index.js';
import { z } from 'zod';
import type { AgentControls, AgentDescriptor, ModelPreference } from './types.js';
const key = (id: string) => `session-control:${id}`;
export function readModelPreference(userId: string, sessionId: string): ModelPreference | null {
    const row = getDb().prepare('SELECT value FROM user_ui_state WHERE user_id=? AND key=?').get(userId, key(sessionId)) as {
        value: string;
    } | undefined;
    try {
        const value = JSON.parse(row?.value || 'null');
        return value && typeof value.model === 'string' && typeof value.effort === 'string' ? { model: value.model, effort: value.effort, ...(typeof value.provider === 'string' ? {provider:value.provider} : {}), ...(typeof value.service_tier === 'string' ? {service_tier:value.service_tier} : {}) } : null;
    }
    catch {
        return null;
    }
}
export function saveModelPreference(userId: string, sessionId: string, value: ModelPreference | null, submittedAt?: string) {
    if (!value) {
        getDb().prepare('DELETE FROM user_ui_state WHERE user_id=? AND key=?').run(userId, key(sessionId));
        return;
    }
    getDb().prepare("INSERT INTO user_ui_state(user_id,key,value,updated_at) VALUES(?,?,?,datetime('now')) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(userId, key(sessionId), JSON.stringify({ ...value, ...submittedAt ? { submitted_at: submittedAt } : {} }));
}
export function modelPreferenceSubmittedAt(userId: string, sessionId: string): string | null {
    const row = getDb().prepare('SELECT value FROM user_ui_state WHERE user_id=? AND key=?').get(userId, key(sessionId)) as {
        value: string;
    } | undefined;
    try {
        const value = JSON.parse(row?.value || 'null');
        return typeof value?.submitted_at === 'string' ? value.submitted_at : null;
    }
    catch {
        return null;
    }
}

export const executionSettingsPatch = z.object({
    model_id: z.string().trim().min(1).max(160).optional(),
    reasoning_effort: z.string().trim().min(1).max(50).optional(),
    service_tier: z.string().trim().min(1).max(50).optional(),
}).strict().refine(value => Object.values(value).some(field => field !== undefined));

export const inPlaceControlUpdate = z.object({
    execution: executionSettingsPatch,
    expected_native_id: z.string().min(1).max(2048),
    expected_environment_id: z.string().min(1).max(2048),
}).strict();

export function inPlaceModelChoices(controls: AgentControls) {
    return controls.models.filter(model => !model.provider || model.provider === controls.provider);
}

export function mergeExecutionSettings(
    controls: AgentControls,
    capabilities: AgentDescriptor['capabilities'],
    patch: z.infer<typeof executionSettingsPatch>,
    pending: ModelPreference | null,
): ModelPreference {
    const base = pending && (!pending.provider || pending.provider === controls.provider) ? pending : null;
    const model = inPlaceModelChoices(controls).find(item => item.model === (patch.model_id ?? base?.model ?? controls.model));
    if (!model) throw Error('当前绑定下没有可用的目标模型，请先查询标签页设置');
    const currentEffort = base?.effort ?? controls.effort;
    const effort = patch.reasoning_effort ?? model.efforts.find(item => item.value === currentEffort)?.value ?? model.defaultEffort;
    if (!model.efforts.some(item => item.value === effort)) throw Error('当前模型不支持所选推理强度');
    const tier = patch.service_tier ?? base?.service_tier;
    const retainedTier = tier ?? controls.service_tier;
    if (capabilities.serviceTier && retainedTier && retainedTier !== 'default' &&
        !model.service_tiers?.some(item => item.id === retainedTier)) {
        throw Error('目标模型不支持此服务档位；请从可用档位选择，或显式指定 default');
    }
    return { model: model.model, effort, ...(model.provider ? { provider: model.provider } : {}),
        ...(tier !== undefined ? { service_tier: tier } : {}) };
}
