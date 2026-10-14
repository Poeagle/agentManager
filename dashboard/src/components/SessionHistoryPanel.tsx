import { tableTime, useTableModel } from './table/use-table-model';
import { DataTable, TableExpandButton, TableDetailRow } from './table/DataTable';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, Loader2, Monitor, RefreshCw, Trash2 } from 'lucide-react';
import { api, type Session } from '../lib/api';
import { ClaudeIcon, CodexIcon } from './CliIcons';
import { TableActionButton, TableActions } from './table/TableActions';
import { Dialog } from './Dialog';

const ACTIVE = new Set(['running', 'detached', 'pending', 'launching', 'released']);
const DELETABLE = new Set(['completed', 'failed', 'cancelled']);

function fmtDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const time = tableTime(value);
  if (time == null) return '—';
  const date = new Date(time);
  const pad = (number: number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function sessionKind(session: Session): string {
  if (session.mode === 'terminal' || session.task === 'Terminal') return '终端会话';
  if (session.cli_type === 'codex') return 'Codex';
  if (session.cli_type === 'claude') return 'Claude';
  return '会话';
}

function sessionTitle(session: Session, displayName?: string): string {
  return displayName?.trim() || session.task?.trim() || sessionKind(session);
}

function sessionSummary(session: Session): string {
  return session.content_summary?.trim() || session.task?.trim() || '暂无会话内容';
}

function sessionActivity(session: Session): string | null | undefined {
  return session.last_activity_at || session.completed_at || session.started_at || session.created_at;
}

function cleanTerminalText(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex -- Strip actual PTY escape sequences from terminal previews.
    .replace(/\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))|\r/g, '')
    // eslint-disable-next-line no-control-regex -- Strip ANSI CSI controls from terminal previews.
    .replace(/\[[0-?]*[ -/]*[@-~]/g, '')
    .trim();
}

function SessionIcon({ session }: { session: Session }) {
  if (session.cli_type === 'codex') return <CodexIcon className="h-3.5 w-3.5 shrink-0" style={{ color: '#60a5fa' }} />;
  if (session.cli_type === 'claude') return <ClaudeIcon className="h-3.5 w-3.5 shrink-0" style={{ color: '#D97757' }} />;
  return <Monitor className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--text-secondary)' }} />;
}

function SessionDetails({ session }: { session: Session }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['project-session-detail', session.id],
    queryFn: () => api.sessions.output(session.id, { limit: 5 }),
  });
  const contents = (data?.chunks || []).map((chunk) => cleanTerminalText(chunk.data)).filter(Boolean);

  return (
    <TableDetailRow columnCount={7}>
        <div>
          <p className="mb-2 text-[10px] font-medium" style={{ color: 'var(--text-secondary)' }}>最近会话内容</p>
          {isLoading ? (
            <div className="flex items-center gap-2 py-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}><Loader2 className="h-3.5 w-3.5 animate-spin" />加载中…</div>
          ) : isError ? (
            <p className="text-[11px]" style={{ color: 'var(--error)' }}>无法加载会话内容。</p>
          ) : contents.length === 0 ? (
            <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>暂无会话内容。</p>
          ) : (
            <div className="space-y-1.5">
              {contents.map((content, index) => <pre key={`${session.id}-${index}`} className="max-h-20 overflow-hidden whitespace-pre-wrap break-words rounded px-2 py-1.5 text-[11px] leading-4" style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}>{content}</pre>)}
            </div>
          )}
        </div>
    </TableDetailRow>
  );
}

function ProjectSessionRow({
  session,
  isOpen,
  displayName,
  expanded,
  onToggle,
  onOpen,
  onDelete,
  deleting,
}: {
  session: Session;
  isOpen: boolean;
  displayName?: string;
  expanded: boolean;
  onToggle: () => void;
  onOpen: (session: Session) => void;
  onDelete: (session: Session) => void;
  deleting: boolean;
}) {
  const active = ACTIVE.has(session.status);
  const activity = sessionActivity(session);
  const summary = sessionSummary(session);

  return <>
    <tr className="group" style={{ background: isOpen ? 'var(--bg-tertiary)' : 'transparent', boxShadow: isOpen ? 'inset 2px 0 0 var(--accent)' : 'inset 2px 0 0 transparent' }}>
      <td className="w-8 text-center">
        <TableExpandButton expanded={expanded} label={`会话 ${sessionTitle(session, displayName)}`} onClick={onToggle} />
      </td>
      <td >
        <button type="button" onClick={() => onOpen(session)} className="flex min-w-0 max-w-full items-center gap-2 text-left" title={isOpen ? '跳转到该标签页' : '打开该会话标签页'}>
          <span className="relative flex shrink-0 items-center justify-center"><SessionIcon session={session} /><span className="absolute -right-1 -bottom-0.5 rounded-full" style={{ width: 6, height: 6, background: active ? '#3b82f6' : 'var(--border)', boxShadow: active ? '0 0 5px #3b82f6' : 'none' }} /></span>
          <span className="truncate text-xs font-semibold transition-colors group-hover:text-[var(--accent)]" style={{ color: 'var(--text-primary)' }}>{sessionTitle(session, displayName)}</span>
        </button>
      </td>
      <td className="text-[11px]" style={{ color: 'var(--text-secondary)' }}><span className="block truncate">{sessionKind(session)}</span><span className="block text-[10px]" style={{ color: active ? 'var(--accent)' : 'var(--text-secondary)' }}>{active ? '运行中' : session.status}</span></td>
      <td className="whitespace-nowrap text-[11px] tabular-nums" style={{ color: 'var(--text-secondary)' }}>{fmtDateTime(session.created_at)}</td>
      <td className="whitespace-nowrap text-[11px] tabular-nums" style={{ color: 'var(--text-secondary)' }}>{fmtDateTime(activity)}</td>
      <td className="text-[11px]" style={{ color: 'var(--text-secondary)' }}><span className="block truncate" title={summary}>{summary}</span></td>
      <td><TableActions><TableActionButton disabled={deleting || !DELETABLE.has(session.status)}
        aria-label={`删除会话 ${sessionTitle(session, displayName)}`} title={DELETABLE.has(session.status) ? '删除会话记录' : '请先关闭会话后再删除'}
        style={{ color: 'var(--error)' }} onClick={() => onDelete(session)}><Trash2 className="h-3.5 w-3.5" />删除</TableActionButton></TableActions></td>
    </tr>
    {expanded && <SessionDetails session={session} />}
  </>;
}

