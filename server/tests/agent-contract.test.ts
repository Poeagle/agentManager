import { describe, expect, it } from 'vitest';
import { getAgentApiContract } from '../src/routes/agent.js';

describe('Agent API contract', () => {
  it('documents the current supported automation surface without duplicate endpoints', () => {
    const contract = getAgentApiContract();
    const keys = contract.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`);

    expect(new Set(keys).size).toBe(keys.length);
    expect(contract.version).toBe('2.1.0');
    expect(contract.scope).toContain('scheduled tasks');

    expect(keys).toEqual(expect.arrayContaining([
      'GET /api/agent/capabilities',
      'GET /api/projects',
      'POST /api/sessions',
      'DELETE /api/sessions/:id',
      'POST /api/sessions/:id/resume',
      'GET /api/sessions/:id/display',
      'POST /api/sessions/:id/execute',
      'GET /api/context',
      'WS /api/sessions/:id/agent',
      'POST /api/prompt-enhancer/enhance',
      'GET /api/scheduled-tasks?project_id=:projectId',
      'POST /api/scheduled-tasks',
      'PATCH /api/scheduled-tasks/:id',
      'DELETE /api/scheduled-tasks/:id',
      'POST /api/scheduled-tasks/:id/run',
      'GET /api/codex-quota',
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
    expect(scheduledCreate?.request).toHaveProperty('daily_stop_time');
    expect(scheduledCreate?.request).toHaveProperty('quota_remaining_below');
  });
});
