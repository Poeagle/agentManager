import { useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  CircleHelp,
  Cpu,
  FolderOpen,
  HardDrive,
  ExternalLink,
  Loader2,
  MemoryStick,
  Pencil,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  TerminalSquare,
  Trash2,
  Users,
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
  if (session.mode === 'agent') return session.agent_type ? `Agent · ${session.agent_type}` : 'Agent';
  return session.cli_type === 'codex' ? 'Codex 会话' : 'Claude 会话';
}

function tabIcon(session: AdminMonitorSession | undefined) {
  if (session?.mode === 'agent') return <Bot className="h-4 w-4" />;
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

export function AdminMonitorPage({ onBack, onOpenSession }: {
  onBack: () => void;
  onOpenSession: (projectId: string, sessionId: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [showStatusHelp, setShowStatusHelp] = useState(false);
  const [collapsedUsers, setCollapsedUsers] = useState<Set<string>>(new Set());
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());
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

  const referenceTime = parseServerTime(data?.generated_at ?? null) ?? 0;
  const onlineUsers = data?.users.filter((user) => user.online).length ?? 0;
  const openProjects = data?.users.reduce((total, user) => total + user.open_projects, 0) ?? 0;
  const openTabs = data?.users.reduce(
    (total, user) => total + user.projects.filter((project) => project.is_open).reduce((sum, project) => sum + project.tabs.length, 0),
    0,
  ) ?? 0;
  const allCollapsed = users.length > 0 && users.every(({ user }) => collapsedUsers.has(user.id));

  return (
    <div className="h-full overflow-y-auto" style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
      <div className="mx-auto flex min-h-full w-full max-w-[1540px] flex-col px-4 py-4 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-4 border-b pb-4 sm:flex-row sm:items-end sm:justify-between" style={{ borderColor: 'var(--border)' }}>
          <div className="flex items-start gap-3">
            <button onClick={onBack} className="mt-0.5 rounded-md p-1.5 transition-colors hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2" style={{ color: 'var(--text-secondary)' }} title="返回">
              <ArrowLeft className="h-4 w-4" />
            </button>
            <div>
              <div className="mb-1 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em]" style={{ color: 'var(--accent)' }}>
                <Activity className={`h-3.5 w-3.5 motion-reduce:animate-none ${isFetching ? 'animate-pulse' : ''}`} />
                Live operations
                <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 normal-case tracking-normal" style={{ background: 'color-mix(in srgb, var(--accent) 12%, transparent)' }}>
                  <ShieldCheck className="h-3 w-3" />仅管理员
                </span>
              </div>
              <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">用户与会话监控</h1>
              <p className="mt-1 text-xs sm:text-sm" style={{ color: 'var(--text-secondary)' }}>
                按用户、项目和会话标签逐层查看正在使用的工作区与资源。
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 self-end text-xs" style={{ color: 'var(--text-secondary)' }}>
            <span>{data ? `采样于 ${absoluteTime(data.generated_at)}` : '正在连接监控数据'}</span>
            <button onClick={() => refetch()} disabled={isFetching} className="rounded-md p-1.5 transition-colors hover:bg-white/5 disabled:opacity-50" title="立即刷新">
              <RefreshCw className={`h-3.5 w-3.5 motion-reduce:animate-none ${isFetching ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </header>

        <ServerResourceOverview resources={data?.server_resources} loading={isLoading} />

        <section className="grid grid-cols-2 border-b sm:grid-cols-4" style={{ borderColor: 'var(--border)' }}>
          <Telemetry label="运行用户" value={`${data?.active_users ?? 0}`} detail={`${onlineUsers} 人在线`} icon={<Users className="h-4 w-4" />} />
          <Telemetry label="活动会话" value={`${data?.active_sessions ?? 0}`} detail="含后台与分离会话" icon={<TerminalSquare className="h-4 w-4" />} />
          <Telemetry label="会话内存" value={formatBytes(data?.total_memory_bytes ?? 0)} detail="进程树 / 隔离组采样" icon={<MemoryStick className="h-4 w-4" />} />
          <Telemetry label="打开项目 / 会话标签" value={`${openProjects} / ${openTabs}`} detail="用户当前保存的会话标签" icon={<FolderOpen className="h-4 w-4" />} />
        </section>

        <div className="flex flex-col gap-3 py-4 xl:flex-row xl:items-center xl:justify-between">
          <label className="relative block w-full xl:max-w-md">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索用户、项目、会话标签、任务或会话 ID" className="w-full rounded-md py-2 pl-9 pr-3 text-sm outline-none transition-colors focus:ring-1" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => setShowStatusHelp((value) => !value)} aria-expanded={showStatusHelp} className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-2 text-xs transition-colors hover:bg-white/5" style={{ color: showStatusHelp ? 'var(--accent)' : 'var(--text-secondary)', border: '1px solid var(--border)' }}>
              <CircleHelp className="h-3.5 w-3.5" />状态说明
            </button>
            <button
              onClick={() => {
                if (allCollapsed) setCollapsedUsers(new Set());
                else setCollapsedUsers(new Set(users.map(({ user }) => user.id)));
              }}
              className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-2 text-xs transition-colors hover:bg-white/5"
              style={{ color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
            >
              <ChevronsUpDown className="h-3.5 w-3.5" />{allCollapsed ? '展开全部用户' : '收起全部用户'}
            </button>
            <label className="flex cursor-pointer select-none items-center gap-2 rounded-md px-2.5 py-2 text-xs" style={{ color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
              <button type="button" role="switch" aria-label="显示最近已结束会话" aria-checked={showHistory} onClick={() => setShowHistory((value) => !value)} className="relative h-5 w-9 rounded-full transition-colors" style={{ background: showHistory ? 'var(--accent)' : 'var(--bg-tertiary)', border: '1px solid var(--border)' }}>
                <span className="absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white transition-transform" style={{ left: 2, transform: showHistory ? 'translateX(16px)' : 'translateX(0)' }} />
              </button>
              显示历史
            </label>
          </div>
        </div>

        {showStatusHelp && <StatusGuide />}

        {isLoading ? (
          <div className="flex flex-1 items-center justify-center py-24"><Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--accent)' }} /></div>
        ) : error ? (
          <div className="rounded-lg p-4 text-sm" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--error)' }}>{error instanceof Error ? error.message : '监控数据加载失败'}</div>
        ) : users.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center py-24 text-center">
            <Search className="mb-3 h-6 w-6" style={{ color: 'var(--text-muted)' }} />
            <p className="text-sm">没有匹配的用户、项目或会话标签</p>
            <p className="mt-1 text-xs" style={{ color: 'var(--text-secondary)' }}>清除搜索条件后可查看全部用户。</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3 pb-8">
            {users.map(({ user, projects }) => {
              const collapsed = collapsedUsers.has(user.id);
              return (
                <UserTree
                  key={user.id}
                  user={user}
                  projects={projects}
                  collapsed={collapsed}
                  onToggle={() => toggleSet(setCollapsedUsers, user.id)}
                  collapsedProjects={collapsedProjects}
                  onToggleProject={(key) => toggleSet(setCollapsedProjects, key)}
                  referenceTime={referenceTime}
                  showHistory={showHistory}
                  onOpenSession={onOpenSession}
                  onChanged={() => refetch()}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
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

function UserTree({ user, projects, collapsed, onToggle, collapsedProjects, onToggleProject, referenceTime, showHistory, onOpenSession, onChanged }: {
  user: AdminMonitorUser;
  projects: Array<{ project: AdminMonitorProject; sessions: AdminMonitorSession[] }>;
  collapsed: boolean;
  onToggle: () => void;
  collapsedProjects: Set<string>;
  onToggleProject: (key: string) => void;
  referenceTime: number;
  showHistory: boolean;
  onOpenSession: (projectId: string, sessionId: string) => void;
  onChanged: () => Promise<unknown>;
}) {
  const tabCount = projects.filter(({ project }) => project.is_open).reduce((total, { project }) => total + project.tabs.length, 0);
  return (
    <section className="overflow-hidden rounded-xl" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
      <button onClick={onToggle} aria-expanded={!collapsed} className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/[0.025] sm:px-5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>
          {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </span>
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full motion-reduce:animate-none ${user.online ? 'animate-pulse' : ''}`} style={{ background: user.online ? 'var(--success)' : 'var(--text-muted)' }} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-sm font-semibold">{user.display_name || user.username}</span>
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>@{user.username}</span>
            {user.disabled ? <span className="rounded px-1.5 py-0.5 text-[10px]" style={{ color: 'var(--error)', background: 'color-mix(in srgb, var(--error) 10%, transparent)' }}>已禁用</span> : null}
          </span>
          <span className="mt-1 block text-[11px]" style={{ color: 'var(--text-secondary)' }}>
            {user.online ? '在线' : '离线'} · 登录活动 {relativeTime(user.last_seen_at, referenceTime)}
          </span>
        </span>
        <span className="hidden items-center gap-5 text-right sm:flex">
          <Metric label="打开项目" value={`${user.open_projects}`} />
          <Metric label="会话标签" value={`${tabCount}`} />
          <Metric label="活动会话" value={user.role === 'member' ? `${user.active_sessions}/${user.max_tabs ?? 10}` : `${user.active_sessions}`} />
          <Metric label="内存" value={formatBytes(user.memory_bytes)} />
        </span>
      </button>

      {!collapsed && (
        <div className="border-t px-3 py-3 sm:px-5" style={{ borderColor: 'var(--border)' }}>
          {projects.length === 0 ? (
            <div className="py-5 pl-10 text-xs" style={{ color: 'var(--text-secondary)' }}>{showHistory ? '该用户暂无项目或会话记录。' : '该用户当前没有打开的项目。'}</div>
          ) : (
            <div className="relative ml-3 space-y-2 border-l pl-5" style={{ borderColor: 'var(--border)' }}>
              {projects.map(({ project, sessions }, index) => {
                const key = `${user.id}:${project.id ?? `unassigned-${index}`}`;
                return (
                  <ProjectTree key={key} userId={user.id} project={project} sessions={sessions} collapsed={collapsedProjects.has(key)} onToggle={() => onToggleProject(key)} referenceTime={referenceTime} showHistory={showHistory} onOpenSession={onOpenSession} onChanged={onChanged} />
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ProjectTree({ userId, project, sessions, collapsed, onToggle, referenceTime, showHistory, onOpenSession, onChanged }: {
  userId: string;
  project: AdminMonitorProject;
  sessions: AdminMonitorSession[];
  collapsed: boolean;
  onToggle: () => void;
  referenceTime: number;
  showHistory: boolean;
  onOpenSession: (projectId: string, sessionId: string) => void;
  onChanged: () => Promise<unknown>;
}) {
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const tabSessionIds = new Set(project.tabs.filter((tab) => tab.kind === 'session').map((tab) => tab.id));
  const backgroundSessions = sessions.filter((session) => !tabSessionIds.has(session.id));
  const activeSessions = sessions.filter((session) => ACTIVE_STATUSES.has(session.status));
  const memory = sessions.reduce((total, session) => total + (session.memory_bytes ?? 0), 0);
  return (
    <article className="relative overflow-hidden rounded-lg" style={{ background: 'color-mix(in srgb, var(--bg-tertiary) 48%, var(--bg-secondary))', border: '1px solid var(--border)' }}>
      <span className="absolute -left-[22px] top-7 h-px w-5" style={{ background: 'var(--border)' }} />
      <button onClick={onToggle} aria-expanded={!collapsed} className="flex w-full items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-white/[0.025] sm:px-4">
        <span style={{ color: project.is_open ? 'var(--accent)' : 'var(--text-muted)' }}>{collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}</span>
        <FolderOpen className="h-4 w-4 shrink-0" style={{ color: project.is_open ? 'var(--accent)' : 'var(--text-muted)' }} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium">{project.custom_name || project.name}</span>
            {project.is_active && <span className="rounded-full px-1.5 py-0.5 text-[9px] font-medium" style={{ color: 'var(--accent)', background: 'color-mix(in srgb, var(--accent) 12%, transparent)' }}>当前项目</span>}
            {!project.is_open && <span className="rounded-full px-1.5 py-0.5 text-[9px]" style={{ color: 'var(--text-muted)', border: '1px solid var(--border)' }}>历史项目</span>}
          </span>
          <span className="mt-0.5 block truncate text-[10px]" title={project.path ?? undefined} style={{ color: 'var(--text-muted)' }}>{project.path || '未关联项目路径'}</span>
        </span>
        <span className="hidden items-center gap-4 sm:flex">
          <Metric label="会话标签" value={`${project.tabs.length}`} />
          <Metric label="活动会话" value={`${activeSessions.length}`} />
          <Metric label="内存" value={formatBytes(memory)} />
        </span>
      </button>

      {!collapsed && (
        <div className="border-t px-3 py-3 sm:px-4" style={{ borderColor: 'var(--border)', background: 'color-mix(in srgb, var(--bg-primary) 32%, transparent)' }}>
          <div className="mb-2 flex items-center justify-between">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: 'var(--text-secondary)' }}>打开的会话标签 · {project.tabs.length}</div>
            {project.state_updated_at && <div className="text-[10px]" title={absoluteTime(project.state_updated_at)} style={{ color: 'var(--text-muted)' }}>结构更新于 {relativeTime(project.state_updated_at, referenceTime)}</div>}
          </div>
          {project.tabs.length === 0 ? (
            <div className="rounded-md px-3 py-4 text-xs" style={{ color: 'var(--text-muted)', border: '1px dashed var(--border)' }}>这个项目当前没有打开的会话标签。</div>
          ) : (
            <SessionTable>
              {project.tabs.map((tab) => (
                <TabRow
                  key={`${tab.kind}:${tab.id}`}
                  userId={userId}
                  projectId={project.id!}
                  tab={tab}
                  session={sessionById.get(tab.id)}
                  referenceTime={referenceTime}
                  onOpen={() => onOpenSession(project.id!, tab.id)}
                  onChanged={onChanged}
                />
              ))}
            </SessionTable>
          )}

          {backgroundSessions.length > 0 && (
            <div className="mt-4">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: 'var(--text-secondary)' }}>后台 / 未打开为标签的会话 · {backgroundSessions.length}</div>
              <SessionTable>
                {backgroundSessions.map((session) => (
                  <BackgroundSessionRow
                    key={session.id}
                    session={session}
                    referenceTime={referenceTime}
                    onOpen={() => project.id && onOpenSession(project.id, session.id)}
                  />
                ))}
              </SessionTable>
            </div>
          )}
          {!showHistory && project.tabs.length > 0 && sessions.length === 0 && <div className="mt-3 text-[10px]" style={{ color: 'var(--text-muted)' }}>这些标签当前没有活动会话；打开“显示历史”可查看最近结束状态。</div>}
        </div>
      )}
    </article>
  );
}

function SessionTable({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-md" style={{ border: '1px solid var(--border)' }}>
      <table className="w-full min-w-[1060px] table-fixed text-xs">
        <thead style={{ color: 'var(--text-secondary)', background: 'var(--bg-secondary)' }}>
          <tr>
            <th className="w-[230px] px-3 py-2 text-left font-medium">会话标签</th>
            <th className="w-[155px] px-3 py-2 text-left font-medium">实时状态</th>
            <th className="px-3 py-2 text-left font-medium">待处理信息 / 最新结果</th>
            <th className="w-[125px] px-3 py-2 text-right font-medium">内存 / 进程</th>
            <th className="w-[125px] px-3 py-2 text-right font-medium">最后活动</th>
            <th className="w-[92px] px-3 py-2 text-right font-medium">操作</th>
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
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
    <tr className="group transition-colors hover:bg-white/[0.025]" style={{ borderTop: '1px solid var(--border)' }}>
      <td className="px-3 py-2.5 align-middle">
        <div className="flex items-center gap-2.5">
          <span className="shrink-0" style={{ color: tab.is_active ? 'var(--accent)' : 'var(--text-secondary)' }}>{tabIcon(session)}</span>
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
          <button onClick={onOpen} disabled={!session} className="min-w-0 flex-1 text-left disabled:cursor-default" title={session ? `打开 ${tab.name}` : '暂无可打开的会话'}>
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
      <td className="px-3 py-2.5 align-middle">{session ? <ExecutionState session={session} /> : <span style={{ color: 'var(--text-muted)' }}>无采样</span>}</td>
      <td className="px-3 py-2.5 align-middle">
        {session ? <OutputInsight session={session} /> : <span style={{ color: 'var(--text-muted)' }}>暂无可判断信息</span>}
      </td>
      <td className="px-3 py-2.5 text-right align-middle font-mono tabular-nums">
        <div>{formatBytes(session?.memory_bytes ?? null)}</div>
        <div className="mt-0.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>{session ? `${session.process_count} 个进程` : '—'}</div>
      </td>
      <td className="px-3 py-2.5 text-right align-middle">
        <div title={absoluteTime(session?.last_activity_at ?? null)}>{relativeTime(session?.last_activity_at ?? null, referenceTime)}</div>
        <div className="mt-0.5 font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>{session?.id.slice(0, 8) ?? '—'}</div>
      </td>
      <td className="px-3 py-2.5 text-right align-middle">
        <div className="flex items-center justify-end gap-0.5">
          {editing ? (
            <>
              <button onClick={() => void saveName()} disabled={busy} className="rounded p-1 transition-colors hover:bg-white/5 disabled:opacity-40" style={{ color: 'var(--success)' }} title="保存名称"><Check className="h-3.5 w-3.5" /></button>
              <button onClick={() => { setName(tab.name); setEditing(false); setActionError(''); }} disabled={busy} className="rounded p-1 transition-colors hover:bg-white/5 disabled:opacity-40" style={{ color: 'var(--text-secondary)' }} title="取消改名"><X className="h-3.5 w-3.5" /></button>
            </>
          ) : (
            <>
              <button onClick={onOpen} disabled={!session} className="rounded p-1 opacity-55 transition-all hover:bg-white/5 hover:opacity-100 disabled:opacity-20" style={{ color: 'var(--accent)' }} aria-label={`打开会话标签 ${tab.name}`}><ExternalLink className="h-3.5 w-3.5" /></button>
              <button onClick={() => { setName(tab.name); setEditing(true); setActionError(''); }} className="rounded p-1 opacity-55 transition-all hover:bg-white/5 hover:opacity-100" style={{ color: 'var(--text-secondary)' }} aria-label={`重命名会话标签 ${tab.name}`}><Pencil className="h-3.5 w-3.5" /></button>
              <button onClick={() => setConfirmDelete(true)} className="rounded p-1 opacity-55 transition-all hover:bg-white/5 hover:opacity-100" style={{ color: 'var(--error)' }} aria-label={`删除会话标签 ${tab.name}`}><Trash2 className="h-3.5 w-3.5" /></button>
            </>
          )}
        </div>
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
  return (
    <tr className="transition-colors hover:bg-white/[0.025]" style={{ borderTop: '1px solid var(--border)' }}>
      <td className="px-3 py-2.5"><button onClick={onOpen} className="flex min-w-0 items-center gap-2 text-left"><TerminalSquare className="h-4 w-4 shrink-0" style={{ color: 'var(--text-muted)' }} /><span className="min-w-0"><span className="block truncate font-semibold" title={session.task}>{session.task}</span><span className="mt-0.5 block text-[10px]" style={{ color: 'var(--text-muted)' }}>{sessionType(session)} · 后台会话</span></span></button></td>
      <td className="px-3 py-2.5"><ExecutionState session={session} /></td>
      <td className="px-3 py-2.5"><OutputInsight session={session} /></td>
      <td className="px-3 py-2.5 text-right font-mono tabular-nums"><div>{formatBytes(session.memory_bytes)}</div><div className="mt-0.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>{session.process_count} 个进程</div></td>
      <td className="px-3 py-2.5 text-right"><div title={absoluteTime(session.last_activity_at)}>{relativeTime(session.last_activity_at, referenceTime)}</div><div className="mt-0.5 font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>{session.id.slice(0, 8)}</div></td>
      <td className="px-3 py-2.5 text-right"><button onClick={onOpen} className="rounded p-1" style={{ color: 'var(--accent)' }} aria-label={`打开后台会话 ${session.task}`}><ExternalLink className="h-3.5 w-3.5" /></button></td>
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
        ? session.mode === 'terminal' ? '终端正在输出' : 'Agent 正在执行'
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
      ? 'Agent 正在执行，尚未产生可汇总的结果。'
      : '尚未获取到有意义的 Agent 回复。';
  return (
    <div className="leading-relaxed">
      <div className="mb-0.5 text-[9px] font-semibold uppercase tracking-wider" style={{ color: needsAction ? '#f59e0b' : 'var(--text-muted)' }}>{label}</div>
      <div className="line-clamp-2" title={session.last_output ?? undefined} style={{ color: session.last_output ? 'var(--text-primary)' : 'var(--text-muted)' }}>{session.last_output || fallback}</div>
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

function Telemetry({ label, value, detail, icon }: { label: string; value: string; detail: string; icon: ReactNode }) {
  return (
    <div className="flex min-h-20 items-center gap-3 border-r px-3 py-3 last:border-r-0 sm:px-5" style={{ borderColor: 'var(--border)' }}>
      <span className="hidden sm:block" style={{ color: 'var(--accent)' }}>{icon}</span>
      <div className="min-w-0"><div className="font-mono text-lg font-semibold tabular-nums sm:text-xl">{value}</div><div className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>{label}</div><div className="hidden truncate text-[10px] lg:block" style={{ color: 'var(--text-muted)' }}>{detail}</div></div>
    </div>
  );
}

type ServerResources = NonNullable<AdminMonitorResponse['server_resources']>;

function ServerResourceOverview({ resources, loading }: { resources: ServerResources | undefined; loading: boolean }) {
  const highestUsage = resources
    ? Math.max(resources.cpu.usage_percent, resources.memory.usage_percent, resources.disk?.usage_percent ?? 0)
    : 0;
  const health = highestUsage >= 90
    ? { label: '资源告警', color: 'var(--error)' }
    : highestUsage >= 75
      ? { label: '负载偏高', color: '#f59e0b' }
      : { label: '运行平稳', color: 'var(--success)' };

  return (
    <section aria-label="服务器资源" className="border-b py-4 sm:py-5" style={{ borderColor: 'var(--border)' }}>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: 'var(--text-secondary)' }}>
            <Server className="h-3.5 w-3.5" />服务器资源
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
            <span className="font-mono">{resources?.hostname ?? (loading ? '读取服务器信息…' : '未知主机')}</span>
            {resources && <><span>持续运行 {formatUptime(resources.uptime_seconds)}</span><span>5 秒自动刷新</span></>}
          </div>
        </div>
        <div className="flex items-center gap-1.5 text-[11px] font-medium" style={{ color: health.color }}>
          <span className={`h-1.5 w-1.5 rounded-full ${loading ? 'animate-pulse motion-reduce:animate-none' : ''}`} style={{ background: health.color }} />
          {loading && !resources ? '采样中' : health.label}
        </div>
      </div>

      <div className="grid gap-2 lg:grid-cols-3">
        <ResourceGauge
          label="CPU"
          value={resources?.cpu.usage_percent}
          detail={resources ? `${resources.cpu.core_count} 核 · 1 分钟负载 ${resources.cpu.load_average_1m.toFixed(2)}` : '正在采集处理器负载'}
          icon={<Cpu className="h-4 w-4" />}
        />
        <ResourceGauge
          label="物理内存"
          value={resources?.memory.usage_percent}
          detail={resources ? `${formatBytes(resources.memory.used_bytes)} / ${formatBytes(resources.memory.total_bytes)}` : '正在读取可用内存'}
          icon={<MemoryStick className="h-4 w-4" />}
        />
        <ResourceGauge
          label="磁盘"
          value={resources?.disk?.usage_percent}
          detail={resources?.disk ? `${formatBytes(resources.disk.used_bytes)} / ${formatBytes(resources.disk.total_bytes)} · ${resources.disk.mount}` : '当前平台无法读取磁盘用量'}
          icon={<HardDrive className="h-4 w-4" />}
        />
      </div>
    </section>
  );
}

function ResourceGauge({ label, value, detail, icon }: {
  label: string;
  value: number | undefined;
  detail: string;
  icon: ReactNode;
}) {
  const normalized = value === undefined ? 0 : Math.min(100, Math.max(0, value));
  const color = normalized >= 90 ? 'var(--error)' : normalized >= 75 ? '#f59e0b' : 'var(--accent)';
  return (
    <article className="relative overflow-hidden rounded-lg px-3.5 py-3.5 sm:px-4" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-2 text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
          <span style={{ color }}>{icon}</span>{label}
        </div>
        <span className="font-mono text-xl font-semibold leading-none tabular-nums" style={{ color: value === undefined ? 'var(--text-muted)' : 'var(--text-primary)' }}>
          {value === undefined ? '—' : `${Math.round(value)}%`}
        </span>
      </div>
      <div className="relative mt-3 h-1.5 overflow-hidden rounded-full" style={{ background: 'var(--bg-tertiary)' }}>
        <div className="h-full rounded-full transition-[width,background-color] duration-500 motion-reduce:transition-none" style={{ width: `${normalized}%`, background: color }} />
        <span className="absolute inset-y-0 left-3/4 w-px bg-white/30" />
        <span className="absolute inset-y-0 left-[90%] w-px bg-white/45" />
      </div>
      <div className="mt-2 flex items-center justify-between gap-3 text-[10px]" style={{ color: 'var(--text-muted)' }}>
        <span className="truncate" title={detail}>{detail}</span>
        <span className="shrink-0 font-mono">75 / 90</span>
      </div>
    </article>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <span className="min-w-[52px]"><span className="block font-mono text-xs font-semibold tabular-nums">{value}</span><span className="mt-0.5 block text-[9px]" style={{ color: 'var(--text-muted)' }}>{label}</span></span>;
}
