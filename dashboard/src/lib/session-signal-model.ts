import type { Session } from './api';
import type { LiveSessionState } from './websocket';

export interface Signal {
  color: string;
  pulse: boolean;
  attention: boolean;
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

export function liveFromSession(session: Session): LiveLike {
  if (!session.processState) return undefined;
  return {
    processState: session.processState,
    promptType: session.promptType ?? null,
    isPermission: !!session.isPermission,
  };
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
      const title = live.promptType === 'confirmation'
        ? '等待确认 (Y/n)'
        : live.promptType === 'choice'
          ? '等待选择'
          : '等待输入';
      return { color: C.yellow, pulse: false, attention: true, lock: false, title };
    }
    if (live.processState === 'idle') {
      return { color: C.green, pulse: false, attention: false, lock: false, title: '已完成 · 等待你' };
    }
  }

  switch (status) {
    case 'completed': return { color: C.green, pulse: false, attention: false, lock: false, title: '已结束' };
    case 'failed': return { color: C.red, pulse: false, attention: true, lock: false, title: '出错' };
    case 'running': return { color: C.blue, pulse: true, attention: false, lock: false, title: '运行中' };
    case 'pending': return { color: C.grey, pulse: false, attention: false, lock: false, title: '启动中' };
    case 'detached': return { color: C.grey, pulse: false, attention: false, lock: false, title: '游离(未连接)' };
    case 'cancelled': return { color: C.grey, pulse: false, attention: false, lock: false, title: '已取消' };
    default: return null;
  }
}

export function signalForSession(session: Session, liveStates: Record<string, LiveSessionState>): Signal | null {
  const terminal = session.status === 'completed' || session.status === 'failed' || session.status === 'cancelled';
  const live = terminal ? undefined : (liveStates[session.id] ?? liveFromSession(session));
  return sessionSignal(session.status, live);
}

const RANK: Record<string, number> = {
  [C.red]: 4,
  [C.yellow]: 3,
  [C.blue]: 2,
  [C.green]: 1,
  [C.grey]: 0,
};

export function rollupSignal(signals: Array<Signal | null>): Signal | null {
  let best: Signal | null = null;
  let bestRank = -1;
  for (const signal of signals) {
    if (!signal) continue;
    const rank = RANK[signal.color] ?? 0;
    if (rank > bestRank) {
      bestRank = rank;
      best = signal;
    }
  }
  return best;
}
