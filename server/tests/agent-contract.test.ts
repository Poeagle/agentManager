import { describe, expect, it } from 'vitest';
import { getAgentApiContract } from '../src/routes/agent.js';

describe('Agent API contract', () => {
  it('documents the current supported automation surface without duplicate endpoints', () => {
    const contract = getAgentApiContract();
    const keys = contract.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`);

    expect(new Set(keys).size).toBe(keys.length);
    expect(contract.version).toBe('3.33.0');
    for (const path of ['/api/sessions','/api/sessions/:id']) {
      expect(contract.endpoints.find(endpoint=>endpoint.method==='GET'&&endpoint.path===path)?.description).toContain('record_deletion');
    }
    expect(contract.endpoints.find(e=>e.path==='/api/files/upload')?.description).toContain('maximum 500 MiB');
    expect(contract.endpoints.find(e=>e.path==='/api/sessions/:id/input')?.request?.attachments?.description).toContain('500 MiB');
    expect(contract.endpoints.find(e=>e.path==='/api/sessions/:id/controls')?.response).toMatchObject({models:expect.stringContaining('reference_only')});
    expect(contract.endpoints.find(e=>e.path==='/api/sessions/:id/controls')?.response?.models).toContain('provider_multiplier');
    expect(contract.endpoints.find(e=>e.path==='/api/sessions/:id/conversation')?.description).toContain('verified project attachment references');
    expect(contract.endpoints.find(e=>e.path==='/api/sessions/:id/conversation')?.description).toContain('visible thinking fragments');
    expect(contract.endpoints.find(e=>e.path==='/api/sessions/:id/conversation/stream')?.description).toContain('error.code=rate_limit');
    expect(contract.endpoints.find(e=>e.path==='/api/sessions/:id/new-conversation')?.description).toContain('environment_id');
    expect(contract.endpoints.find(e=>e.path==='/api/sessions/:id/new-conversation')?.request).toHaveProperty('environment_id');
    expect(contract.endpoints.find(e=>e.path==='/api/sessions/:id/new-conversation')?.response).toHaveProperty('previous_conversation_deletion');
    expect(contract.endpoints.find(e=>e.path==='/api/sessions/:id/conversation/metadata')?.description).toContain('decreases in recorded cached input tokens');
    expect(contract.endpoints.find(e=>e.path==='/api/sessions/:id/conversation/usage-intervals')?.description).toContain('kind=item with phase=final');
    expect(contract.endpoints.find(e=>e.path==='/api/sessions/:id/conversation/stream')?.description).toContain('last_request_at');
    expect(contract.endpoints.find(e=>e.path==='/api/sessions/:id/conversation/stream')?.description).toContain('progress_statistics.step');
    expect(contract.endpoints.find(e=>e.path==='/api/sessions/:id/conversation/stream')?.description).toContain('cost estimate');
    expect(contract.endpoints.find(e=>e.path==='/api/sessions/:id/conversation/stream')?.description).toContain('cost.breakdown');
    expect(contract.endpoints.find(e=>e.path==='/api/sessions/:id/conversation/stream')?.description).toContain('after_message_id');
    expect(contract.endpoints.find(e=>e.path==='/api/sessions/:id/input')?.request?.batch?.description).toContain('client_id');
    expect(contract.endpoints.find(e=>e.path==='/api/sessions/:id/input')?.request?.attachments?.description).toContain('outside project/Git');
    expect(contract.endpoints.find(e=>e.path==='/api/sessions/:id/input-check')).toMatchObject({
      method:'POST',description:expect.stringContaining('selected Provider identities'),response:{required_action:expect.any(String),switch_account:expect.stringContaining('confirmed zero remaining quota'),target_account:expect.any(String),account_remaining_percent:expect.any(String),cache_miss_estimate:expect.stringContaining('ordinary input rate'),token:expect.stringContaining('null')},
    });
    expect(contract.endpoints.find(e=>e.path==='/api/sessions/:id/compact')?.request).toHaveProperty('expected_native_id');
    expect(contract.endpoints.find(e=>e.path==='/api/sessions/:id/input')?.request).toHaveProperty('guard_token');
    expect(contract.endpoints.find(e=>e.path==='/api/sessions/:id/input')?.request).toHaveProperty('expected_native_id');
    expect(contract.endpoints.find(e=>e.path==='/api/sessions/:id/input')?.request).toHaveProperty('expected_environment_id');
    expect(contract.scope).toContain('scheduled tasks');
    expect(contract.endpoints.find(e=>e.path==='/api/codex-quota')?.description).toContain('refresh=true only rereads this cache');
    expect(contract.endpoints.find(endpoint=>endpoint.path==='/api/sessions/:id/input')?.request?.client_id?.description).toContain('409');

    expect(keys).toEqual(expect.arrayContaining([
      'GET /api/agent/capabilities',
      'GET /api/projects',
      'POST /api/files/upload-directory',
      'POST /api/files/upload',
      'POST /api/sessions',
      'DELETE /api/sessions/:id',
      'POST /api/sessions/:id/resume',
      'GET /api/sessions/:id/display',
      'GET /api/sessions/:id/controls',
      'PUT /api/sessions/:id/controls',
      'GET /api/sessions/:id/conversation/metadata',
      'GET /api/sessions/:id/conversation/usage-intervals',
      'GET /api/sessions/:id/completed-turn',
      'POST /api/sessions/:id/execute',
      'POST /api/sessions/:id/input',
      'POST /api/sessions/:id/conversation/stop',
      'GET /api/context',
      'WS /api/sessions/:id/agent',
      'WS /api/sessions/:id/conversation/stream',
      'POST /api/prompt-enhancer/enhance',
      'GET /api/scheduled-tasks?project_id=:projectId',
      'POST /api/scheduled-tasks',
      'PATCH /api/scheduled-tasks/:id',
      'DELETE /api/scheduled-tasks/:id',
      'POST /api/scheduled-tasks/:id/run',
      'GET /api/codex-quota',
      'GET /api/codex/environments',
      'GET /api/scheduled-tasks/codex-models?project_id=:projectId&environment_id=:environmentId',
    ]));
  });

  it('states creator-only kill and user-owned schedule boundaries', () => {
    const contract = getAgentApiContract();
    const kill = contract.endpoints.find((endpoint) => endpoint.method === 'DELETE' && endpoint.path === '/api/sessions/:id');
    const scheduledCreate = contract.endpoints.find((endpoint) => endpoint.method === 'POST' && endpoint.path === '/api/scheduled-tasks');

    expect(kill?.description).toContain('creator-only');
    expect(kill?.description).toContain("cannot kill another user's session");
    expect(contract.authorization.sessions).toContain('may kill only a session created by the logged-in user');
    expect(scheduledCreate?.description).toContain("user's open tabs");
    expect(scheduledCreate?.request).toHaveProperty('new_environment_id');
    expect(scheduledCreate?.request).toHaveProperty('new_model_preference');
    expect(contract.authentication.usage).toContain('API Key');
    expect(contract.endpoints.find(e=>e.path==='/api/prompt-enhancer/enhance')?.request).toHaveProperty('attachments');
    expect(scheduledCreate?.request).toHaveProperty('daily_stop_time');
    expect(scheduledCreate?.request).toHaveProperty('daily_start_time');
    expect(scheduledCreate?.request).toHaveProperty('daily_end_time');
    expect(scheduledCreate?.request).toHaveProperty('quota_remaining_below');
    expect(scheduledCreate?.request).toHaveProperty('start_conditions');
    expect(scheduledCreate?.request).toHaveProperty('daily_stop_conditions');
    expect(scheduledCreate?.request?.condition_unmet_policy.default).toBe('skip');
    expect(contract.endpoints.find(e=>e.path==='/api/scheduled-tasks/:id/run')?.description).toContain('brief context');
  });
});
