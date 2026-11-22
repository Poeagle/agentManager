import { expect, it } from 'vitest';

it('does not inherit the developer runtime socket or Codex home', () => {
  expect(process.env.AGENTMANAGER_CODEX_STREAM_SOCKET).toBeUndefined();
  expect(process.env.AGENTMANAGER_CODEX_PROVIDER_ENGINES).toBeUndefined();
  expect(process.env.AGENTMANAGER_RUNTIME_NAMESPACE).toBeUndefined();
  expect(process.env.CODEX_HOME).toBeUndefined();
});
