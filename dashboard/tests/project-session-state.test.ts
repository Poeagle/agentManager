import { describe, expect, it } from 'vitest';
import {
  reconcileHydratedTerminalInstances, nextDefaultTabName, uniqueTabName, automaticSessionTabName,
} from '../src/lib/project-session-state';

it('avoids existing displayed names when creating or renaming tabs', () => {
  const tabs = [{id:'a',label:'Session 2'}, {id:'b',label:'Session 3',customLabel:'session 1'}, {id:'c',label:'other',customLabel:'Session 2 (2)'}];
  expect(nextDefaultTabName('Session', tabs)).toBe('Session 3');
  expect(uniqueTabName('Session 2', tabs, 'b')).toBe('Session 2 (3)');
  expect(uniqueTabName('Session 2', tabs, 'a')).toBe('Session 2');
});

it('names automatic session tabs from the first task instead of a generic ordinal', () => {
  const tabs = [{id:'a',label:'Session 1'},{id:'b',label:'介绍一下这个项目'}];
  expect(automaticSessionTabName('介绍一下这个项目',tabs,'c')).toBe('介绍一下这个项目 (2)');
  expect(automaticSessionTabName('  检查\n\n构建  ',tabs,'c')).toBe('检查 构建');
  expect(automaticSessionTabName('Terminal',tabs,'c')).toBeNull();
  expect(automaticSessionTabName('',tabs,'c')).toBeNull();
});

describe('project terminal state hydration', () => {
  it('does not resurrect ended tabs that exist only in stale localStorage', () => {
    const local = [
      { id: 'monitor', label: 'Terminal 1', customLabel: '监控与告警' },
      { id: 'jira', label: 'Terminal 2', customLabel: 'jira' },
      { id: 'logs', label: 'Terminal 3', customLabel: '日志' },
      { id: 'old-claude-1', label: 'Session 1' },
      { id: 'old-claude-2', label: 'Session 2' },
    ];
    const server = local.slice(0, 3);

    expect(
      reconcileHydratedTerminalInstances(
        local,
        server,
        new Set(),
        new Set(['monitor', 'jira', 'logs']),
      ),
    ).toEqual(server);
  });

  it('retains a live or just-created local tab that has not been persisted yet', () => {
    const server = [{ id: 'saved', label: 'Session 1' }];
    const liveLocal = { id: 'live-local', label: 'Session 2' };

    expect(
      reconcileHydratedTerminalInstances(
        [...server, liveLocal, { id: 'ended-local', label: 'Session 3' }],
        server,
        new Set(),
        new Set([liveLocal.id]),
      ),
    ).toEqual([...server, liveLocal]);
  });

  it('honours hidden-session tombstones while preserving local custom labels', () => {
    expect(
      reconcileHydratedTerminalInstances(
        [
          { id: 'open', label: 'Session 1', customLabel: 'My work' },
          { id: 'hidden', label: 'Session 2' },
        ],
        [
          { id: 'open', label: 'Old label' },
          { id: 'hidden', label: 'Session 2' },
        ],
        new Set(['hidden']),
        new Set(),
      ),
    ).toEqual([{ id: 'open', label: 'Session 1', customLabel: 'My work' }]);
  });

});
