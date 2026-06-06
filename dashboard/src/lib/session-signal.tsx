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

import { Lock } from 'lucide-react';
import type { Session } from './api';
import type { LiveSessionState } from './websocket';
import { useStreamStore } from './websocket';

export interface Signal {
  color: string;
  /** Intrinsic animation (busy). */
  pulse: boolean;
  /** "Needs you / notable" — pulses while the tab is not the active one. */
  attention: boolean;
  /** Render a lock glyph instead of a plain dot (authorization prompt). */
  lock: boolean;
  title: string;
}

const C = {
  blue: '#3b82f6',
  yellow: '#eab308',
  green: '#22c55e',
  red: '#ef4444',
  grey: '#6b7280',
};

type LiveLike = Pick<LiveSessionState, 'processState' | 'promptType' | 'isPermission'> | undefined | null;

/** Derive a live-state object from a session row's bootstrap fields (from sessions.list). */
export function liveFromSession(s: Session): LiveLike {
  if (!s.processState) return undefined;
  return { processState: s.processState, promptType: s.promptType ?? null, isPermission: !!s.isPermission };
}

export function sessionSignal(status: string | undefined, live: LiveLike): Signal | null {
  if (live) {
    if (live.processState === 'busy') {
      return { color: C.blue, pulse: true, attention: false, lock: false, title: '运行中' };
    }
    if (live.processState === 'waiting_for_input') {
      if (live.isPermission) {
        return { color: C.yellow, pulse: false, attention: true, lock: true, title: '等待授权' };
      }
      const t =
        live.promptType === 'confirmation' ? '等待确认 (Y/n)'
        : live.promptType === 'choice' ? '等待选择'
        : '等待输入';
      return { color: C.yellow, pulse: false, attention: true, lock: false, title: t };
    }
    if (live.processState === 'idle') {
      return { color: C.green, pulse: false, attention: false, lock: false, title: '已完成 · 等待你' };
    }
  }
  switch (status) {
    case 'completed': return { color: C.green, pulse: false, attention: false, lock: false, title: '已结束' };
    case 'failed':    return { color: C.red,   pulse: false, attention: true,  lock: false, title: '出错' };
    case 'running':   return { color: C.blue,  pulse: true,  attention: false, lock: false, title: '运行中' };
    case 'pending':   return { color: C.grey,  pulse: false, attention: false, lock: false, title: '启动中' };
    case 'detached':  return { color: C.grey,  pulse: false, attention: false, lock: false, title: '游离(未连接)' };
    case 'cancelled': return { color: C.grey,  pulse: false, attention: false, lock: false, title: '已取消' };
  }
  return null;
}

/** Resolve a session's signal, preferring the live WS store over the row bootstrap.
 *  Once a session reaches a terminal lifecycle status, the process (and its
 *  tracker) is gone — any lingering live entry is stale, so the status wins. */
export function signalForSession(s: Session, liveStates: Record<string, LiveSessionState>): Signal | null {
  const terminal = s.status === 'completed' || s.status === 'failed' || s.status === 'cancelled';
  const live = terminal ? undefined : (liveStates[s.id] ?? liveFromSession(s));
  return sessionSignal(s.status, live);
}

const RANK: Record<string, number> = { [C.red]: 4, [C.yellow]: 3, [C.blue]: 2, [C.green]: 1, [C.grey]: 0 };

/** Highest-priority signal across a project's sessions (red > yellow > blue > green > grey). */
export function rollupSignal(signals: (Signal | null)[]): Signal | null {
  let best: Signal | null = null;
  let bestRank = -1;
  for (const s of signals) {
    if (!s) continue;
    const r = RANK[s.color] ?? 0;
    if (r > bestRank) { bestRank = r; best = s; }
  }
  return best;
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
  const rollup = rollupSignal(
    sessions
      .filter((s) => {
        if (liveStates[s.id]) return true;
        if (s.status === 'running' || s.status === 'pending' || s.status === 'detached') return true;
        if (s.status === 'failed' && s.completed_at) {
          const t = Date.parse(s.completed_at + (s.completed_at.endsWith('Z') ? '' : 'Z'));
          if (!Number.isNaN(t) && Date.now() - t < 10 * 60 * 1000) return true;
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
