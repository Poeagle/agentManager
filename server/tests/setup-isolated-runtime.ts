import { beforeEach } from 'vitest';

/** Tests inherit the invoking Codex/tmux process environment. Never allow a
 * nested server under test to listen on the developer instance's socket or
 * reuse its persistent CODEX_HOME. Individual tests opt in with vi.stubEnv. */
const RUNTIME_KEYS = [
  'AGENTMANAGER_CODEX_STREAM_SOCKET',
  'AGENTMANAGER_CODEX_PROVIDER_ENGINES',
  'AGENTMANAGER_RUNTIME_NAMESPACE',
  'CODEX_HOME',
] as const;

beforeEach(() => {
  for (const key of RUNTIME_KEYS) delete process.env[key];
});
