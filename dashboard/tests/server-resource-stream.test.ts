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
});
