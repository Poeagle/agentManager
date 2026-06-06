import { useState } from 'react';
import { Clock, Trash2, Play, CornerUpRight, Loader2, Check, X } from 'lucide-react';
import type { Session } from '../lib/api';
import type { LiveSessionState } from '../lib/websocket';
import { signalForSession, SessionSignalDot } from '../lib/session-signal';
import { ClaudeIcon, CodexIcon } from './CliIcons';

const ACTIVE = new Set(['running', 'detached', 'pending']);

function parseTs(s: string | null): number | null {
  if (!s) return null;
  const t = Date.parse(s + (s.endsWith('Z') ? '' : 'Z'));
  return Number.isNaN(t) ? null : t;
}

function fmtWhen(s: string | null): string {
  const t = parseTs(s);
  if (t == null) return '';
  return new Date(t).toLocaleString();
}

function fmtDuration(start: string | null, end: string | null): string {
  const a = parseTs(start), b = parseTs(end);
  if (a == null || b == null || b < a) return '';
  let sec = Math.round((b - a) / 1000);
  const h = Math.floor(sec / 3600); sec -= h * 3600;
  const m = Math.floor(sec / 60); sec -= m * 60;
  return h > 0 ? `${h}h${m}m` : m > 0 ? `${m}m${sec}s` : `${sec}s`;
}

function taskLabel(s: Session): string {
  if (s.task === 'Terminal') return 'Terminal';
  const agent = s.task?.match(/^Agent \(([^)]+)\)/);
  if (agent) return `Agent · ${agent[1]}`;
  return s.task || 'Session';
}

function isResumable(s: Session): boolean {
  return s.cli_type !== 'codex' && !!s.claude_session_id;
}

function SessionRow({
  session, isOpen, live, busy, onOpen, onDelete,
}: {
  session: Session;
  isOpen: boolean;
  live: LiveSessionState | undefined;
  busy: boolean;
  onOpen: (s: Session) => void;
  onDelete: (s: Session) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const signal = signalForSession(session, live ? { [session.id]: live } : {});
  const active = ACTIVE.has(session.status);
  const canOpen = active || isResumable(session);
  const isCodex = session.cli_type === 'codex';

  // What the open action means for this row.
  const openTitle = isOpen ? '跳转到该标签'
    : active ? '打开会话'
    : isResumable(session) ? '续上(/resume)并打开'
    : isCodex ? '无法续上(Codex 不支持)' : '无法续上(无 Claude 会话 id)';

  const dur = fmtDuration(session.started_at, session.completed_at);

  return (
    <div
      className="flex items-center gap-2 px-2 py-1.5 rounded-md group"
      style={{ background: isOpen ? 'var(--bg-tertiary)' : 'transparent' }}
    >
      <SessionSignalDot signal={signal} active size={7} />
      {isCodex
        ? <CodexIcon className="w-3.5 h-3.5 shrink-0" style={{ color: '#7A9DFF' }} />
        : <ClaudeIcon className="w-3.5 h-3.5 shrink-0" style={{ color: '#D97757' }} />}

      <button
        onClick={() => canOpen && onOpen(session)}
        disabled={!canOpen || busy}
        title={openTitle}
        className="flex-1 min-w-0 text-left"
        style={{ cursor: canOpen ? 'pointer' : 'default' }}
      >
        <div className="text-xs font-medium truncate" style={{ color: canOpen ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
          {taskLabel(session)}
        </div>
        <div className="text-[10px] truncate" style={{ color: 'var(--text-secondary)' }}>
          {session.status}
          {dur ? ` · ${dur}` : ''}
          {session.exit_code != null ? ` · exit ${session.exit_code}` : ''}
          {' · '}{fmtWhen(session.created_at)}
        </div>
      </button>

      {/* Open / resume affordance */}
      {canOpen && (
        <button
          onClick={() => onOpen(session)}
          disabled={busy}
          title={openTitle}
          className="p-1 rounded shrink-0 opacity-0 group-hover:opacity-70 hover:opacity-100 transition-opacity"
          style={{ color: 'var(--text-secondary)' }}
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
            : isOpen ? <CornerUpRight className="w-3.5 h-3.5" />
            : active ? <CornerUpRight className="w-3.5 h-3.5" />
            : <Play className="w-3.5 h-3.5" />}
        </button>
      )}

      {/* Delete (ended sessions only) */}
      {confirming ? (
        <div className="flex items-center gap-0.5 shrink-0">
          <button onClick={() => { setConfirming(false); onDelete(session); }} title="确认删除" className="p-1 rounded" style={{ color: 'var(--error)' }}>
            <Check className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => setConfirming(false)} title="取消" className="p-1 rounded" style={{ color: 'var(--text-secondary)' }}>
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ) : (
        <button
          onClick={() => !active && setConfirming(true)}
          disabled={active}
          title={active ? '先停止该会话再删除' : '删除(记录 + 对话日志)'}
          className="p-1 rounded shrink-0 opacity-0 group-hover:opacity-60 hover:opacity-100 transition-opacity"
          style={{ color: 'var(--text-secondary)', cursor: active ? 'not-allowed' : 'pointer' }}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

export function SessionHistoryPanel({
  sessions, liveStates, openTabIds, busyId, onOpen, onDelete,
}: {
  sessions: Session[];
  liveStates: Record<string, LiveSessionState>;
  openTabIds: Set<string>;
  busyId: string | null;
  onOpen: (s: Session) => void;
  onDelete: (s: Session) => void;
}) {
  const sorted = [...sessions].sort((a, b) => (parseTs(b.created_at) ?? 0) - (parseTs(a.created_at) ?? 0));
  const activeList = sorted.filter((s) => ACTIVE.has(s.status));
  const endedList = sorted.filter((s) => !ACTIVE.has(s.status));

  const group = (title: string, list: Session[]) => list.length > 0 && (
    <div className="space-y-0.5">
      <div className="px-2 text-[10px] uppercase tracking-wider font-semibold" style={{ color: 'var(--text-secondary)' }}>
        {title} · {list.length}
      </div>
      {list.map((s) => (
        <SessionRow
          key={s.id}
          session={s}
          isOpen={openTabIds.has(s.id)}
          live={liveStates[s.id]}
          busy={busyId === s.id}
          onOpen={onOpen}
          onDelete={onDelete}
        />
      ))}
    </div>
  );

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--bg-secondary)' }}>
      <div className="flex items-center gap-2 px-3 py-2 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
        <Clock className="w-4 h-4" style={{ color: 'var(--accent)' }} />
        <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Session 历史</span>
        <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{sessions.length}</span>
      </div>
      <div className="flex-1 overflow-y-auto p-1.5 space-y-3">
        {sorted.length === 0 ? (
          <div className="text-xs text-center py-8" style={{ color: 'var(--text-secondary)' }}>
            这个项目还没有 session
          </div>
        ) : (
          <>
            {group('活跃', activeList)}
            {group('已结束', endedList)}
          </>
        )}
      </div>
    </div>
  );
}
