import {sessionAgent} from '../lib/agents';
import { TableActionButton, TableActions } from './table/TableActions';
import {loginDevice} from '../lib/login-device';
import { RowActionsMenu } from './table/RowActionsMenu';
import { tableTime, useTableModel } from './table/use-table-model';
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
  type AdminMonitorLogin,
} from '../lib/api';
import { useServerResources } from '../lib/use-server-resources';

const ACTIVE_STATUSES = new Set(['pending', 'launching', 'running', 'detached', 'released']);

const STATUS_META: Record<string, { label: string; description: string; color: string }> = {
  pending: { label: '等待启动', description: '会话已创建，正在等待分配终端进程。', color: '#f59e0b' },
  launching: { label: '启动中', description: '终端和 Agent 进程正在初始化。', color: '#f59e0b' },
  running: { label: '运行中', description: '平台记录的会话生命周期为运行中。', color: 'var(--success)' },
  detached: { label: '已分离', description: '平台记录的会话已与页面分离。', color: '#f59e0b' },
  released: { label: '外部运行', description: '平台记录的会话已交给外部终端。', color: '#f59e0b' },
  completed: { label: '已完成', description: '进程已正常结束，仅保留历史记录。', color: 'var(--text-secondary)' },
  failed: { label: '失败', description: '会话因错误退出。', color: 'var(--error)' },
  cancelled: { label: '已取消', description: '会话被用户或管理员主动停止。', color: 'var(--error)' },
};

const PROCESS_META = {
  busy: { label: '终端近期有活动', description: '终端跟踪器观察到输出或输入活动。', color: '#60a5fa' },
  idle: { label: '终端输出静默', description: '近期未观察到终端输出。', color: 'var(--text-secondary)' },
  waiting_for_input: { label: '终端疑似等待输入', description: '终端内容符合交互提示的特征。', color: '#f59e0b' },
};

const AGENT_STATE_LABEL = {
  ready: 'Agent 就绪',
  running: '会话正在执行',
  idle: 'Agent 空闲',
  waiting_for_input: '等待用户输入',
  interrupted: '本轮已中断',
  failed: '本轮失败',
};

const monitorTimeFormat = new Intl.DateTimeFormat('sv-SE', {
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23', timeZoneName: 'shortOffset',
});

function absoluteTime(value: string | null): string {
  const time = tableTime(value);
  return time === null ? '暂无记录' : monitorTimeFormat.format(time);
}

