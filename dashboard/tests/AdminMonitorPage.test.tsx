import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen,within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminMonitorPage } from '../src/components/AdminMonitorPage';
import { api, type AdminMonitorResponse, type AdminMonitorSession } from '../src/lib/api';

vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return {
    ...actual,
    api: {
      ...actual.api,
      admin: {
        serverResources: vi.fn(),
        monitor: vi.fn(),
        renameMonitorTab: vi.fn(),
        deleteMonitorTab: vi.fn(),
      },
    },
  };
});

function session(overrides: Partial<AdminMonitorSession> = {}): AdminMonitorSession {
  return {
    id: 'session-live-1234',
    project_id: 'project-1',
    task: 'Investigate query latency',
    status: 'running',
    mode: 'session',
    cli_type: 'codex',
    created_by_user_id: 'user-1',
    started_at: '2026-07-31T11:55:00.000Z',
    completed_at: null,
    created_at: '2026-07-31T11:55:00.000Z',
    updated_at: '2026-07-31T12:00:00.000Z',
    last_activity_at: '2026-07-31T12:00:00.000Z',
    last_output: '正在分析慢查询日志…',
    root_pid: 123,
    process_count: 3,
    memory_bytes: 128 * 1024 * 1024,
    process_state: 'busy',
    prompt_type: null,
    choices: null,
    is_permission: false,
    ...overrides,
  };
}

const response: AdminMonitorResponse = {
  generated_at: '2026-07-31T12:00:00.000Z',
  server_resources: {
    sampled_at: '2026-07-31T12:00:00.000Z',
    hostname: 'agent-host-01',
    uptime_seconds: 183845,
    cpu: { usage_percent: 37.4, core_count: 8, load_average_1m: 2.14 },
    memory: {
      total_bytes: 16 * 1024 * 1024 * 1024,
      used_bytes: 10 * 1024 * 1024 * 1024,
      available_bytes: 6 * 1024 * 1024 * 1024,
      usage_percent: 62.5,
    },
    disk: {
      total_bytes: 256 * 1024 * 1024 * 1024,
      used_bytes: 192 * 1024 * 1024 * 1024,
      available_bytes: 64 * 1024 * 1024 * 1024,
      usage_percent: 75,
      mount: '/',
    },
  },
  active_users: 1,
  active_sessions: 1,
  total_memory_bytes: 128 * 1024 * 1024,
  users: [{
    id: 'user-1',
    username: 'operator',
    display_name: 'Operator Chen',
    role: 'member',
    disabled: 0,
    max_tabs: 6,
    online: true,
    presence:{state:'online',connections:1,last_heartbeat_at:'2026-07-31T12:00:00.000Z'},
    login_sessions:[{login_at:'2026-07-31T10:00:00Z',last_seen_at:'2026-07-31T12:00:00Z',login_ip:'192.0.2.10',last_ip:'192.0.2.11',user_agent:'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0.0.0 Safari/537.36',presence:{state:'online',connections:1,last_heartbeat_at:'2026-07-31T12:00:00Z'}}],
    last_seen_at: '2026-07-31T12:00:00.000Z',
    active_sessions: 1,
    open_projects: 1,
    memory_bytes: 128 * 1024 * 1024,
    projects: [{
      id: 'project-1',
      name: 'DolphinDB Manager',
      path: '/workspace/dolphindb-manager',
      is_open: true,
      is_active: true,
      custom_name: null,
      state_updated_at: '2026-07-31T12:00:00.000Z',
      tabs: [
        { id: 'session-live-1234', name: '性能排查', kind: 'session', is_active: true },
      ],
      sessions: [
        session(),
        session({ id: 'session-ended', task: 'Old completed task', status: 'completed', memory_bytes: null, process_count: 0 }),
      ],
    }],
  }],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.admin.monitor).mockResolvedValue(response);
  vi.mocked(api.admin.serverResources).mockResolvedValue({ server_resources: response.server_resources });
  vi.mocked(api.admin.renameMonitorTab).mockResolvedValue({ ok: true, tab: { id: 'session-live-1234', name: '新标签名' } });
  vi.mocked(api.admin.deleteMonitorTab).mockResolvedValue({ ok: true, session_continues: false });
});

