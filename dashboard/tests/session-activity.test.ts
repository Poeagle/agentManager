import { describe, expect, it } from 'vitest';
import { formatActivityAge, sessionActivityMs } from '../src/lib/session-activity-model';
import type { Session } from '../src/lib/api';
import { useStreamStore } from '../src/lib/websocket';
import {signalForSession} from '../src/lib/session-signal-model';

describe('session activity time', () => {
  it('uses only Codex native activity and state even if the terminal reports newer activity or becomes idle',()=>{
    const session={id:'codex',project_id:'p',task:'Work',status:'running',pid:null,started_at:null,completed_at:null,exit_code:null,created_at:'2099-01-01T00:00:00Z',cli_type:'codex',
      last_activity_at:'2099-01-01T00:00:00Z',processState:'idle',agent_runtime:{source:'codex_rollout',session_id:'native',state:'running',last_activity_at:'2026-10-29T10:00:00Z',observed_at:'2026-10-29T11:00:00Z',reason:'native'}} satisfies Session;
    expect(sessionActivityMs(session,Date.parse('2099-01-01T00:00:00Z'))).toBe(Date.parse('2026-10-29T10:00:00Z'));
    expect(signalForSession(session,{codex:{processState:'idle',promptType:null,isPermission:false,at:1}})?.title).toBe('Codex 运行中 · 原生执行记录');
    expect(sessionActivityMs({...session,agent_runtime:undefined})).toBeNull();
    expect(signalForSession({...session,agent_runtime:undefined},{})?.title).toBe('Codex 原生状态未知');
  });
  it('formats compact relative ages for tab labels', () => {
    const now = Date.UTC(2026, 7, 5, 12, 0, 0);
    expect(formatActivityAge(now - 20_000, now)).toBe('刚刚');
    expect(formatActivityAge(now - 5 * 60_000, now)).toBe('5分');
    expect(formatActivityAge(now - 3 * 60 * 60_000, now)).toBe('3时');
    expect(formatActivityAge(now - 4 * 24 * 60 * 60_000, now)).toBe('4天');
  });

  it('prefers newer live activity over the durable API timestamp', () => {
    const session = {
      id: 'session-1',
      project_id: 'project-1',
      task: 'Terminal',
      status: 'running',
      pid: null,
      started_at: null,
      completed_at: null,
      exit_code: null,
      created_at: '2026-08-05T10:00:00.000Z',
      last_activity_at: '2026-08-05T11:00:00.000Z',
    } satisfies Session;
    expect(sessionActivityMs(session, Date.parse('2026-08-05T11:30:00.000Z')))
      .toBe(Date.parse('2026-08-05T11:30:00.000Z'));
  });

  it('does not let an older stream event move activity backwards', () => {
    useStreamStore.setState({ activityAt: {} });
    useStreamStore.getState().setActivity('session-1', 2000);
    useStreamStore.getState().setActivity('session-1', 1000);
    expect(useStreamStore.getState().activityAt['session-1']).toBe(2000);
  });
});
