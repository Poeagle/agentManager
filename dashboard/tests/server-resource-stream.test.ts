import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheServerResources, newestServerResources, SERVER_RESOURCE_QUERY_KEY } from '../src/lib/server-resource-cache';
import { connectStream, setQueryClient, useStreamStore } from '../src/lib/websocket';

const resources = (seconds: number) => ({ server_resources: {
  sampled_at: `2026-10-13T08:00:${String(seconds).padStart(2, '0')}.000Z`,
  hostname: 'shared-server', uptime_seconds: 100,
  cpu: { usage_percent: seconds, core_count: 4, load_average_1m: 1 }, disk: null,
  memory: { total_bytes: 1000, used_bytes: 900, available_bytes: 100, usage_percent: 90 },
} });

class FakeWebSocket {
  static OPEN = 1; static CONNECTING = 0; static CLOSED = 3; static CLOSING = 2;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { FakeWebSocket.instances.push(this); }
  close() { this.readyState = FakeWebSocket.CLOSED; this.onclose?.(); }
}

describe('shared resource stream cache', () => {
  let client: QueryClient;
  let socket: FakeWebSocket;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    client = new QueryClient();
    setQueryClient(client);
    useStreamStore.getState().clearEvents();
    connectStream();
    socket = FakeWebSocket.instances.at(-1)!;
    socket.onopen?.();
  });
  afterEach(() => {
    socket.close(); client.clear(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
  });
  it('updates native status and question counts in both session caches immediately without invalidation or refetch',()=>{
    const base={id:'s',codex_session_id:'native',agent_runtime:{state:'running',observed_at:'2026-11-03T00:00:00Z'}};
    client.setQueryData(['sessions'],{sessions:[base]});client.setQueryData(['project-sessions','p'],{sessions:[base]});
    const runtime={session_id:'native',state:'idle',pending_question_count:1,observed_at:'2026-11-03T00:00:01Z',last_activity_at:'2026-11-03T00:00:01Z'};
    const push=(runtime:unknown)=>socket.onmessage?.({data:JSON.stringify({type:'session.runtime',session_id:'s',data:JSON.stringify({runtime})})});
    push(runtime);
    for(const key of [['sessions'],['project-sessions','p']]){expect((client.getQueryData(key) as any).sessions[0].agent_runtime).toEqual(runtime);expect(client.getQueryState(key)?.isInvalidated).toBe(false);}
    push({...runtime,state:'running',observed_at:'2026-11-03T00:00:00Z'});
    expect((client.getQueryData(['sessions']) as any).sessions[0].agent_runtime.state).toBe('idle');
    push({...runtime,session_id:'old-binding',state:'running'});expect((client.getQueryData(['sessions']) as any).sessions[0].agent_runtime.state).toBe('idle');
    expect(useStreamStore.getState().events).toHaveLength(0);
  });

  it('updates the resource cache from a pushed sample without adding telemetry to session events', () => {
    const sample = resources(5);
    socket.onmessage?.({ data: JSON.stringify({ type: 'server.resources', data: JSON.stringify(sample) }) });
    expect(client.getQueryData(SERVER_RESOURCE_QUERY_KEY)).toEqual(sample);
    expect(useStreamStore.getState().events).toHaveLength(0);
  });

  it('keeps a newer pushed sample when an older message or delayed REST response arrives', () => {
    const latest = resources(10);
    cacheServerResources(client, latest);
    socket.onmessage?.({ data: JSON.stringify({ type: 'server.resources', data: JSON.stringify(resources(5)) }) });
    expect(client.getQueryData(SERVER_RESOURCE_QUERY_KEY)).toEqual(latest);
    expect(newestServerResources(latest, resources(0))).toBe(latest);
  });

  it('ignores invalid timestamps and malformed resource messages', () => {
    cacheServerResources(client, resources(5));
    socket.onmessage?.({ data: JSON.stringify({ type: 'server.resources', data: 'invalid' }) });
    const invalid = resources(10);
    invalid.server_resources.sampled_at = 'invalid';
    cacheServerResources(client, invalid);
    expect(client.getQueryData(SERVER_RESOURCE_QUERY_KEY)).toEqual(resources(5));
  });

  it('refreshes expanded project sessions on lifecycle events and keeps live state pushes free of session refetches', () => {
    client.setQueryData(['sessions'], { sessions: [] });
    client.setQueryData(['project-sessions', 'p1'], { sessions: [] });
    socket.onmessage?.({ data: JSON.stringify({ type: 'session.state', session_id: 's1', data: JSON.stringify({ processState: 'idle' }) }) });
    expect(client.getQueryState(['sessions'])?.isInvalidated).toBe(false);
    expect(client.getQueryState(['project-sessions', 'p1'])?.isInvalidated).toBe(false);
    socket.onmessage?.({ data: JSON.stringify({ type: 'session.completed', session_id: 's1' }) });
    expect(client.getQueryState(['sessions'])?.isInvalidated).toBe(true);
    expect(client.getQueryState(['project-sessions', 'p1'])?.isInvalidated).toBe(true);
  });

  it('applies deletion results to their own project and refreshes lists only when that project drains', () => {
    const firstProject = Array.from({ length: 26 }, (_, index) => ({ id: `a-${index}`, record_deletion: 'pending' }));
    const secondProject = Array.from({ length: 33 }, (_, index) => ({ id: `b-${index}` }));
    client.setQueryData(['sessions'], { sessions: [...firstProject, ...secondProject] });
    client.setQueryData(['project-sessions', 'a'], { sessions: firstProject });
    client.setQueryData(['project-sessions', 'b'], { sessions: secondProject });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const complete = (id: string, state: 'deleted' | 'failed', projectPending: boolean) => socket.onmessage?.({
      data: JSON.stringify({ type: 'session.record-deletion', session_id: id, project_id: 'a',
        data: JSON.stringify({ state, project_pending: projectPending }) }),
    });

    complete('a-0', 'failed', true);
    for (const row of firstProject.slice(1, -1)) complete(row.id, 'deleted', true);
    expect(invalidate).not.toHaveBeenCalled();
    expect(client.getQueryData(['project-sessions', 'a'])).toEqual({ sessions: [{ id: 'a-0', record_deletion: 'failed' }, firstProject.at(-1)] });
    expect(client.getQueryData(['project-sessions', 'b'])).toEqual({ sessions: secondProject });
    complete('a-25', 'deleted', false);
    expect(client.getQueryData(['sessions'])).toEqual({ sessions: [{ id: 'a-0', record_deletion: 'failed' }, ...secondProject] });
    expect(invalidate.mock.calls.map(([filter]) => filter?.queryKey)).toEqual([['project-sessions', 'a'], ['sessions'], ['admin-monitor']]);
  });

  it('cancels an older list response that could put a deleted row back', async () => {
    const key = ['project-sessions', 'project'];
    const oldList = { sessions: [{ id: 'deleted' }] };
    client.setQueryData(key, oldList);
    let finish!: (list: typeof oldList) => void;
    let signal: AbortSignal | undefined;
    const fetching = client.fetchQuery({ queryKey: key, queryFn: (context) => {
      signal = context.signal;
      return new Promise<typeof oldList>(resolve => { finish = resolve; });
    } }).catch(() => undefined);
    socket.onmessage?.({ data: JSON.stringify({ type: 'session.record-deletion', session_id: 'deleted', project_id: 'project',
      data: JSON.stringify({ state: 'deleted', project_pending: true }) }) });
    finish(oldList);
    await fetching;
    expect(signal?.aborted).toBe(true);
    expect(client.getQueryData(key)).toEqual({ sessions: [] });
  });
});
