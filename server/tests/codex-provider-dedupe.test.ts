import { describe, expect, it } from 'vitest';
import { uniqueProviderStates } from '../src/services/agents/codex/management.js';
import type { AgentProviderState } from '../src/services/agents/types.js';

/**
 * Regression: a stored Codex Provider whose id repeats a platform-managed one
 * (native) was listed as a second "xd-gpt" row. Both rows shared an id, so the
 * edit dialog always targeted the first match. The merge must keep one row per
 * id and let the managed view win.
 */
function provider(id: string, statusText: string): AgentProviderState {
  return { id, name: id, kind: 'native', enabled: true, managed: true, status: 'ready', statusText, fields: [] } as unknown as AgentProviderState;
}

describe('Codex Provider list merge', () => {
  it('keeps one row per id and prefers the platform-managed native view', () => {
    const list = uniqueProviderStates([
      provider('native', 'Engine 运行中 · PID 1 · 由 AgentManager 管理'),
      provider('xindu', '独立 Engine 运行中 · PID 2'),
      provider('native', '独立 Engine 运行中 · PID 3'),
      provider('ds', '独立 Engine 运行中 · PID 4'),
    ]);
    expect(list.map(item => item.id)).toEqual(['native', 'xindu', 'ds']);
    expect(list[0].statusText).toContain('由 AgentManager 管理');
  });

  it('preserves order when ids are already unique', () => {
    const list = uniqueProviderStates([provider('a', ''), provider('b', '')]);
    expect(list.map(item => item.id)).toEqual(['a', 'b']);
  });
});
