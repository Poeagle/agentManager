import { TableActionButton, TableActions } from './table/TableActions';
import { RowActionsMenu } from './table/RowActionsMenu';
import { useTableModel } from './table/use-table-model';
import { DataTable, TableExpandButton, TableDetailRow, TableStateRow } from './table/DataTable';
import { Children, isValidElement, type ReactElement, Fragment, createContext, useContext, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronsUpDown,
  CircleHelp,
  FolderOpen,
  ExternalLink,
  Pencil,
  RefreshCw,
  Search,
  TerminalSquare,
  Trash2,
  X,
} from 'lucide-react';
import {
  api,
  type AdminMonitorProject,
  type AdminMonitorResponse,
  type AdminMonitorSession,
  type AdminMonitorTab,
  type AdminMonitorUser,
} from '../lib/api';
import { useServerResources } from '../lib/use-server-resources';

const ACTIVE_STATUSES = new Set(['pending', 'launching', 'running', 'detached', 'released']);

const STATUS_META: Record<string, { label: string; description: string; color: string }> = {
  pending: { label: '等待启动', description: '会话已创建，正在等待分配终端进程。', color: '#f59e0b' },
  launching: { label: '启动中', description: '终端和 Agent 进程正在初始化。', color: '#f59e0b' },
  running: { label: '运行中', description: '会话进程仍在运行，可继续交互。', color: 'var(--success)' },
  detached: { label: '已分离', description: '页面连接已断开，但后台进程仍在运行。', color: '#f59e0b' },
  released: { label: '外部运行', description: '会话已弹出到外部终端，仍占用系统资源。', color: '#f59e0b' },
  completed: { label: '已完成', description: '进程已正常结束，仅保留历史记录。', color: 'var(--text-secondary)' },
  failed: { label: '失败', description: '会话因错误退出。', color: 'var(--error)' },
  cancelled: { label: '已取消', description: '会话被用户或管理员主动停止。', color: 'var(--error)' },
};

const PROCESS_META: Record<string, { label: string; description: string; color: string }> = {
  busy: { label: '处理中', description: 'Agent 正在生成内容或执行工具。', color: '#60a5fa' },
  idle: { label: '本轮完成', description: 'Agent 已停止生成，可以输入下一条指令。', color: 'var(--success)' },
  waiting_for_input: { label: '等待输入', description: '需要用户输入、确认或授权后才能继续。', color: '#f59e0b' },
};

function parseServerTime(value: string | null): number | null {
  if (!value) return null;
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const time = Date.parse(normalized);
  return Number.isNaN(time) ? null : time;
}

function absoluteTime(value: string | null): string {
  const time = parseServerTime(value);
  return time === null ? '暂无记录' : new Date(time).toLocaleString();
}

function relativeTime(value: string | null, referenceTime: number): string {
  const time = parseServerTime(value);
  if (time === null) return '暂无活动';
  const seconds = Math.max(0, Math.floor((referenceTime - time) / 1000));
  if (seconds < 10) return '刚刚';
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes < 100 * 1024 * 1024 ? 1 : 0)} MiB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  const minutes = Math.floor((seconds % 3_600) / 60);
  return hours > 0 ? `${hours} 小时 ${minutes} 分钟` : `${minutes} 分钟`;
}

function statusMeta(status: string) {
  return STATUS_META[status] ?? { label: status, description: '服务器返回的会话生命周期状态。', color: 'var(--text-secondary)' };
}

function sessionType(session: AdminMonitorSession): string {
  if (session.mode === 'terminal') return '终端';
  return session.cli_type === 'codex' ? 'Codex 会话' : 'Claude 会话';
}

function tabIcon() {
  return <TerminalSquare className="h-4 w-4" />;
}