function relativeTime(value: string | null, referenceTime: number): string {
  const time = tableTime(value);
  if (time === null) return '暂无活动';
  if (time > referenceTime) return absoluteTime(value);
  const seconds = Math.floor((referenceTime - time) / 1000);
  if (seconds === 0) return '刚刚';
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
  return `${sessionAgent(session).label} 会话`;
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
      const userMatches = [user.username, user.display_name,...(user.login_sessions||[]).flatMap(login=>[login.login_ip,login.last_ip,loginDevice(login.user_agent)])].join('\n').toLocaleLowerCase().includes(query);
      const projects = user.projects
        .map((project) => {
          const savedTabs = new Set(project.tabs.map((tab) => tab.id));
          return {
            project,
            sessions: project.sessions.filter((session) =>
              ACTIVE_STATUSES.has(session.status) || showHistory || savedTabs.has(session.id)),
          };
        })
        .filter(({ project, sessions }) => project.is_open || sessions.length > 0)
        .filter(({ project, sessions }) => {
          if (!query || userMatches) return true;
          return [
            project.name,
            project.custom_name ?? '',
            project.path ?? '',
            ...(project.is_open ? project.tabs : []).flatMap((tab) => [tab.name, tab.id]),
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
    { key: 'status', title: '连接状态', value: ({ user }) => presenceLabel(user) },
    { key: 'projects', title: '打开项目', value: ({ user }) => user.open_projects },
    { key: 'tabs', title: '会话标签', value: ({ user }) => countOpenTabs(user) },
    { key: 'sessions', title: '活动会话', value: ({ user }) => user.active_sessions },
    { key: 'memory', title: '内存', value: ({ user }) => user.memory_bytes, format: (value) => formatBytes(typeof value === 'number' ? value : null) },
    { key: 'ip', title: '登录最近请求 IP', value: ({ user }) => user.login_sessions?.[0]?.last_ip },
    { key: 'device', title: '浏览器 / 系统', value: ({ user }) => loginDevice(user.login_sessions?.[0]?.user_agent) },
    { key: 'login', title: '所示登录的活动时间', value: ({ user }) => user.login_sessions?.[0]?.last_seen_at, kind: 'date', format: (value) => absoluteTime(value == null ? null : String(value)) },
  ]);
  const referenceTime = tableTime(data?.generated_at ?? null) ?? 0;
  const onlineUsers = data?.users.filter((user) => user.online).length ?? 0;
  const openProjects = data?.users.reduce((total, user) => total + user.open_projects, 0) ?? 0;
  const openTabs = data?.users.reduce((total, user) => total + countOpenTabs(user), 0) ?? 0;
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

        {data && <div className="my-2 flex flex-wrap gap-x-5 gap-y-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
          <span>有活动会话的用户 {data.active_users} · 网页在线 {onlineUsers}</span>
          <span>活动会话 {data.active_sessions}</span>
          <span>会话内存 <MemoryTotal bytes={data.total_memory_bytes} sampled={data.memory_sampled_sessions} active={data.active_sessions} /></span>
          <span>打开项目 / 标签 {openProjects} / {openTabs}</span>
          {error && <span role="status">刷新失败，显示最近一次成功采样</span>}
        </div>}

        <div className="flex flex-col gap-2 py-2 xl:flex-row xl:items-center xl:justify-between">
          <label className="relative block w-full xl:max-w-md">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索用户、IP、设备、项目或会话" className="w-full rounded-md py-1.5 pl-9 pr-3 text-sm outline-none transition-colors focus:ring-1" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
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

          <DataTable label="用户监控" model={usersTable} minWidth={1400} expandable className="mb-3" columnWidths={['w-56','w-32','w-28','w-28','w-32','w-28','w-40','w-44','w-44']}
            loading={isLoading} error={!data && error ? error instanceof Error ? error.message : '监控数据加载失败' : undefined}
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
                  loginIdleDays={data?.login_session_policy?.idle_ttl_days}
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
        <p className="mt-1 text-xs" style={{ color: 'var(--text-secondary)' }}>生命周期来自平台会话记录。工作状态优先使用 Agent 状态，终端跟踪结果会标明来源。活动会话包含等待启动、启动中、运行中、已分离和外部运行。</p>
        <p className="mt-2 text-xs" style={{color:'var(--text-secondary)'}}>连接状态仅依据网页实时连接：连接存活且 75 秒内收到握手或心跳为在线；连接仍在但心跳超时为连接异常；没有连接为离线。心跳每 25 秒一次，本表每 5 秒刷新。浏览器离线不代表后台任务已停止。</p>
        <p className="mt-2 text-xs" style={{color:'var(--text-secondary)'}}>登录活动来自认证请求或网页心跳。用户行优先显示最近活动的在线登录，其次显示最近活动的有效登录。来源 IP 来自服务端观测，可能是代理地址。浏览器和系统取自客户端报告。</p>
      </div>
      <div className="grid gap-px lg:grid-cols-2" style={{ background: 'var(--border)' }}>
        <GuideGroup title="会话生命周期" items={STATUS_META} />
        <GuideGroup title="终端工作状态" items={PROCESS_META} />
      </div>
      <p className="px-4 py-3 text-xs" style={{ color: 'var(--text-secondary)' }}>会话内存只汇总已采样项。隔离组内存包含组内文件缓存等用量，进程树内存是 RSS 合计，共享页可重复计入。两种口径均在会话行标明。</p>
    </section>
  );
}

function countOpenTabs(user: AdminMonitorUser) {
  return user.projects.reduce((sum, project) => sum + (project.is_open ? project.tabs.length : 0), 0);
}

function MemoryTotal({ bytes, sampled, active }: { bytes: number | null; sampled?: number; active: number }) {
  return <span title={bytes === null ? undefined : `${bytes.toLocaleString()} 字节`}>
    {bytes === null ? active > 0 ? '未采样' : '—' : formatBytes(bytes)}
    {sampled !== undefined && sampled < active && <span className="ml-1">（已采样 {sampled}/{active}）</span>}
  </span>;
}

