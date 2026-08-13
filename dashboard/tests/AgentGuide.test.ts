import { describe, expect, it } from 'vitest';
import { generateGuide } from '../src/components/AgentGuide';
import type { AgentApiContract } from '../src/lib/api';

const contract: AgentApiContract = {
  name: 'AgentManager Agent API',
  version: '9.9.9',
  updatedAt: '2026-08-13',
  scope: 'Test scope',
  description: 'Live test contract',
  authentication: {
    type: 'HttpOnly session cookie',
    cookieName: 'agentmanager_session',
    loginEndpoint: '/api/custom-login',
    capabilitiesEndpoint: '/api/agent/capabilities',
    login: 'Authenticate using the current login endpoint.',
    usage: 'Reuse the cookie.',
    errors: { 401: 'Not authenticated' },
    security: 'Keep it private.',
  },
  authorization: { sessions: 'Own sessions only.' },
  critical: ['Use the live contract.'],
  quickstart: ['1. Read capabilities', '2. Call the dynamic endpoint'],
  stateMachine: {
    states: { idle: 'Ready' },
    transitions: [],
  },
  promptTypes: { text: 'Free-form input' },
  endpoints: [{
    category: 'Dynamic',
    method: 'PATCH',
    path: '/api/new-feature',
    description: 'Added by the backend contract.',
    request: { enabled: { type: 'boolean', required: true } },
  }],
  tips: ['Keep polling.'],
  operationalGuidance: {},
};

describe('Agent guide generation', () => {
  it('renders endpoint and authentication data from the supplied backend contract', () => {
    const guide = generateGuide(contract, 'https://agent.example');

    expect(guide).toContain('Contract version: 9.9.9');
    expect(guide).toContain('https://agent.example/api/custom-login');
    expect(guide).toContain('PATCH  /api/new-feature — Added by the backend contract.');
    expect(guide).toContain('Request: {"enabled":{"type":"boolean","required":true}}');
  });
});
