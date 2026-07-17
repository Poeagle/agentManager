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
let lastMessageAt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let watchdogInstalled = false;

// The server sends a heartbeat every ~25s. If nothing arrives for this long the
// socket is treated as silently dead (e.g. an idle tunnel dropped it without a
// close frame) and recycled.
const STALE_MS = 60_000;

function scheduleReconnect(delay = 3000) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectStream();
  }, delay);
}

/** Reconnect if the socket is missing/closed, or recycle it if it's gone stale. */
function ensureFresh() {
  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    connectStream();
  } else if (ws.readyState === WebSocket.OPEN && Date.now() - lastMessageAt > STALE_MS) {
    try { ws.close(); } catch { /* noop */ } // onclose schedules the reconnect
  }
}

function installWatchdog() {
  if (watchdogInstalled || typeof window === 'undefined') return;
  watchdogInstalled = true;
  // Catch silent drops even while the tab sits idle.
  setInterval(ensureFresh, 20_000);
  // Reconnect promptly when the user returns to the tab or the network is back —
  // these are exactly the moments a tunnel-dropped socket needs recovering.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') ensureFresh();
  });
  window.addEventListener('online', ensureFresh);
}

export function connectStream() {
  installWatchdog();

  // Already connected or connecting — nothing to do.
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  // Drop any half-dead socket before opening a new one.
  if (ws) { try { ws.onclose = null; ws.onerror = null; ws.close(); } catch { /* noop */ } ws = null; }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${window.location.host}/api/stream`;

  ws = new WebSocket(url);
  lastMessageAt = Date.now();

  ws.onopen = () => {
    lastMessageAt = Date.now();
    useStreamStore.getState().setConnected(true);
  };

  ws.onmessage = (msg) => {
    lastMessageAt = Date.now();
    try {
      const event = JSON.parse(msg.data);

      // Heartbeat / handshake frames are keepalive only — nothing to render.
      if (event.type === 'ping' || event.type === 'connected') return;

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
    scheduleReconnect(3000);
  };

  ws.onerror = () => {
    try { ws?.close(); } catch { /* noop */ }
  };
}