function presenceLabel(user:AdminMonitorUser) {
  return user.disabled?'已禁用':user.presence?.state==='online'?'在线':user.presence?.state==='unresponsive'?'连接异常':user.presence?.state==='offline'?'离线':'未知';
}
const isOnlineLogin=(login:AdminMonitorLogin)=>login.presence.state==='online'&&login.presence.connections>0;

function LoginSessions({user,idleDays}:{user:AdminMonitorUser;idleDays?:number}) {
  const [showDisconnected,setShowDisconnected]=useState(false);
  const logins=user.login_sessions||[],online=logins.filter(isOnlineLogin);
  const rows=showDisconnected?logins:online,disconnected=logins.length-online.length;
  const table=useTableModel(rows,[
    {key:'login',title:'登录时间',value:item=>item.login_at,kind:'date',format:value=>absoluteTime(value==null?null:String(value))},
    {key:'login_ip',title:'登录 IP',value:item=>item.login_ip||'未记录'},
    {key:'last_ip',title:'最近请求 IP',value:item=>item.last_ip||'未记录'},
    {key:'device',title:'浏览器 / 系统',value:item=>loginDevice(item.user_agent)},
    {key:'state',title:'网页连接',value:item=>item.presence.state==='online'?`在线 · ${item.presence.connections} 个连接`:item.presence.state==='unresponsive'?'心跳超时':'未连接'},
    {key:'heartbeat',title:'最后心跳',value:item=>item.presence.last_heartbeat_at,kind:'date',format:value=>absoluteTime(value==null?null:String(value))},
    {key:'activity',title:'最近登录活动',value:item=>item.last_seen_at,kind:'date',format:value=>absoluteTime(value==null?null:String(value))},
  ]);
  return <section className="mb-3" aria-label={`${user.username} 的登录连接`}>
    <div className="mb-2 flex flex-wrap items-center justify-between gap-3 text-xs" style={{color:'var(--text-secondary)'}}><p>在线登录 · {online.length} 个（{online.reduce((sum,item)=>sum+item.presence.connections,0)} 个网页连接）</p>{disconnected>0&&<label className="inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap"><input type="checkbox" checked={showDisconnected} onChange={event=>setShowDisconnected(event.target.checked)}/>显示未连接登录（{disconnected} 个）</label>}</div>
    <DataTable label={`${user.username} 的登录连接`} model={table} minWidth={1000} empty={!rows.length} emptyMessage={showDisconnected?'没有尚未到期的登录记录。':'当前没有在线连接。'}>{table.rows.map((item,index)=><tr key={index}>
      <td className="whitespace-nowrap">{absoluteTime(item.login_at)}</td><td className="font-mono text-xs">{item.login_ip||'未记录'}</td><td className="font-mono text-xs">{item.last_ip||'未记录'}</td><td title={item.user_agent||'未记录'}>{loginDevice(item.user_agent)}</td><td className="whitespace-nowrap">{item.presence.state==='online'?`在线 · ${item.presence.connections} 个连接`:item.presence.state==='unresponsive'?'心跳超时':'未连接'}</td><td className="whitespace-nowrap">{absoluteTime(item.presence.last_heartbeat_at)}</td><td className="whitespace-nowrap">{absoluteTime(item.last_seen_at)}</td>
    </tr>)}</DataTable>
    <p className="mt-2 text-xs" style={{color:'var(--text-muted)'}}>未连接不等于登录失效。{idleDays?`登录连续 ${idleDays} 天没有认证请求或连接心跳会到期，过期记录会自动清理。`:'登录凭据到期后会自动清理。'}后台任务与登录记录分开管理。</p>
  </section>;
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

function UserTree({ user, projects, collapsed, onToggle, expandedProjects, onToggleProject, referenceTime, showHistory, onOpenSession, onChanged,loginIdleDays }: {
  user: AdminMonitorUser; projects: Array<{ project: AdminMonitorProject; sessions: AdminMonitorSession[] }>;
  collapsed: boolean; onToggle: () => void; expandedProjects: Set<string>; onToggleProject: (key: string) => void;
  referenceTime: number; showHistory: boolean; onOpenSession: (projectId: string, sessionId: string) => void; onChanged: () => Promise<unknown>;loginIdleDays?:number;
}) {
  const onlineLogins=(user.login_sessions||[]).filter(isOnlineLogin).length;
  const projectsTable = useTableModel(projects, [
    { key: 'project', title: '项目', value: ({ project }) => project.custom_name || project.name },
    { key: 'path', title: '路径', value: ({ project }) => project.path },
    { key: 'state', title: '状态', value: ({ project }) => project.is_active ? '当前项目' : project.is_open ? '已打开' : '未打开' },
    { key: 'tabs', title: '会话标签', value: ({ project }) => project.is_open ? project.tabs.length : 0 },
    { key: 'sessions', title: '活动会话', value: ({ sessions }) => sessions.filter((session) => ACTIVE_STATUSES.has(session.status)).length },
    { key: 'memory', title: '内存', value: ({ sessions }) => projectMemory(sessions).bytes, format: (value) => formatBytes(typeof value === 'number' ? value : null) },
  ]);
  const tabCount = countOpenTabs(user);
  return <Fragment>
    <tr>
      <td><TableExpandButton expanded={!collapsed} label={`用户 ${user.username}`} onClick={onToggle} /></td>
      <td title={`${user.display_name||user.username} @${user.username}`}><div className="flex min-w-0 items-center gap-2"><span className="min-w-0 truncate font-medium">{user.display_name || user.username}</span><span className="min-w-0 truncate text-[11px]" style={{ color: 'var(--text-secondary)' }}>@{user.username}</span></div></td>
      <td title={user.presence?`网页连接 ${user.presence.connections} 个；最后心跳：${absoluteTime(user.presence.last_heartbeat_at)}。浏览器连接状态与后台任务分开统计。`:'尚未取得连接状态'}><span className="inline-flex items-center gap-1.5 whitespace-nowrap"><span className="h-1.5 w-1.5 rounded-full" style={{ background: user.disabled ? 'var(--error)' : user.presence?.state==='online' ? 'var(--success)' : user.presence?.state==='unresponsive'?'var(--warning,#d97706)':'var(--text-muted)' }} />{presenceLabel(user)}</span></td>
      <td>{user.open_projects}</td><td>{tabCount}</td>
      <td>{user.active_sessions}{user.role === 'member' && user.tab_quota_used != null && <div className="text-[10px]" title="该账号已占用的会话配额 / 上限">配额 {user.tab_quota_used} / {user.max_tabs}</div>}</td>
      <td className="whitespace-nowrap"><MemoryTotal bytes={user.memory_bytes} sampled={user.memory_sampled_sessions} active={user.active_sessions} /></td>
      <td className="whitespace-nowrap font-mono text-xs">{user.login_sessions?.[0]?.last_ip||'未记录'}</td>
      <td className="whitespace-nowrap" title={user.login_sessions?.[0]?.user_agent||'未记录客户端信息'}>{loginDevice(user.login_sessions?.[0]?.user_agent)}{onlineLogins>0&&<span className="ml-1 text-xs" style={{color:'var(--text-secondary)'}}>（{onlineLogins} 个在线登录）</span>}</td>
      <td className="whitespace-nowrap" title={absoluteTime(user.login_sessions?.[0]?.last_seen_at ?? null)}>{absoluteTime(user.login_sessions?.[0]?.last_seen_at ?? null)}</td>
    </tr>
    {!collapsed && <TableDetailRow columnCount={10}>
      <LoginSessions user={user} idleDays={loginIdleDays}/>
      <DataTable label={`${user.username} 的项目`} model={projectsTable} minWidth={850} expandable columnWidths={['w-48', '', 'w-24', 'w-32', 'w-32', 'w-28']}
        empty={projectsTable.rows.length === 0} emptyMessage={showHistory ? '暂无项目或会话记录。' : '当前没有打开的项目或活动会话。'}>{projectsTable.rows.map((entry) => {
        const { project, sessions } = entry;
        const index = projects.indexOf(entry);
        const key = `${user.id}:${project.id ?? `unassigned-${index}`}`;
        return <ProjectTree key={key} userId={user.id} project={project} sessions={sessions} collapsed={!expandedProjects.has(key)} onToggle={() => onToggleProject(key)} referenceTime={referenceTime} showHistory={showHistory} onOpenSession={onOpenSession} onChanged={onChanged} />;
      })}</DataTable>
    </TableDetailRow>}
  </Fragment>;
}

function projectMemory(sessions: AdminMonitorSession[]) {
  const active = sessions.filter((session) => ACTIVE_STATUSES.has(session.status));
  const measured = active.filter((session) => session.memory_bytes !== null);
  return {
    active: active.length,
    sampled: measured.length,
    bytes: measured.length > 0 ? measured.reduce((sum, session) => sum + session.memory_bytes!, 0) : null,
  };
}

function ProjectTree({ userId, project, sessions, collapsed, onToggle, referenceTime, showHistory, onOpenSession, onChanged }: {
  userId: string; project: AdminMonitorProject; sessions: AdminMonitorSession[]; collapsed: boolean; onToggle: () => void;
  referenceTime: number; showHistory: boolean; onOpenSession: (projectId: string, sessionId: string) => void; onChanged: () => Promise<unknown>;
}) {
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const tabs = project.is_open ? project.tabs : [];
  const tabIds = new Set(tabs.map((tab) => tab.id));
  const background = sessions.filter((session) => !tabIds.has(session.id));
  return <Fragment>
    <tr><td><TableExpandButton expanded={!collapsed} label={`项目 ${project.name}`} onClick={onToggle} /></td><td><span className="flex items-center gap-2"><FolderOpen className="h-3.5 w-3.5" style={{ color: 'var(--accent)' }} />{project.custom_name || project.name}</span></td><td><div className="max-w-96 truncate" title={project.path ?? undefined}>{project.path || '未关联'}</div></td><td>{project.is_active ? '当前项目' : project.is_open ? '已打开' : '未打开'}</td><td>{tabs.length}</td><td>{sessions.filter((session) => ACTIVE_STATUSES.has(session.status)).length}</td><td className="whitespace-nowrap"><MemoryTotal {...projectMemory(sessions)} /></td></tr>
    {!collapsed && <TableDetailRow columnCount={7}><SessionTable>
      {tabs.map((tab) => <TabRow key={`${tab.kind}:${tab.id}`} userId={userId} projectId={project.id!} tab={tab} session={sessionById.get(tab.id)} referenceTime={referenceTime} onOpen={() => project.id && onOpenSession(project.id, tab.id)} onChanged={onChanged} />)}
      {background.map((session) => <BackgroundSessionRow key={session.id} session={session} referenceTime={referenceTime} onOpen={() => project.id && onOpenSession(project.id, session.id)} />)}
      {tabs.length === 0 && background.length === 0 && <TableStateRow columnCount={6}>{showHistory ? '暂无会话记录' : '暂无活动会话，可打开“显示历史”查看已结束会话'}</TableStateRow>}
    </SessionTable></TableDetailRow>}
  </Fragment>;
}

function SessionTable({ children }: { children: ReactNode }) {
  const elements = Children.toArray(children).filter(isValidElement) as Array<ReactElement<{ tab?: AdminMonitorTab; session?: AdminMonitorSession }>>;
  const records = elements.filter((element) => element.props.tab || element.props.session);
  const table = useTableModel(records, [
    { key: 'name', title: '会话标签', value: ({ props }) => props.tab?.name ?? props.session?.task },
    { key: 'state', title: '会话状态', value: ({ props }) => props.session ? statusMeta(props.session.status).label : '会话状态未知' },
    { key: 'content', title: '最近一条助手消息', value: ({ props }) => props.session?.last_output },
    { key: 'memory', title: '内存 / 进程', value: ({ props }) => props.session?.memory_bytes, format: (value) => formatBytes(typeof value === 'number' ? value : null) },
    { key: 'activity', title: '最近会话活动', value: ({ props }) => props.session?.last_activity_at, kind: 'date', format: (value) => absoluteTime(value == null ? null : String(value)) },
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
      <td >{session ? <ExecutionState session={session} /> : <span style={{ color: 'var(--text-muted)' }}>会话状态未知</span>}</td>
      <td >
        {session ? <OutputInsight session={session} /> : <span style={{ color: 'var(--text-muted)' }}>—</span>}
      </td>
      <SessionResources session={session} />
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
                ...(canDelete ? [{ label: '停止并关闭', icon: <Trash2 className="h-3.5 w-3.5" />, danger: true, onClick: () => setConfirmDelete(true) }] : []),
              ]} />
            </>
          )}
        </TableActions>
        {confirmDelete && createPortal(
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => !busy && setConfirmDelete(false)}>
          <div className="w-full max-w-sm rounded-xl p-5 shadow-2xl" style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)' }} onClick={(event) => event.stopPropagation()}>
            <div className="flex items-start gap-3">
              <span className="rounded-full p-2" style={{ color: '#f59e0b', background: 'rgba(245,158,11,.12)' }}><AlertTriangle className="h-5 w-5" /></span>
              <div><h3 className="text-sm font-semibold">停止并关闭会话？</h3><p className="mt-2 text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>将从用户页面移除“{tab.name}”标签。{session && ACTIVE_STATUSES.has(session.status) ? '将停止会话的当前运行，保留会话历史记录。' : '会话历史记录会保留。'}</p></div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setConfirmDelete(false)} disabled={busy} className="rounded-md px-3 py-1.5 text-xs disabled:opacity-40" style={{ color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>取消</button>
              <button onClick={() => void deleteTab()} disabled={busy} className="rounded-md px-3 py-1.5 text-xs text-white disabled:opacity-40" style={{ background: 'var(--error)' }}>{busy ? '正在停止…' : '停止并关闭'}</button>
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
      <SessionResources session={session} />
      <td className="text-right"><div title={absoluteTime(session.last_activity_at)}>{relativeTime(session.last_activity_at, referenceTime)}</div><div className="mt-0.5 font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>{session.id.slice(0, 8)}</div></td>
      <td><TableActions><TableActionButton onClick={onOpen} disabled={!canOpenSessions} style={{ color: 'var(--accent)' }} aria-label={`打开后台会话 ${session.task}`}><ExternalLink className="h-3.5 w-3.5" /></TableActionButton></TableActions></td>
    </tr>
  );
}

