import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Clock, Trash2, Play, CornerUpRight, Loader2, Check, X, RefreshCw } from 'lucide-react';
import { api, type ClaudeHistoryItem } from '../lib/api';
import { ClaudeIcon } from './CliIcons';

const ACTIVE = new Set(['running', 'detached', 'pending']);

function fmtWhen(ms: number | null): string {
  if (ms == null) return '';
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(ms).toLocaleDateString();
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function shortModel(m: string | null): string {
  if (!m) return '';
  return m.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

function displayTitle(item: ClaudeHistoryItem): string {
  if (item.title && item.title !== '(无标题)') return item.title;
  return `(无标题 · ${item.uuid.slice(0, 8)})`;
}

function HistoryRow({
  item, isOpen, busy, onOpen, onDelete,
}: {
  item: ClaudeHistoryItem;
  isOpen: boolean;
  busy: boolean;
  onOpen: (i: ClaudeHistoryItem) => void;
  onDelete: (i: ClaudeHistoryItem) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const live = item.liveStatus && ACTIVE.has(item.liveStatus);
  const openTitle = isOpen ? '跳转到该标签' : live ? '打开运行中的会话' : '续上(/resume)并打开';

  return (
    <div
      className="flex items-center gap-2 px-2 py-1.5 rounded-md group"
      style={{ background: isOpen ? 'var(--bg-tertiary)' : 'transparent' }}
    >
      <span
        className="shrink-0 rounded-full"
        title={live ? '运行中' : undefined}
        style={{
          width: 7, height: 7,
          background: live ? '#3b82f6' : 'var(--border)',
          boxShadow: live ? '0 0 6px #3b82f6' : 'none',
        }}
      />
      <ClaudeIcon className="w-3.5 h-3.5 shrink-0" style={{ color: '#D97757' }} />

      <button
        onClick={() => onOpen(item)}
        disabled={busy}
        title={openTitle}
        className="flex-1 min-w-0 text-left"
      >
        <div className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>
          {displayTitle(item)}
        </div>
        <div className="text-[10px] truncate" style={{ color: 'var(--text-secondary)' }}>
          {shortModel(item.model)}{item.model ? ' · ' : ''}{fmtSize(item.sizeBytes)} · {fmtWhen(item.lastActivity)}
          {live ? ' · 运行中' : ''}
        </div>
      </button>

      <button
        onClick={() => onOpen(item)}
        disabled={busy}
        title={openTitle}
        className="p-1 rounded shrink-0 opacity-0 group-hover:opacity-70 hover:opacity-100 transition-opacity"
        style={{ color: 'var(--text-secondary)' }}
      >
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
          : (isOpen || live) ? <CornerUpRight className="w-3.5 h-3.5" />
          : <Play className="w-3.5 h-3.5" />}
      </button>

      {confirming ? (
        <div className="flex items-center gap-0.5 shrink-0">
          <button onClick={() => { setConfirming(false); onDelete(item); }} title="确认删除对话日志" className="p-1 rounded" style={{ color: 'var(--error)' }}>
            <Check className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => setConfirming(false)} title="取消" className="p-1 rounded" style={{ color: 'var(--text-secondary)' }}>
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ) : (
        <button
          onClick={() => !live && setConfirming(true)}
          disabled={!!live}
          title={live ? '先停止运行中的会话再删除' : '删除对话日志(.jsonl)'}
          className="p-1 rounded shrink-0 opacity-0 group-hover:opacity-60 hover:opacity-100 transition-opacity"
          style={{ color: 'var(--text-secondary)', cursor: live ? 'not-allowed' : 'pointer' }}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

export function SessionHistoryPanel({
  projectId, openTabIds, busyUuid, onOpen, onDelete,
}: {
  projectId: string;
  openTabIds: Set<string>;
  busyUuid: string | null;
  onOpen: (i: ClaudeHistoryItem) => void;
  onDelete: (i: ClaudeHistoryItem) => void;
}) {
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['claude-history', projectId],
    queryFn: () => api.sessions.claudeHistory(projectId),
    staleTime: 10_000,
  });
  const sessions = data?.sessions ?? [];

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--bg-secondary)' }}>
      <div className="flex items-center gap-2 px-3 py-2 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
        <Clock className="w-4 h-4" style={{ color: 'var(--accent)' }} />
        <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Session 历史</span>
        <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{sessions.length}</span>
        <button
          onClick={() => refetch()}
          title="刷新"
          className="ml-auto p-1 rounded hover:opacity-80"
          style={{ color: 'var(--text-secondary)' }}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
        {isLoading ? (
          <div className="flex items-center justify-center py-8"><Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--text-secondary)' }} /></div>
        ) : isError ? (
          <div className="text-xs text-center py-8" style={{ color: 'var(--error)' }}>
            加载失败: {(error as Error)?.message || '未知错误'}
          </div>
        ) : sessions.length === 0 ? (
          <div className="text-xs text-center py-8" style={{ color: 'var(--text-secondary)' }}>
            这个项目还没有 Claude 会话历史
          </div>
        ) : (
          sessions.map((s) => (
            <HistoryRow
              key={s.uuid}
              item={s}
              isOpen={!!s.liveSessionId && openTabIds.has(s.liveSessionId)}
              busy={busyUuid === s.uuid}
              onOpen={onOpen}
              onDelete={onDelete}
            />
          ))
        )}
      </div>
    </div>
  );
}
