import { describe, expect, it } from 'vitest';
import { formatActivityAge, sessionActivityMs } from '../src/lib/session-activity-model';
import type { Session } from '../src/lib/api';
import { useStreamStore } from '../src/lib/websocket';
import {signalForSession,rollupSignal} from '../src/lib/session-signal-model';

describe('session activity time', () => {
  it('shows a fresh conversation as ready while retaining grey for interrupted or missing native state',()=>{
    const session={id:'new',cli_type:'codex',agent_runtime:{state:'ready'}} as Session;
    expect(signalForSession(session,{})).toMatchObject({color:'#22c55e',title:'Codex 新会话已就绪 · 等待输入'});
    expect(signalForSession({...session,agent_runtime:{...session.agent_runtime!,state:'interrupted'}},{})).toMatchObject({color:'#6b7280',title:'Codex 本轮已中断'});
  });
  it('shows unanswered async questions as yellow attention without falsifying the native execution state',()=>{
    const session={id:'q',cli_type:'codex',status:'running',agent_runtime:{state:'idle',pending_question_count:1}} as Session;
    const yellow=signalForSession(session,{});
    expect(yellow).toMatchObject({color:'#eab308',attention:true,title:'有 1 个问题待回答 · 本轮已结束'});
    const working={...session,agent_runtime:{...session.agent_runtime!,state:'running' as const}};
    expect(signalForSession(working,{})?.title).toContain('Agent 仍在执行');
    expect(working.agent_runtime.state).toBe('running');
    expect(signalForSession({...session,agent_runtime:{...session.agent_runtime!,pending_question_count:0}},{})).toMatchObject({color:'#22c55e',attention:false});
    const blue=signalForSession({...working,agent_runtime:{...working.agent_runtime,pending_question_count:0}},{});
    expect(rollupSignal([blue,yellow])?.color).toBe('#eab308');
  });
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