function SessionResources({ session }: { session?: AdminMonitorSession }) {
  const bytes = session?.memory_bytes ?? null;
  const count = session?.process_count ?? null;
  const source = session?.memory_source;
  return <td className="text-right font-mono tabular-nums">
    <div title={bytes === null ? undefined : `${bytes.toLocaleString()} 字节`}>
      {formatBytes(bytes)}{source && <span className="ml-1 text-[10px]">{source === 'rss' ? 'RSS 合计' : '隔离组'}</span>}
    </div>
    <div className="mt-0.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
      {count === null ? '进程数未采样' : `${count} 个进程`}
    </div>
  </td>;
}

function ExecutionState({ session }: { session: AdminMonitorSession }) {
  const process = session.process_state ? PROCESS_META[session.process_state] : null;
  const label = session.is_permission ? '终端疑似等待授权'
    : session.agent_state ? AGENT_STATE_LABEL[session.agent_state]
    : process?.label ?? '工作状态未知';
  const color = session.is_permission || session.agent_state === 'waiting_for_input' ? '#f59e0b'
    : session.agent_state ? 'var(--text-secondary)' : process?.color;
  return (
    <div>
      <StatusBadge status={session.status} />
      {ACTIVE_STATUSES.has(session.status) &&
        <div className="mt-1.5 text-[10px] font-medium" title={session.agent_state_reason ?? process?.description} style={{ color }}>{label}</div>}
    </div>
  );
}

