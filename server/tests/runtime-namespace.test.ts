import { describe, expect, it } from 'vitest';
import { runtimeNames } from '../src/services/runtime-namespace.js';

describe('concurrent installation isolation', () => {
  it('preserves production names while separating every development runtime resource', () => {
    expect(runtimeNames({})).toEqual({sessionCookie:'agentmanager_session',tmuxServer:'agentmanager',socketPrefix:'agentmanager-',pipeDirectory:'agentmanager-pipes',sandboxPrefix:'agentmanager-sandbox-'});
    const development=runtimeNames({AGENTMANAGER_RUNTIME_NAMESPACE:'platform-ai-dev'});
    const production=runtimeNames({});
    for (const key of Object.keys(production) as Array<keyof typeof production>) expect(development[key]).not.toBe(production[key]);
  });
  it('rejects names that could escape paths or interfere with tmux arguments', () => {
    for (const name of ['../../production','bad name','x'.repeat(33),'a/b']) expect(() => runtimeNames({AGENTMANAGER_RUNTIME_NAMESPACE:name})).toThrow();
  });
});
