import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestDatabase } from './helpers/database.js';
import { updateAgentManagement } from '../src/services/agents/management-store.js';
import { managedCodexEngines } from '../src/services/agents/codex/provider-config.js';

/**
 * Regression: the stored Provider list may still contain a record for the
 * platform-managed native Provider. Exposing it as a stored-Provider Engine made
 * AgentManager start a second app-server on codex-providers/native.sock and list
 * "xd-gpt" twice. Only real stored Providers may own an Engine route.
 */
let database: { cleanup: () => void } | null = null;

beforeEach(() => {
  database = createTestDatabase();
  updateAgentManagement('codex', current => ({
    ...current,
    providers: [
      { id: 'native', name: 'xd-gpt', kind: 'native', enabled: true, fields: { models: ['gpt-6.2-sol'] } },
      { id: 'xindu', name: 'xindu', kind: 'responses', enabled: true, fields: { models: ['claude-sonnet-5-5'] } },
    ],
  }) as typeof current);
});

afterEach(() => {
  database?.cleanup();
  database = null;
});

it('does not expose the platform-managed native Provider as a stored Provider Engine', () => {
  expect(managedCodexEngines().map(engine => engine.provider)).toEqual(['xindu']);
});
