import type { Session } from './api';

export function timestampMs(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function sessionActivityMs(session: Session, liveAt?: number): number | null {
  const durable = timestampMs(
    session.last_activity_at
      ?? session.updated_at
      ?? session.completed_at
      ?? session.started_at
      ?? session.created_at,
  );
  const live = timestampMs(liveAt);
  if (durable === null) return live;
  if (live === null) return durable;
  return Math.max(durable, live);
}

export function formatActivityAge(activityAt: number, now = Date.now()): string {
  const elapsedSeconds = Math.max(0, Math.floor((now - activityAt) / 1000));
  if (elapsedSeconds < 60) return '刚刚';
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return `${minutes}分`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}时`;
  return `${Math.floor(hours / 24)}天`;
}
