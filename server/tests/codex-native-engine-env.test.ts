import { describe, expect, it } from 'vitest';
import { nativeEngineApiKeyEnv } from '../src/services/agents/codex/native-engine.js';

/**
 * Regression: saving the native Provider form rewrites its CODEX_HOME
 * config.toml with `env_key = "AGENTMANAGER_PROVIDER_API_KEY"`, while the
 * AgentManager-managed Engine used to export only AGENTMANAGER_CODEX_API_KEY.
 * Codex then failed every model call with "Missing environment variable:
 * AGENTMANAGER_PROVIDER_API_KEY". The Engine must satisfy both names.
 */
describe('native Codex Engine credential environment', () => {
  it('exposes a stored key under both names config.toml may reference', () => {
    const env = nativeEngineApiKeyEnv('sk-native-test');
    expect(env.AGENTMANAGER_CODEX_API_KEY).toBe('sk-native-test');
    expect(env.AGENTMANAGER_PROVIDER_API_KEY).toBe('sk-native-test');
  });

  it('adds no credential variable when no key is stored', () => {
    expect(nativeEngineApiKeyEnv('')).toEqual({});
  });
});
