import { useMemo } from 'react';
import type { Session } from './api';
import { sessionActivityMs, timestampMs } from './session-activity-model';
import { useStreamStore } from './websocket';

function TabLabel({ label, activityAt, detail }: { label: string; activityAt: number | null; detail?: string }) {
  const title = [label, detail, activityAt === null ? '最后活跃：未知' : `最后活跃：${new Date(activityAt).toLocaleString('zh-CN')}`, '双击重命名']
    .filter(Boolean).join('\n');
  return <span className="truncate" title={title}>{label}</span>;
}

export function SessionTabLabel({ session, label, detail }: { session: Session | undefined; label: string; detail?: string }) {
  const liveAt = useStreamStore((state) => session ? state.activityAt[session.id] : undefined);
  const native = session?.cli_type === 'codex' ? session.agent_runtime : undefined;
  const states = {running:'运行中',idle:'本轮已结束，等待输入',waiting_for_input:'等待用户输入',interrupted:'本轮已中断',failed:'执行失败',unknown:'状态未知'};
  const description = session?.cli_type === 'codex'
    ? `${detail || 'Codex'}\nCodex 原生状态：${states[native?.state || 'unknown']}\n${native?.reason || '尚无原生活动记录'}` : detail;
  return <TabLabel label={label} detail={description} activityAt={session ? sessionActivityMs(session, liveAt) : null} />;
}

export function ProjectTabLabel({
  sessions,
  fallbackAt,
  label,
}: {
  sessions: Session[];
  fallbackAt?: string | null;
  label: string;
}) {
  const liveActivity = useStreamStore((state) => state.activityAt);
  const latest = useMemo(() => {
    let result: number | null = sessions.length ? null : timestampMs(fallbackAt);
    for (const session of sessions) {
      const activity = sessionActivityMs(session, liveActivity[session.id]);
      if (activity !== null && (result === null || activity > result)) result = activity;
    }
    return result;
  }, [fallbackAt, liveActivity, sessions]);
  return <TabLabel label={label} activityAt={latest} />;
}