export function SessionHistoryPanel({
  projectId,
  openTabIds,
  displayNames = {},
  onOpen,
  onDeleted,
}: {
  projectId: string;
  openTabIds: Set<string>;
  displayNames?: Record<string, string>;
  onOpen: (session: Session) => void;
  onDeleted?: (sessionId: string) => void;
}) {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({ queryKey: ['project-sessions', projectId], queryFn: () => api.sessions.list(undefined, projectId), staleTime: 10_000 });
  const sessions = data?.sessions ?? [];
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [deleteTarget, setDeleteTarget] = useState<Session | null>(null);
  const deletion = useMutation({
    mutationFn: (sessionId: string) => api.sessions.deleteRecord(sessionId),
    onSuccess: (_result, sessionId) => {
      // Update only after the server confirms deletion; failed requests preserve the row and tab.
      for (const key of [['sessions'], ['project-sessions', projectId]]) {
        queryClient.setQueryData<{ sessions: Session[] }>(key, (current) => current
          ? { ...current, sessions: current.sessions.filter((session) => session.id !== sessionId) } : current);
      }
      queryClient.removeQueries({ queryKey: ['project-session-detail', sessionId] });
      setExpandedIds((current) => { const next = new Set(current); next.delete(sessionId); return next; });
      setDeleteTarget(null);
      onDeleted?.(sessionId);
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      void queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['admin-monitor'] });
    },
  });
  const table = useTableModel(sessions, [
    { key: 'name', title: '会话名称', value: (session) => sessionTitle(session, displayNames[session.id]) },
    { key: 'client', title: '客户端', value: sessionKind },
    { key: 'created', title: '创建时间', value: (session) => session.created_at, kind: 'date', format: (value) => fmtDateTime(String(value ?? '')) },
    { key: 'updated', title: '最近更新', value: sessionActivity, kind: 'date', format: (value) => fmtDateTime(String(value ?? '')) },
    { key: 'summary', title: '内容摘要', value: sessionSummary },
  ], { key: 'updated', direction: 'desc' });
  const visibleSessions = table.rows;

  const toggleExpanded = (id: string) => setExpandedIds((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  return <div className="flex h-full flex-col" style={{ background: 'var(--bg-secondary)' }}>
    <div className="flex shrink-0 items-center gap-2 px-3 py-2" style={{ borderBottom: '1px solid var(--border)' }}>
      <Clock className="h-4 w-4" style={{ color: 'var(--accent)' }} />
      <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>项目会话</span>
      <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{visibleSessions.length}/{sessions.length}</span>
      <button onClick={() => refetch()} title="刷新" className="ml-auto rounded p-1 hover:opacity-80" style={{ color: 'var(--text-secondary)' }}><RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} /></button>
    </div>
    <div className="flex-1 overflow-auto">
      <DataTable label="会话历史" model={table} minWidth={1180} expandable actions columnWidths={['w-[23%]', 'w-28', 'w-44', 'w-44', '']}
        loading={isLoading} error={isError ? `加载失败: ${(error as Error)?.message || '未知错误'}` : undefined} onRetry={() => { void refetch(); }}
        empty={visibleSessions.length === 0} emptyMessage={sessions.length ? '没有匹配的会话' : '这个项目还没有会话'}>
                {visibleSessions.map((session) => <ProjectSessionRow key={session.id} session={session} isOpen={openTabIds.has(session.id)} displayName={displayNames[session.id]} expanded={expandedIds.has(session.id)} onToggle={() => toggleExpanded(session.id)} onOpen={onOpen}
                  deleting={deletion.isPending} onDelete={(target) => { deletion.reset(); setDeleteTarget(target); }} />)}
      </DataTable>
    </div>
    {deleteTarget && <Dialog title="删除会话" busy={deletion.isPending} onClose={() => setDeleteTarget(null)}>
      <p className="break-words text-sm">确定删除“{sessionTitle(deleteTarget, displayNames[deleteTarget.id])}”？</p>
      <p className="mt-2 text-xs" style={{ color: 'var(--text-secondary)' }}>会话记录及已保存的输出将被永久删除，无法撤销。</p>
      {deletion.error && <p role="alert" className="mt-3 text-xs" style={{ color: 'var(--error)' }}>删除失败：{deletion.error.message}</p>}
      <footer className="mt-4 flex justify-end gap-2">
        <TableActionButton disabled={deletion.isPending} onClick={() => setDeleteTarget(null)}>取消</TableActionButton>
        <TableActionButton disabled={deletion.isPending} style={{ background: 'var(--error)', borderColor: 'var(--error)', color: '#fff' }}
          onClick={() => { if (!deletion.isPending) deletion.mutate(deleteTarget.id); }}>{deletion.isPending ? '删除中…' : '删除会话'}</TableActionButton>
      </footer>
    </Dialog>}
  </div>;
}
