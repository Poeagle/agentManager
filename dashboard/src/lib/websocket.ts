import { create } from 'zustand';
import type { QueryClient } from '@tanstack/react-query';
import type { Event } from './api';

let queryClientRef: QueryClient | null = null;

export function setQueryClient(qc: QueryClient) {
  queryClientRef = qc;
}

export interface LiveSessionState {
  processState: 'busy' | 'idle' | 'waiting_for_input';
  promptType: 'choice' | 'confirmation' | 'text' | null;
  isPermission: boolean;
  at: number;
}

interface StreamState {
  events: Event[];
  connected: boolean;
  // Live per-session process-state, pushed via the `session.state` stream message.
  // Drives the tab signal lights without polling or refetching the sessions list.
  liveStates: Record<string, LiveSessionState>;
  addEvent: (event: Event) => void;
  setLiveState: (sessionId: string, state: LiveSessionState) => void;
  setConnected: (connected: boolean) => void;
  clearEvents: () => void;
}

export const useStreamStore = create<StreamState>((set) => ({
  events: [],
  connected: false,
  liveStates: {},
  addEvent: (event) =>
    set((state) => ({
      events: [event, ...state.events].slice(0, 500), // Keep last 500
    })),
  setLiveState: (sessionId, live) =>
    set((state) => ({
      liveStates: { ...state.liveStates, [sessionId]: live },
    })),
  setConnected: (connected) => set({ connected }),
  clearEvents: () => set({ events: [] }),
}));

let ws: WebSocket | null = null;

export function connectStream() {
  if (ws) return;

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${window.location.host}/api/stream`;

  ws = new WebSocket(url);

  ws.onopen = () => {
    useStreamStore.getState().setConnected(true);
  };

  ws.onmessage = (msg) => {
    try {
      const event = JSON.parse(msg.data);

      // Live process-state: update the per-session map directly. This is a
      // high-frequency, ephemeral signal — keep it out of the event feed and
      // don't trigger a sessions refetch.
      if (event.type === 'session.state') {
        if (event.session_id) {
          let d: any = {};
          try { d = event.data ? JSON.parse(event.data) : {}; } catch {}
          if (d.processState) {
            useStreamStore.getState().setLiveState(event.session_id, {
              processState: d.processState,
              promptType: d.promptType ?? null,
              isPermission: !!d.isPermission,
              at: Date.now(),
            });
          }
        }
        return;
      }

      useStreamStore.getState().addEvent(event);
      // Invalidate sessions query on session lifecycle events so we don't need aggressive polling
      if (event.type?.startsWith('session.') && queryClientRef) {
        queryClientRef.invalidateQueries({ queryKey: ['sessions'] });
      }
    } catch {
      // Ignore parse errors
    }
  };

  ws.onclose = () => {
    useStreamStore.getState().setConnected(false);
    ws = null;
    // Reconnect after 3s
    setTimeout(connectStream, 3000);
  };

  ws.onerror = () => {
    ws?.close();
  };
}
