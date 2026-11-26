import {agentSupports} from './agents';
import {formatDisplayTimestamp,useDisplayClock} from './display-clock';
import { useMemo } from 'react';
import type { Session } from './api';
import { formatActivityAge, sessionActivityMs, timestampMs } from './session-activity-model';
import { useStreamStore } from './websocket';

function TabLabel({ label, activityAt, detail }: { label: string; activityAt: number | null; detail?: string }) {
  const timeZone=useDisplayClock();
  const title = [label, detail, activityAt === null ? '最后活跃：未知' : `最后活跃：${formatDisplayTimestamp(activityAt)}（${timeZone}）`, '双击重命名']
    .filter(Boolean).join('\n');
  return <span className="truncate" title={title}>{label}</span>;
}

export function SessionTabBadges({ account, activityAt }: {
  account?: string;
  activityAt?: number | null;
}) {
  if (!account && activityAt == null) return null;
  return <span className="workspace-session-badges">
    {account && <span className="workspace-session-account" title={account} aria-hidden="true">{account}</span>}
    {activityAt != null && <span className="workspace-session-age" aria-hidden="true">{formatActivityAge(activityAt)}</span>}
  </span>;
}

export type SessionScheduleAction = {
  label: string;
  enabled: boolean;
  multiple: boolean;
  busy: boolean;
  disabled: boolean;
  onToggle: () => void;
};

export function SessionScheduleButton({ label, enabled, multiple, busy, disabled, onToggle }: SessionScheduleAction) {
  const action = `${enabled ? '停用' : '启用'}${multiple ? '全部' : ''}定时任务`;
  return <button
    type="button"
    className="workspace-session-scheduled"
    data-enabled={enabled}
    title={`${busy ? '正在更新定时任务' : action} · ${label}`}
    aria-label={`${action} · ${label}`}
    aria-busy={busy || undefined}
    aria-disabled={disabled || undefined}
    onClick={event => { if (!disabled && event.detail <= 1) onToggle(); }}
  >定时</button>;
}

export function SessionTabLabel({ session, label, detail, activityAt }: {
  session: Session | undefined;
  label: string;
  detail?: string;
  activityAt: number | null;
}) {
  const native = !!session&&agentSupports(session,'runtime') ? session.agent_runtime : undefined;
  const states = {ready:'新会话就绪，等待输入',running:'运行中',idle:'本轮已结束，等待输入',waiting_for_input:'等待用户输入',interrupted:'本轮已中断',failed:'执行失败',unknown:'状态未知'};
  const description = !!session&&agentSupports(session,'runtime')
    ? `${detail || 'Codex'}\nCodex 原生状态：${states[native?.state || 'unknown']}\n${native?.reason || '尚无原生活动记录'}` : detail;
  return <TabLabel label={label} detail={description} activityAt={activityAt} />;
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