function toggleSet(setter: Dispatch<SetStateAction<Set<string>>>, key: string) {
  setter((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
}

const MonitorPermissions = createContext({ canWrite: true, canDelete: true, canOpenSessions: true });

export function AdminMonitorPage({ onBack, onOpenSession, canWrite = true, canDelete = true, canOpenSessions = true }: {
  onBack: () => void;
  onOpenSession: (projectId: string, sessionId: string) => void;
  canWrite?: boolean;
  canDelete?: boolean;
  canOpenSessions?: boolean;
}) {
  const [search, setSearch] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [showStatusHelp, setShowStatusHelp] = useState(false);
  const [expandedUsers, setExpandedUsers] = useState<Set<string>>(new Set());
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const resourceQuery = useServerResources();
  const { data, error, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['admin-monitor'],
    queryFn: () => api.admin.monitor(),
    refetchInterval: 5_000,
    refetchOnWindowFocus: true,
  });

  const query = search.trim().toLocaleLowerCase();
  const users = useMemo(() => (data?.users ?? [])
    .map((user) => {
      const userMatches = [user.username, user.display_name].join('\n').toLocaleLowerCase().includes(query);
      const projects = user.projects
        .filter((project) => project.is_open || (showHistory && project.sessions.length > 0))
        .map((project) => ({
          project,
          sessions: project.sessions.filter((session) => showHistory || ACTIVE_STATUSES.has(session.status)),
        }))
        .filter(({ project, sessions }) => {
          if (!query || userMatches) return true;
          return [
            project.name,
            project.custom_name ?? '',
            project.path ?? '',
            ...project.tabs.flatMap((tab) => [tab.name, tab.id]),
            ...sessions.flatMap((session) => [session.task, session.id]),
          ].join('\n').toLocaleLowerCase().includes(query);
        });
      return { user, projects, matches: !query || userMatches || projects.length > 0 };
    })
    .filter(({ matches }) => matches)
    .sort((a, b) => b.user.active_sessions - a.user.active_sessions || Number(b.user.online) - Number(a.user.online)),
  [data, query, showHistory]);

  const usersTable = useTableModel(users, [
    { key: 'user', title: '用户', value: ({ user }) => `${user.display_name || user.username} @${user.username}` },
    { key: 'status', title: '状态', value: ({ user }) => user.disabled ? '已禁用' : user.online ? '在线' : '离线' },
    { key: 'projects', title: '打开项目', value: ({ user }) => user.open_projects },
    { key: 'tabs', title: '会话标签', value: ({ projects }) => projects.filter(({ project }) => project.is_open).reduce((sum, { project }) => sum + project.tabs.length, 0) },
    { key: 'sessions', title: '活动会话', value: ({ user }) => user.active_sessions },
    { key: 'memory', title: '内存', value: ({ user }) => user.memory_bytes, format: (value) => formatBytes(typeof value === 'number' ? value : null) },
    { key: 'login', title: '登录活动', value: ({ user }) => user.last_seen_at, kind: 'date', format: (value) => absoluteTime(value == null ? null : String(value)) },
  ]);
  const referenceTime = parseServerTime(data?.generated_at ?? null) ?? 0;
  const onlineUsers = data?.users.filter((user) => user.online).length ?? 0;
  const openProjects = data?.users.reduce((total, user) => total + user.open_projects, 0) ?? 0;
  const openTabs = data?.users.reduce(
    (total, user) => total + user.projects.filter((project) => project.is_open).reduce((sum, project) => sum + project.tabs.length, 0),
    0,
  ) ?? 0;
  const allCollapsed = users.length > 0 && users.every(({ user }) => !expandedUsers.has(user.id));

  return (
    <MonitorPermissions.Provider value={{ canWrite, canDelete, canOpenSessions }}>
    <div className="h-full overflow-y-auto" style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
      <div className="page-content flex min-h-full flex-col py-3">
        <header className="mb-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2"><TableActionButton onClick={onBack} title="返回" ><ArrowLeft className="h-3.5 w-3.5" /></TableActionButton><h1 className="text-base font-semibold">用户与会话监控</h1></div>
          <div className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--text-secondary)' }}>{data ? `采样于 ${absoluteTime(data.generated_at)}` : '读取中'}<TableActionButton onClick={() => { void refetch(); }} disabled={isFetching}  title="立即刷新"><RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} /></TableActionButton></div>
        </header>

        <ServerResourceOverview resources={resourceQuery.data?.server_resources} loading={resourceQuery.isLoading} />

        <div className="my-2 flex flex-wrap gap-x-5 gap-y-1 text-xs" style={{ color: 'var(--text-secondary)' }}><span>运行用户 {data?.active_users ?? 0} · 在线 {onlineUsers}</span><span>活动会话 {data?.active_sessions ?? 0}</span><span>会话内存 {formatBytes(data?.total_memory_bytes ?? 0)}</span><span>打开项目 / 标签 {openProjects} / {openTabs}</span></div>

        <div className="flex flex-col gap-2 py-2 xl:flex-row xl:items-center xl:justify-between">
          <label className="relative block w-full xl:max-w-md">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索用户、项目、会话标签、任务或会话 ID" className="w-full rounded-md py-1.5 pl-9 pr-3 text-sm outline-none transition-colors focus:ring-1" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => setShowStatusHelp((value) => !value)} aria-expanded={showStatusHelp} className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors hover:bg-white/5" style={{ color: showStatusHelp ? 'var(--accent)' : 'var(--text-secondary)', border: '1px solid var(--border)' }}>
              <CircleHelp className="h-3.5 w-3.5" />状态说明
            </button>
            <button
              onClick={() => {
                if (allCollapsed) setExpandedUsers(new Set(users.map(({ user }) => user.id)));
                else setExpandedUsers(new Set());
              }}
              className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors hover:bg-white/5"
              style={{ color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
            >
              <ChevronsUpDown className="h-3.5 w-3.5" />{allCollapsed ? '展开全部用户' : '收起全部用户'}
            </button>
            <label className="flex cursor-pointer select-none items-center gap-2 rounded-md px-2.5 py-1 text-xs" style={{ color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
              <button type="button" role="switch" aria-label="显示最近已结束会话" aria-checked={showHistory} onClick={() => setShowHistory((value) => !value)} className="relative h-5 w-9 rounded-full transition-colors" style={{ background: showHistory ? 'var(--accent)' : 'var(--bg-tertiary)', border: '1px solid var(--border)' }}>
                <span className="absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white transition-transform" style={{ left: 2, transform: showHistory ? 'translateX(16px)' : 'translateX(0)' }} />
              </button>
              显示历史
            </label>
          </div>
        </div>

        {showStatusHelp && <StatusGuide />}

          <DataTable label="用户监控" model={usersTable} minWidth={700} expandable className="mb-3"
            loading={isLoading} error={error ? error instanceof Error ? error.message : '监控数据加载失败' : undefined}
            onRetry={() => { void refetch(); }} empty={usersTable.rows.length === 0} emptyMessage="没有匹配的用户、项目或会话标签">
            {usersTable.rows.map(({ user, projects }) => {
              const collapsed = !query && !expandedUsers.has(user.id);
              return (
                <UserTree
                  key={user.id}
                  user={user}
                  projects={projects}
                  collapsed={collapsed}
                  onToggle={() => toggleSet(setExpandedUsers, user.id)}
                  expandedProjects={query ? new Set(projects.map(({ project }, index) => `${user.id}:${project.id ?? `unassigned-${index}`}`)) : expandedProjects}
                  onToggleProject={(key) => toggleSet(setExpandedProjects, key)}
                  referenceTime={referenceTime}
                  showHistory={showHistory}
                  onOpenSession={onOpenSession}
                  onChanged={() => refetch()}
                />
              );
            })}
          </DataTable>
      </div>
    </div>
    </MonitorPermissions.Provider>
  );
}

function StatusGuide() {
  return (
    <section className="mb-4 overflow-hidden rounded-xl" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
      <div className="border-b px-4 py-3" style={{ borderColor: 'var(--border)' }}>
        <div className="text-sm font-semibold">如何理解状态</div>
        <p className="mt-1 text-xs" style={{ color: 'var(--text-secondary)' }}>生命周期说明会话是否还存在；工作状态说明正在运行的 Agent 此刻在做什么，两者会同时出现。</p>
      </div>
      <div className="grid gap-px lg:grid-cols-2" style={{ background: 'var(--border)' }}>
        <GuideGroup title="会话生命周期" items={STATUS_META} />
        <GuideGroup title="实时工作状态" items={PROCESS_META} />
      </div>
    </section>
  );
}

function GuideGroup({ title, items }: { title: string; items: Record<string, { label: string; description: string; color: string }> }) {
  return (
    <div className="p-4" style={{ background: 'var(--bg-secondary)' }}>
      <div className="mb-3 text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>{title}</div>
      <div className="grid gap-2 sm:grid-cols-2">
        {Object.entries(items).map(([key, item]) => (
          <div key={key} className="flex items-start gap-2">
            <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: item.color }} />
            <div><div className="text-xs font-medium">{item.label}</div><div className="mt-0.5 text-[10px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>{item.description}</div></div>
          </div>
        ))}
      </div>
    </div>
  );
}

function UserTree({ user, projects, collapsed, onToggle, expandedProjects, onToggleProject, referenceTime, showHistory, onOpenSession, onChanged }: {
  user: AdminMonitorUser; projects: Array<{ project: AdminMonitorProject; sessions: AdminMonitorSession[] }>;
  collapsed: boolean; onToggle: () => void; expandedProjects: Set<string>; onToggleProject: (key: string) => void;
  referenceTime: number; showHistory: boolean; onOpenSession: (projectId: string, sessionId: string) => void; onChanged: () => Promise<unknown>;
}) {
  const projectsTable = useTableModel(projects, [
    { key: 'project', title: '项目', value: ({ project }) => project.custom_name || project.name },
    { key: 'path', title: '路径', value: ({ project }) => project.path },
    { key: 'state', title: '状态', value: ({ project }) => project.is_active ? '当前项目' : project.is_open ? '已打开' : '历史' },
    { key: 'tabs', title: '会话标签', value: ({ project }) => project.tabs.length },
    { key: 'sessions', title: '活动会话', value: ({ sessions }) => sessions.filter((session) => ACTIVE_STATUSES.has(session.status)).length },
    { key: 'memory', title: '内存', value: ({ sessions }) => sessions.reduce((sum, session) => sum + (session.memory_bytes ?? 0), 0), format: (value) => formatBytes(typeof value === 'number' ? value : null) },
  ]);
  const tabCount = projects.filter(({ project }) => project.is_open).reduce((sum, { project }) => sum + project.tabs.length, 0);
  return <Fragment>
    <tr>
      <td><TableExpandButton expanded={!collapsed} label={`用户 ${user.username}`} onClick={onToggle} /></td>
      <td className="whitespace-nowrap"><span className="font-medium">{user.display_name || user.username}</span><span className="ml-2 text-[11px]" style={{ color: 'var(--text-secondary)' }}>@{user.username}</span></td>
      <td><span className="inline-flex items-center gap-1.5 whitespace-nowrap"><span className="h-1.5 w-1.5 rounded-full" style={{ background: user.disabled ? 'var(--error)' : user.online ? 'var(--success)' : 'var(--text-muted)' }} />{user.disabled ? '已禁用' : user.online ? '在线' : '离线'}</span></td>
      <td>{user.open_projects}</td><td>{tabCount}</td><td>{user.active_sessions}{user.role === 'member' ? ` / ${user.max_tabs ?? 10}` : ''}</td><td className="whitespace-nowrap">{formatBytes(user.memory_bytes)}</td><td className="whitespace-nowrap" title={absoluteTime(user.last_seen_at)}>{relativeTime(user.last_seen_at, referenceTime)}</td>
    </tr>
    {!collapsed && <TableDetailRow columnCount={8}>
      <DataTable label={`${user.username} 的项目`} model={projectsTable} minWidth={850} expandable columnWidths={['w-48', '', 'w-24', 'w-32', 'w-32', 'w-28']}
        empty={projectsTable.rows.length === 0} emptyMessage={showHistory ? '暂无项目或会话记录。' : '当前没有打开的项目。'}>{projectsTable.rows.map((entry) => {
        const { project, sessions } = entry;
        const index = projects.indexOf(entry);
        const key = `${user.id}:${project.id ?? `unassigned-${index}`}`;
        return <ProjectTree key={key} userId={user.id} project={project} sessions={sessions} collapsed={!expandedProjects.has(key)} onToggle={() => onToggleProject(key)} referenceTime={referenceTime} showHistory={showHistory} onOpenSession={onOpenSession} onChanged={onChanged} />;
      })}</DataTable>
    </TableDetailRow>}
  </Fragment>;
}

function ProjectTree({ userId, project, sessions, collapsed, onToggle, referenceTime, showHistory, onOpenSession, onChanged }: {
  userId: string; project: AdminMonitorProject; sessions: AdminMonitorSession[]; collapsed: boolean; onToggle: () => void;
  referenceTime: number; showHistory: boolean; onOpenSession: (projectId: string, sessionId: string) => void; onChanged: () => Promise<unknown>;
}) {
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const tabIds = new Set(project.tabs.filter((tab) => tab.kind === 'session').map((tab) => tab.id));
  const background = sessions.filter((session) => !tabIds.has(session.id));
  return <Fragment>
    <tr><td><TableExpandButton expanded={!collapsed} label={`项目 ${project.name}`} onClick={onToggle} /></td><td><span className="flex items-center gap-2"><FolderOpen className="h-3.5 w-3.5" style={{ color: 'var(--accent)' }} />{project.custom_name || project.name}</span></td><td><div className="max-w-96 truncate" title={project.path ?? undefined}>{project.path || '未关联'}</div></td><td>{project.is_active ? '当前项目' : project.is_open ? '已打开' : '历史'}</td><td>{project.tabs.length}</td><td>{sessions.filter((session) => ACTIVE_STATUSES.has(session.status)).length}</td><td className="whitespace-nowrap">{formatBytes(sessions.reduce((sum, session) => sum + (session.memory_bytes ?? 0), 0))}</td></tr>
    {!collapsed && <TableDetailRow columnCount={7}><SessionTable>
      {project.tabs.map((tab) => <TabRow key={`${tab.kind}:${tab.id}`} userId={userId} projectId={project.id!} tab={tab} session={sessionById.get(tab.id)} referenceTime={referenceTime} onOpen={() => project.id && onOpenSession(project.id, tab.id)} onChanged={onChanged} />)}
      {background.map((session) => <BackgroundSessionRow key={session.id} session={session} referenceTime={referenceTime} onOpen={() => project.id && onOpenSession(project.id, session.id)} />)}
      {project.tabs.length === 0 && background.length === 0 && <TableStateRow columnCount={6}>{showHistory ? '暂无会话记录' : '暂无活动会话，可打开“显示历史”查看已结束会话'}</TableStateRow>}
    </SessionTable></TableDetailRow>}
  </Fragment>;
}

function SessionTable({ children }: { children: ReactNode }) {
  const elements = Children.toArray(children).filter(isValidElement) as Array<ReactElement<{ tab?: AdminMonitorTab; session?: AdminMonitorSession }>>;
  const records = elements.filter((element) => element.props.tab || element.props.session);
  const table = useTableModel(records, [
    { key: 'name', title: '会话标签', value: ({ props }) => props.tab?.name ?? props.session?.task },
    { key: 'state', title: '实时状态', value: ({ props }) => props.session ? props.session.process_state ? PROCESS_META[props.session.process_state].label : statusMeta(props.session.status).label : '未运行' },
    { key: 'content', title: '待处理信息 / 最新结果', value: ({ props }) => props.session?.last_output },
    { key: 'memory', title: '内存 / 进程', value: ({ props }) => props.session?.memory_bytes, format: (value) => formatBytes(typeof value === 'number' ? value : null) },
    { key: 'activity', title: '最后活动', value: ({ props }) => props.session?.last_activity_at, kind: 'date', format: (value) => absoluteTime(value == null ? null : String(value)) },
  ]);
  return (
    <DataTable label="会话监控" model={table} minWidth={850} actions columnWidths={['w-[180px]', 'w-[125px]', '', 'w-[125px]', 'w-[125px]']}>{records.length ? table.rows.length ? table.rows : <TableStateRow columnCount={6}>没有匹配的会话</TableStateRow> : children}</DataTable>
  );
}

function TabRow({ userId, projectId, tab, session, referenceTime, onOpen, onChanged }: {
  userId: string;
  projectId: string;
  tab: AdminMonitorTab;
  session: AdminMonitorSession | undefined;
  referenceTime: number;
  onOpen: () => void;
  onChanged: () => Promise<unknown>;
}) {
  const { canWrite, canDelete, canOpenSessions } = useContext(MonitorPermissions);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(tab.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const kindLabel = session ? sessionType(session) : '会话标签';

  const saveName = async () => {
    const value = name.trim();
    if (!value) return setActionError('标签名称不能为空');
    setBusy(true);
    setActionError('');
    try {
      await api.admin.renameMonitorTab(userId, projectId, tab.id, value);
      setEditing(false);
      await onChanged();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '改名失败');
    } finally {
      setBusy(false);
    }
  };

  const deleteTab = async () => {
    setBusy(true);
    setActionError('');
    try {
      await api.admin.deleteMonitorTab(userId, projectId, tab.id);
      setConfirmDelete(false);
      await onChanged();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '删除标签失败');
      setConfirmDelete(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr className="group" style={{ borderTop: '1px solid var(--border)' }}>
      <td >
        <div className="flex items-center gap-2.5">
          <span className="shrink-0" style={{ color: tab.is_active ? 'var(--accent)' : 'var(--text-secondary)' }}>{tabIcon()}</span>
        {editing ? (
          <div className="min-w-0 flex-1">
            <label className="sr-only" htmlFor={`monitor-tab-name-${tab.id}`}>会话标签名称</label>
            <input
              id={`monitor-tab-name-${tab.id}`}
              autoFocus
              value={name}
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') { event.preventDefault(); void saveName(); }
                if (event.key === 'Escape') { setName(tab.name); setEditing(false); setActionError(''); }
              }}
              className="w-full rounded px-2 py-1 text-xs outline-none focus:ring-1"
              style={{ background: 'var(--bg-primary)', border: '1px solid var(--accent)', color: 'var(--text-primary)' }}
            />
          </div>
        ) : (
          <button onClick={onOpen} disabled={!session || !canOpenSessions} className="min-w-0 flex-1 text-left disabled:cursor-default" title={session && canOpenSessions ? `打开 ${tab.name}` : '查看会话监控信息'}>
            <span className="flex items-center gap-2">
              <span className="truncate font-semibold">{tab.name}</span>
              {tab.is_active && <span className="shrink-0 rounded px-1 py-0.5 text-[9px]" style={{ color: 'var(--accent)', background: 'color-mix(in srgb, var(--accent) 12%, transparent)' }}>当前</span>}
              {session && <ExternalLink className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-60" />}
            </span>
            <span className="mt-1 block truncate text-[10px]" title={session?.task} style={{ color: 'var(--text-muted)' }}>
              {kindLabel}{session && session.task !== tab.name ? ` · ${session.task}` : ''}
            </span>
          </button>
        )}
        </div>
        {actionError && <div className="mt-1 text-[10px]" style={{ color: 'var(--error)' }}>{actionError}</div>}
      </td>
      <td >{session ? <ExecutionState session={session} /> : <span style={{ color: 'var(--text-muted)' }}>无采样</span>}</td>
      <td >
        {session ? <OutputInsight session={session} /> : <span style={{ color: 'var(--text-muted)' }}>暂无可判断信息</span>}
      </td>
      <td className="text-right font-mono tabular-nums">
        <div>{formatBytes(session?.memory_bytes ?? null)}</div>
        <div className="mt-0.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>{session ? `${session.process_count} 个进程` : '—'}</div>
      </td>
      <td className="text-right">
        <div title={absoluteTime(session?.last_activity_at ?? null)}>{relativeTime(session?.last_activity_at ?? null, referenceTime)}</div>
        <div className="mt-0.5 font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>{session?.id.slice(0, 8) ?? '—'}</div>
      </td>
      <td className="text-right">
        <TableActions>
          {editing ? (
            <>
              <TableActionButton onClick={() => void saveName()} disabled={busy} style={{ color: 'var(--success)' }} title="保存名称"><Check className="h-3.5 w-3.5" /></TableActionButton>
              <TableActionButton onClick={() => { setName(tab.name); setEditing(false); setActionError(''); }} disabled={busy} title="取消改名"><X className="h-3.5 w-3.5" /></TableActionButton>
            </>
          ) : (
            <>
              {canOpenSessions && <TableActionButton onClick={onOpen} disabled={!session} style={{ color: 'var(--accent)' }} aria-label={`打开会话标签 ${tab.name}`}><ExternalLink className="h-3.5 w-3.5" /></TableActionButton>}
              <RowActionsMenu label={`${tab.name} 的更多操作`} actions={[
                ...(canWrite ? [{ label: '重命名', icon: <Pencil className="h-3.5 w-3.5" />, onClick: () => { setName(tab.name); setEditing(true); setActionError(''); } }] : []),
                ...(canDelete ? [{ label: '删除标签', icon: <Trash2 className="h-3.5 w-3.5" />, danger: true, onClick: () => setConfirmDelete(true) }] : []),
              ]} />
            </>
          )}
        </TableActions>
        {confirmDelete && createPortal(
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => !busy && setConfirmDelete(false)}>
          <div className="w-full max-w-sm rounded-xl p-5 shadow-2xl" style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)' }} onClick={(event) => event.stopPropagation()}>
            <div className="flex items-start gap-3">
              <span className="rounded-full p-2" style={{ color: '#f59e0b', background: 'rgba(245,158,11,.12)' }}><AlertTriangle className="h-5 w-5" /></span>
              <div><h3 className="text-sm font-semibold">删除会话标签？</h3><p className="mt-2 text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>将从用户页面移除“{tab.name}”标签。{session && ACTIVE_STATUSES.has(session.status) ? '会话进程不会终止，将继续在后台运行。' : '这不会删除会话历史记录。'}</p></div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setConfirmDelete(false)} disabled={busy} className="rounded-md px-3 py-1.5 text-xs disabled:opacity-40" style={{ color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>取消</button>
              <button onClick={() => void deleteTab()} disabled={busy} className="rounded-md px-3 py-1.5 text-xs text-white disabled:opacity-40" style={{ background: 'var(--error)' }}>{busy ? '删除中…' : '仅删除标签'}</button>
            </div>
          </div>
          </div>,
          document.body,
        )}
      </td>
    </tr>
  );
}

