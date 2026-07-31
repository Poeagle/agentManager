import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
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
    agent_type: null,
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
  vi.mocked(api.admin.renameMonitorTab).mockResolvedValue({ ok: true, tab: { id: 'session-live-1234', name: '新标签名' } });
  vi.mocked(api.admin.deleteMonitorTab).mockResolvedValue({ ok: true, session_continues: true });
});

describe('administrator monitor page', () => {
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
    expect(await screen.findByText(/Investigate query latency/)).toBeInTheDocument();
    expect(screen.getAllByText('128 MiB').length).toBeGreaterThan(0);
    expect(screen.getByText('DolphinDB Manager')).toBeInTheDocument();
    expect(screen.getByText('性能排查')).toBeInTheDocument();
    expect(screen.getByText('Agent 正在执行')).toBeInTheDocument();
    expect(screen.getByText('正在分析慢查询日志…')).toBeInTheDocument();
    expect(screen.queryByText('Old completed task')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '打开会话标签 性能排查' }));
    expect(onOpenSession).toHaveBeenCalledWith('project-1', 'session-live-1234');

    await user.click(screen.getByRole('button', { name: '重命名会话标签 性能排查' }));
    const nameInput = screen.getByLabelText('会话标签名称');
    await user.clear(nameInput);
    await user.type(nameInput, '新标签名{Enter}');
    expect(api.admin.renameMonitorTab).toHaveBeenCalledWith('user-1', 'project-1', 'session-live-1234', '新标签名');

    await user.click(await screen.findByRole('button', { name: '删除会话标签 性能排查' }));
    expect(screen.getByText('删除会话标签？')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '仅删除标签' }));
    expect(api.admin.deleteMonitorTab).toHaveBeenCalledWith('user-1', 'project-1', 'session-live-1234');

    await user.click(screen.getByRole('button', { name: '状态说明' }));
    expect(screen.getByText('如何理解状态')).toBeInTheDocument();
    expect(screen.getByText('会话生命周期')).toBeInTheDocument();

    await user.click(screen.getByRole('switch', { name: '显示最近已结束会话' }));
    expect(screen.getByText('Old completed task')).toBeInTheDocument();
  });
});
