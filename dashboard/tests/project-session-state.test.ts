import { describe, expect, it } from 'vitest';
import {
  reconcileHydratedTerminalInstances,
} from '../src/lib/project-session-state';

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