function BackgroundSessionRow({ session, referenceTime, onOpen }: { session: AdminMonitorSession; referenceTime: number; onOpen: () => void }) {
  const { canOpenSessions } = useContext(MonitorPermissions);
  return (
    <tr  style={{ borderTop: '1px solid var(--border)' }}>
      <td ><button onClick={onOpen} disabled={!canOpenSessions} className="flex min-w-0 items-center gap-2 text-left"><TerminalSquare className="h-4 w-4 shrink-0" style={{ color: 'var(--text-muted)' }} /><span className="min-w-0"><span className="block truncate font-semibold" title={session.task}>{session.task}</span><span className="mt-0.5 block text-[10px]" style={{ color: 'var(--text-muted)' }}>{sessionType(session)} · 后台会话</span></span></button></td>
      <td ><ExecutionState session={session} /></td>
      <td ><OutputInsight session={session} /></td>
      <td className="text-right font-mono tabular-nums"><div>{formatBytes(session.memory_bytes)}</div><div className="mt-0.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>{session.process_count} 个进程</div></td>
      <td className="text-right"><div title={absoluteTime(session.last_activity_at)}>{relativeTime(session.last_activity_at, referenceTime)}</div><div className="mt-0.5 font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>{session.id.slice(0, 8)}</div></td>
      <td><TableActions><TableActionButton onClick={onOpen} disabled={!canOpenSessions} style={{ color: 'var(--accent)' }} aria-label={`打开后台会话 ${session.task}`}><ExternalLink className="h-3.5 w-3.5" /></TableActionButton></TableActions></td>
    </tr>
  );
}

