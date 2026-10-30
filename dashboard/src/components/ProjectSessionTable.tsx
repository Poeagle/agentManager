import { TableActionButton } from './table/TableActions';
import { useQuery } from '@tanstack/react-query';
import { api, type Session } from '../lib/api';
import { useStreamStore } from '../lib/websocket';
import { DataTable } from './table/DataTable';
import { tableTime, useTableModel } from './table/use-table-model';

const states: Record<string, string> = { pending: '等待启动', launching: '启动中', running: '运行中', detached: '已分离', released: '外部运行', completed: '已完成', failed: '失败', cancelled: '已关闭' };
const activeStatuses = new Set(['running', 'pending', 'launching', 'detached', 'released']);
function state(session: Session) {
  if(session.cli_type==='codex') return ({running:'Codex 运行中',idle:'本轮已结束',waiting_for_input:'等待输入',interrupted:'本轮已中断',failed:'执行失败',unknown:'原生状态未知'})[session.agent_runtime?.state || 'unknown'];
  return session.status === 'running' && session.processState
  ? ({ busy: '处理中', idle: '空闲', waiting_for_input: '等待输入' })[session.processState] : states[session.status] ?? session.status; }
function client(session: Session) { return session.mode === 'terminal' || session.task === 'Terminal' ? 'Terminal' : session.cli_type === 'codex' ? 'Codex' : 'Claude'; }
function activity(session: Session) { return session.cli_type==='codex' ? session.agent_runtime?.last_activity_at ?? null : session.last_activity_at ?? session.updated_at ?? session.started_at ?? session.created_at; }

export function ProjectSessionTable({ projectId, onOpen }: { projectId: string; onOpen: (sessionId: string) => void }) {
  const query = useQuery({ queryKey: ['project-sessions', projectId], queryFn: () => api.sessions.list(undefined, projectId), staleTime: 10_000, refetchInterval:(query)=>query.state.data?.sessions.some(session=>session.cli_type==='codex') ? 5000 : false });
  const liveStates = useStreamStore((store) => store.liveStates);
  const activityAt = useStreamStore((store) => store.activityAt);
  const sessions = (query.data?.sessions ?? []).filter((session) => session.project_id === projectId && activeStatuses.has(session.status)).map((session) => {
    const live = session.cli_type==='codex' ? undefined : liveStates[session.id];
    const at = session.cli_type==='codex' ? undefined : activityAt[session.id];
    return { ...session,
      ...(session.status === 'running' && live ? { processState: live.processState } : {}),
      ...(at && at > (tableTime(activity(session)) ?? 0) ? { last_activity_at: new Date(at).toISOString() } : {}),
    };
  });
  const table = useTableModel(sessions, [
    { key: 'name', title: '会话', value: (session) => session.task },
    { key: 'client', title: '客户端', value: client },
    { key: 'state', title: '状态', value: state },
    { key: 'activity', title: '最近活动', value: activity, kind: 'date', format: (value) => tableTime(value) == null ? '—' : new Date(tableTime(value)!).toLocaleString('zh-CN', { hour12: false }) },
    { key: 'content', title: '内容摘要', value: (session) => session.content_summary ?? session.task },
  ]);
  return <DataTable label="项目会话" model={table} minWidth={850} actions columnWidths={['w-52', 'w-28', 'w-28', 'w-44', '']}
    loading={query.isPending} error={query.error ? `会话加载失败：${query.error.message}` : undefined} onRetry={() => { void query.refetch(); }}
    empty={table.rows.length === 0} emptyMessage={sessions.length ? '没有匹配的会话' : '该项目暂无活动会话'}>
    {table.rows.map((session) => <tr key={session.id}><td className="truncate" title={session.task}>{session.task}</td><td>{client(session)}</td>
        <td style={{ color: ['failed', 'cancelled'].includes(session.status) ? 'var(--text-secondary)' : 'var(--success)' }}>{state(session)}</td>
        <td className="whitespace-nowrap">{tableTime(activity(session)) == null ? '—' : new Date(tableTime(activity(session))!).toLocaleString('zh-CN', { hour12: false })}</td>
        <td className="max-w-96 truncate" title={session.content_summary ?? session.task}>{session.content_summary ?? session.task}</td>
        <td><TableActionButton  onClick={() => onOpen(session.id)}>查看</TableActionButton></td></tr>)}
      </DataTable>;
}