function OutputInsight({ session }: { session: AdminMonitorSession }) {
  if (!session.last_output) return <span style={{ color: 'var(--text-muted)' }}>暂无可展示消息</span>;
  return <div className="leading-tight">
    <div className="truncate" title={session.last_output}>{session.last_output}</div>
    {session.last_output_at && <div className="mt-0.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>{absoluteTime(session.last_output_at)}</div>}
  </div>;
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
    <td title={absoluteTime(resources?.sampled_at ?? null)}><span>{resources ? `${Math.round(resources.cpu.usage_percent)}%` : '—'}</span>{resources && <span className="ml-2 text-[11px]" style={{ color: 'var(--text-secondary)' }}>{resources.cpu.core_count} 逻辑核</span>}</td>
    <td>{resources ? `${resources.memory.reliable === false ? '估算 ' : ''}${Math.round(resources.memory.usage_percent)}% · ${formatBytes(resources.memory.used_bytes)} / ${formatBytes(resources.memory.total_bytes)}` : '—'}</td>
    <td title={resources?.disk?.mount}>{resources?.disk ? `${Math.round(resources.disk.usage_percent)}% · ${formatBytes(resources.disk.used_bytes)} / ${formatBytes(resources.disk.total_bytes)}` : '—'}</td>
  </tr>}</DataTable></section>;
}