describe('administrator monitor page', () => {
  it('shows only online logins by default and lets administrators inspect unconnected unexpired logins',async()=>{
    const online=response.users[0].login_sessions![0],offline={...online,login_ip:'192.0.2.20',last_ip:'192.0.2.20',presence:{state:'offline' as const,connections:0,last_heartbeat_at:null}},stale={...online,login_ip:'192.0.2.30',last_ip:'192.0.2.30',presence:{state:'unresponsive' as const,connections:0,last_heartbeat_at:'2026-07-31T10:00:00Z'}};
    vi.mocked(api.admin.monitor).mockResolvedValue({...response,login_session_policy:{idle_ttl_days:30},users:[{...response.users[0],login_sessions:[online,offline,stale]}]});
    const client=new QueryClient({defaultOptions:{queries:{retry:false}}}),user=userEvent.setup();render(<QueryClientProvider client={client}><AdminMonitorPage onBack={vi.fn()} onOpenSession={vi.fn()}/></QueryClientProvider>);
    await user.click(await screen.findByRole('button',{name:'展开用户 operator'}));const table=within(screen.getByRole('table',{name:'operator 的登录连接'}));
    expect(screen.getByText('在线登录 · 1 个（1 个网页连接）')).toBeVisible();expect(table.queryByText('192.0.2.20')).not.toBeInTheDocument();expect(table.queryByText('心跳超时')).not.toBeInTheDocument();expect(screen.getByText(/登录连续 30 天/)).toBeVisible();
    await user.click(screen.getByRole('checkbox',{name:'显示未连接登录（2 个）'}));expect(table.getAllByText('192.0.2.20')).toHaveLength(2);expect(table.getByText('心跳超时')).toBeVisible();
    await user.click(screen.getByRole('checkbox',{name:'显示未连接登录（2 个）'}));expect(table.queryByText('192.0.2.20')).not.toBeInTheDocument();
  });
  it('reports no online connection when only valid disconnected logins remain',async()=>{
    const login={...response.users[0].login_sessions![0],presence:{state:'offline' as const,connections:0,last_heartbeat_at:null}};
    vi.mocked(api.admin.monitor).mockResolvedValue({...response,users:[{...response.users[0],presence:login.presence,login_sessions:[login]}]});const client=new QueryClient({defaultOptions:{queries:{retry:false}}}),user=userEvent.setup();render(<QueryClientProvider client={client}><AdminMonitorPage onBack={vi.fn()} onOpenSession={vi.fn()}/></QueryClientProvider>);
    await user.click(await screen.findByRole('button',{name:'展开用户 operator'}));expect(screen.getByText('当前没有在线连接。')).toBeVisible();expect(screen.queryByText('有效登录 · 1 个')).not.toBeInTheDocument();
  });
  it('does not infer browser connectivity from activity, and distinguishes stale heartbeats',async()=>{
    vi.mocked(api.admin.monitor).mockResolvedValue({...response,users:[{...response.users[0],online:false,presence:{state:'unresponsive',connections:0,last_heartbeat_at:'2026-07-31T11:58:00Z'},login_sessions:[]}]});
    const client=new QueryClient({defaultOptions:{queries:{retry:false}}});render(<QueryClientProvider client={client}><AdminMonitorPage onBack={vi.fn()} onOpenSession={vi.fn()}/></QueryClientProvider>);
    expect(await screen.findByText('连接异常')).toBeInTheDocument();expect(screen.getAllByText('未记录')).toHaveLength(2);expect(screen.queryByText('刚刚')).not.toBeInTheDocument();
  });
  it('shows the user-project-tab hierarchy, status help and ended sessions', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const user = userEvent.setup();
    const onOpenSession = vi.fn();
    render(
      <QueryClientProvider client={client}>
        <AdminMonitorPage onBack={vi.fn()} onOpenSession={onOpenSession} />
      </QueryClientProvider>,
    );

    expect(await screen.findByRole('heading', { name: '用户与会话监控' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '服务器资源' })).toBeInTheDocument();
    expect(await screen.findByText('agent-host-01')).toBeInTheDocument();
    expect(screen.getByText('37%')).toBeInTheDocument();
    expect(screen.queryByText('DolphinDB Manager')).not.toBeInTheDocument();
    expect(screen.getByText('192.0.2.11')).toBeInTheDocument();expect(screen.getByText('Chrome · Windows')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '展开用户 operator' }));
    expect(screen.getByText('192.0.2.10')).toBeInTheDocument();expect(screen.getByRole('table',{name:'operator 的登录连接'})).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '展开项目 DolphinDB Manager' }));
    expect(await screen.findByText(/Investigate query latency/)).toBeInTheDocument();
    expect(screen.getAllByText('128 MiB').length).toBeGreaterThan(0);
    expect(screen.getByText('DolphinDB Manager')).toBeInTheDocument();
    expect(screen.getByText('性能排查')).toBeInTheDocument();
    expect(screen.getByText('会话正在执行')).toBeInTheDocument();
    expect(screen.getByText('正在分析慢查询日志…')).toBeInTheDocument();
    expect(screen.queryByText('Old completed task')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '打开会话标签 性能排查' }));
    expect(onOpenSession).toHaveBeenCalledWith('project-1', 'session-live-1234');

    await user.click(screen.getByRole('button', { name: '性能排查 的更多操作' }));
    await user.click(screen.getByRole('menuitem', { name: '重命名' }));
    const nameInput = screen.getByLabelText('会话标签名称');
    await user.clear(nameInput);
    await user.type(nameInput, '新标签名{Enter}');
    expect(api.admin.renameMonitorTab).toHaveBeenCalledWith('user-1', 'project-1', 'session-live-1234', '新标签名');

    await user.click(await screen.findByRole('button', { name: '性能排查 的更多操作' }));
    await user.click(screen.getByRole('menuitem', { name: '停止并关闭' }));
    expect(screen.getByText('停止并关闭会话？')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '停止并关闭' }));
    expect(api.admin.deleteMonitorTab).toHaveBeenCalledWith('user-1', 'project-1', 'session-live-1234');

    await user.click(screen.getByRole('button', { name: '状态说明' }));
    expect(screen.getByText('如何理解状态')).toBeInTheDocument();
    expect(screen.getByText('会话生命周期')).toBeInTheDocument();

    await user.click(screen.getByRole('switch', { name: '显示最近已结束会话' }));
    expect(screen.getByText('Old completed task')).toBeInTheDocument();
  }, 15000);
});
