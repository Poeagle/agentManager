// Session status "signal lights" shown on session tabs (and aggregated on
// project tabs). Maps the server's live process-state + persistent lifecycle
// status onto a colored dot:
//
//   🔵 busy            running / producing output         (intrinsic gentle pulse)
//   🟡 waiting_for_input  needs you — input / authorization (🔒)  (pulses until you open it)
//   🟢 idle / completed  done, your move / cleanly ended    (static)
//   🔴 failed            errored / non-zero exit            (pulses until you open it)
//   ⚪ pending/detached/cancelled  neutral                  (static)
//
// "Live" process-state takes precedence over the DB lifecycle status: a session
// that is `running` in the DB but `waiting_for_input` live shows yellow.

import { useSyncExternalStore } from 'react';
import { Lock } from 'lucide-react';
import type { Session } from './api';
import { useStreamStore } from './websocket';
import {
  liveFromSession,
  rollupSignal,
  sessionSignal,
  signalForSession,
  type Signal,
} from './session-signal-model';

let clockSnapshot = Date.now();
let clockTimer: ReturnType<typeof setInterval> | null = null;
const clockListeners = new Set<() => void>();

function subscribeClock(listener: () => void): () => void {
  clockListeners.add(listener);
  if (!clockTimer) {
    clockTimer = setInterval(() => {
      clockSnapshot = Date.now();
      for (const notify of clockListeners) notify();
    }, 30_000);
  }
  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size === 0 && clockTimer) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}

function getClockSnapshot(): number {
  return clockSnapshot;
}

/**
 * A session signal dot that subscribes to ONLY its own session's live state.
 * Rendering this as a leaf (instead of reading the whole `liveStates` map in a
 * big parent) keeps a session.state tick from re-rendering entire ProjectViews —
 * the zustand selector returns the same reference for unrelated sessions, so
 * only the dot whose session actually changed re-renders.
 */
export function LiveSessionSignalDot({
  session, active, size,
}: {
  session: Session;
  active?: boolean;
  size?: number;
}) {
  const live = useStreamStore((s) => s.liveStates[session.id]);
  const terminal = session.status === 'completed' || session.status === 'failed' || session.status === 'cancelled';
  const signal = sessionSignal(session.status, terminal ? undefined : (live ?? liveFromSession(session)));
  return <SessionSignalDot signal={signal} active={active} size={size} />;
}

/**
 * Aggregate signal dot for a project tab. Subscribes to the live-state map
 * itself (a cheap leaf) so it updates in real time without re-rendering the
 * whole Dashboard / its mounted ProjectViews. Renders nothing when no session
 * currently warrants attention.
 */
export function ProjectRollupDot({
  sessions, active, size = 6,
}: {
  sessions: Session[];
  active?: boolean;
  size?: number;
}) {
  const liveStates = useStreamStore((s) => s.liveStates);
  const now = useSyncExternalStore(subscribeClock, getClockSnapshot, getClockSnapshot);
  const rollup = rollupSignal(
    sessions
      .filter((s) => {
        if (liveStates[s.id]) return true;
        if (s.status === 'running' || s.status === 'pending' || s.status === 'detached') return true;
        if (s.status === 'failed' && s.completed_at) {
          const t = Date.parse(s.completed_at + (s.completed_at.endsWith('Z') ? '' : 'Z'));
          if (!Number.isNaN(t) && now - t < 10 * 60 * 1000) return true;
        }
        return false;
      })
      .map((s) => signalForSession(s, liveStates))
  );
  if (!rollup) return null;
  return (
    <span className="pl-2 flex items-center">
      <SessionSignalDot signal={rollup} active={active} size={size} />
    </span>
  );
}

export function SessionSignalDot({
  signal,
  active,
  size = 7,
}: {
  signal: Signal | null;
  active?: boolean;
  size?: number;
}) {
  if (!signal) return null;
  const animate = signal.pulse || (signal.attention && !active);
  if (signal.lock) {
    return (
      <span
        title={signal.title}
        className={`shrink-0 inline-flex ${animate ? 'animate-pulse' : ''}`}
        style={{ color: signal.color }}
      >
        <Lock style={{ width: size + 2, height: size + 2 }} />
      </span>
    );
  }
  return (
    <span
      title={signal.title}
      className={`shrink-0 rounded-full ${animate ? 'animate-pulse' : ''}`}
      style={{
        width: size,
        height: size,
        background: signal.color,
        boxShadow: animate ? `0 0 6px ${signal.color}` : 'none',
      }}
    />
  );
}