function ExecutionState({ session }: { session: AdminMonitorSession }) {
  const process = session.process_state ? PROCESS_META[session.process_state] : null;
  const actionLabel = session.is_permission
    ? '等待授权确认'
    : session.process_state === 'waiting_for_input'
      ? '等待用户输入'
      : session.process_state === 'busy'
        ? session.mode === 'terminal' ? '终端正在输出' : '会话正在执行'
        : session.process_state === 'idle'
          ? session.mode === 'terminal' ? '终端空闲' : '本轮任务已完成'
          : null;
  const actionColor = session.is_permission || session.process_state === 'waiting_for_input' ? '#f59e0b' : process?.color;
  return (
    <div>
      <StatusBadge status={session.status} />
      {actionLabel && <div className="mt-1.5 flex items-center gap-1.5 text-[10px] font-medium" style={{ color: actionColor }}><span className="h-1.5 w-1.5 rounded-full" style={{ background: actionColor }} />{actionLabel}</div>}
    </div>
  );
}

function OutputInsight({ session }: { session: AdminMonitorSession }) {
  const needsAction = session.is_permission || session.process_state === 'waiting_for_input';
  const label = session.is_permission
    ? '需要授权'
    : session.process_state === 'waiting_for_input'
      ? '需要输入'
      : session.process_state === 'busy'
        ? '执行进展'
        : '最新结果';
  const fallback = needsAction
    ? '检测到会话正在等待你处理，点击进入查看完整提示。'
    : session.process_state === 'busy'
      ? '会话正在执行，尚未产生可汇总的结果。'
      : '尚未获取到有意义的 会话输出。';
  return (
    <div className="leading-tight">
      <div className="mb-0.5 text-[9px] font-semibold uppercase tracking-wider" style={{ color: needsAction ? '#f59e0b' : 'var(--text-muted)' }}>{label}</div>
      <div className="truncate" title={session.last_output ?? undefined} style={{ color: session.last_output ? 'var(--text-primary)' : 'var(--text-muted)' }}>{session.last_output || fallback}</div>
      {session.choices && session.choices.length > 0 && (
        <div className="mt-1 truncate text-[10px]" style={{ color: '#f59e0b' }}>可选：{session.choices.slice(0, 4).join(' / ')}</div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const meta = statusMeta(status);
  return <span title={meta.description} className="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium" style={{ color: meta.color, background: `color-mix(in srgb, ${meta.color} 11%, transparent)` }}>{meta.label}</span>;
}

type ServerResources = NonNullable<AdminMonitorResponse['server_resources']>;

function ServerResourceOverview({ resources, loading }: { resources: ServerResources | undefined; loading: boolean }) {
  const table = useTableModel([resources], [
    { key: 'host', title: '服务器', value: (resource) => resource?.hostname },
    { key: 'cpu', title: 'CPU', value: (resource) => resource?.cpu.usage_percent, format: (value) => typeof value === 'number' ? `${Math.round(value)}%` : '—' },
    { key: 'memory', title: '内存', value: (resource) => resource?.memory.used_bytes, format: (value) => formatBytes(typeof value === 'number' ? value : null) },
    { key: 'disk', title: '磁盘', value: (resource) => resource?.disk?.used_bytes, format: (value) => formatBytes(typeof value === 'number' ? value : null) },
  ]);
  return <section aria-label="服务器资源"><DataTable label="服务器资源概览" model={table} minWidth={640}>{table.rows.length > 0 && <tr>
    <td>{resources?.hostname ?? (loading ? '采样中…' : '—')}<span className="ml-2 text-[11px]" style={{ color: 'var(--text-secondary)' }}>{resources ? `运行 ${formatUptime(resources.uptime_seconds)}` : ''}</span></td>
    <td><span>{resources ? `${Math.round(resources.cpu.usage_percent)}%` : '—'}</span>{resources && <span className="ml-2 text-[11px]" style={{ color: 'var(--text-secondary)' }}>{resources.cpu.core_count} 核</span>}</td>
    <td>{resources ? `${Math.round(resources.memory.usage_percent)}% · ${formatBytes(resources.memory.used_bytes)} / ${formatBytes(resources.memory.total_bytes)}` : '—'}</td>
    <td>{resources?.disk ? `${Math.round(resources.disk.usage_percent)}% · ${formatBytes(resources.disk.used_bytes)} / ${formatBytes(resources.disk.total_bytes)}` : '—'}</td>
  </tr>}</DataTable></section>;
}
