import { useEffect, useMemo, useState } from 'react';
import type { Session } from './api';
import { formatActivityAge, sessionActivityMs, timestampMs } from './session-activity-model';
import { useStreamStore } from './websocket';

const RELATIVE_TIME_TICK_MS = 30_000;

function ActivityAge({ activityAt }: { activityAt: number | null }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), RELATIVE_TIME_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  if (activityAt === null) return null;

  return (
    <span
      className="shrink-0 text-[9px] font-normal tabular-nums"
      style={{ color: 'var(--text-muted)' }}
      title={`最后活跃：${new Date(activityAt).toLocaleString('zh-CN')}`}
      aria-label={`最后活跃于${formatActivityAge(activityAt, now)}前`}
    >
      · {formatActivityAge(activityAt, now)}
    </span>
  );
}

export function SessionActivityAge({ session }: { session: Session | undefined }) {
  const liveAt = useStreamStore((state) => session ? state.activityAt[session.id] : undefined);
  return <ActivityAge activityAt={session ? sessionActivityMs(session, liveAt) : null} />;
}

export function ProjectActivityAge({
  sessions,
  fallbackAt,
}: {
  sessions: Session[];
  fallbackAt?: string | null;
}) {
  const liveActivity = useStreamStore((state) => state.activityAt);
  const latest = useMemo(() => {
    let result = timestampMs(fallbackAt);
    for (const session of sessions) {
      const activity = sessionActivityMs(session, liveActivity[session.id]);
      if (activity !== null && (result === null || activity > result)) result = activity;
    }
    return result;
  }, [fallbackAt, liveActivity, sessions]);
  return <ActivityAge activityAt={latest} />;
}
