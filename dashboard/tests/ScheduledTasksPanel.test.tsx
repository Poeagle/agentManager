import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ScheduledTasksPanel } from '../src/components/ScheduledTasksPanel';
import { api, type ScheduledTask, type Session } from '../src/lib/api';

vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return {
    ...actual,
    api: {
      ...actual.api,
      scheduledTasks: {
        list: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), run: vi.fn(), runs: vi.fn(), codexQuota: vi.fn(),
      },
      sessions: { ...actual.api.sessions, list: vi.fn() },
    },
  };
});

const task: ScheduledTask = {
  id: 'schedule-1',
  user_id: 'user-1',
  project_id: 'project-1',
  name: '每日代码巡检',
  prompt: '检查测试状态',
  schedule_kind: 'daily',
  schedule_value: '09:30',
  timezone: 'Asia/Taipei',
  target_type: 'existing',
  target_session_id: 'session-1',
  new_mode: null,
  new_cli_type: null,
  new_agent_type: null,
  inactive_policy: 'resume',
  enabled: 1,
  next_run_at: '2026-08-14T01:30:00.000Z',
  successful_runs: 0,
  consecutive_failures: 0,
  last_quota_remaining: null,
  stopped_at: null,
  stop_reason: null,
  last_run_at: null,
  last_status: null,
  last_error: null,
  created_at: '2026-08-13T00:00:00Z',
  updated_at: '2026-08-13T00:00:00Z',
};

const session: Session = {
  id: 'session-1', project_id: 'project-1', task: 'Review code', status: 'running', mode: 'session',
  pid: null, started_at: null, completed_at: null, exit_code: null, created_at: '2026-08-13T00:00:00Z',
};

const historicalSession: Session = {
  ...session,
  id: 'session-history',
  task: 'Old terminal',
  status: 'completed',
  created_at: '2026-07-01T00:00:00Z',
};

function renderPanel(sessionTabs: Array<{ id: string; label: string; customLabel?: string }> = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><ScheduledTasksPanel projectId="project-1" sessionTabs={sessionTabs} /></QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.scheduledTasks.list).mockResolvedValue({ tasks: [task] });
  vi.mocked(api.scheduledTasks.runs).mockResolvedValue({ runs: [] });
  vi.mocked(api.scheduledTasks.run).mockResolvedValue({
    ok: true,
    run: {
      id: 'run-1', task_id: task.id, trigger: 'manual', scheduled_for: task.next_run_at!, status: 'success',
      session_id: session.id, error: null, started_at: '2026-08-13T01:00:00Z', completed_at: '2026-08-13T01:00:01Z',
    },
  });
  vi.mocked(api.scheduledTasks.codexQuota).mockResolvedValue({
    quota: {
      usedPercent: 35, remainingPercent: 65, windowDurationMins: 10080,
      resetsAt: 1787196804, planType: 'pro', checkedAt: '2026-08-13T08:00:00Z',
    },
  });
  vi.mocked(api.sessions.list).mockResolvedValue({ sessions: [session, historicalSession] });
  vi.mocked(api.scheduledTasks.create).mockImplementation(async (input) => ({
    ok: true,
    task: { ...task, ...input, id: 'schedule-new', enabled: input.enabled ? 1 : 0 },
  }));
});

describe('ScheduledTasksPanel', () => {
  it('shows the next run and can execute a task immediately', async () => {
    const user = userEvent.setup();
    renderPanel();

    expect(await screen.findByText('每日代码巡检')).toBeInTheDocument();
    expect(screen.getByText(/每天 09:30/)).toBeInTheDocument();
    await user.click(screen.getByTitle('立即执行'));
    await waitFor(() => expect(api.scheduledTasks.run).toHaveBeenCalledWith('schedule-1'));
  });

  it('creates a new server-side session schedule with the entered prompt', async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('每日代码巡检');

    await user.click(screen.getByRole('button', { name: '新建任务' }));
    await user.type(screen.getByPlaceholderText('例如：每日代码巡检'), '夜间测试');
    await user.type(screen.getByPlaceholderText('到时间后发送给标签页的完整指令…'), '运行完整测试并总结失败项');
    await user.click(screen.getByRole('button', { name: '创建任务' }));

    await waitFor(() => expect(api.scheduledTasks.create).toHaveBeenCalledWith(expect.objectContaining({
      project_id: 'project-1',
      name: '夜间测试',
      prompt: '运行完整测试并总结失败项',
      target_type: 'new',
      new_mode: 'session',
      schedule_kind: 'daily',
      schedule_value: '09:00',
    })));
  });

  it('uses the visible tab name when selecting an existing target', async () => {
    const user = userEvent.setup();
    renderPanel([{ id: session.id, label: 'Session 1', customLabel: '代码巡检主会话' }]);

    await screen.findByText('每日代码巡检');
    await user.click(screen.getByRole('button', { name: /现有标签页/ }));
    expect(screen.getByRole('option', { name: '代码巡检主会话 · Session · running' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Old terminal/ })).not.toBeInTheDocument();
  });

  it('configures stop guards and shows the live Codex weekly quota', async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('每日代码巡检');

    await user.click(screen.getByRole('button', { name: 'Codex' }));
    expect(await screen.findByText('剩余 65%')).toBeInTheDocument();
    await user.type(screen.getByRole('spinbutton', { name: /成功执行后停止/ }), '2');
    await user.type(screen.getByRole('spinbutton', { name: /连续失败后停止/ }), '3');
    await user.type(screen.getByRole('spinbutton', { name: /Codex 周额度低于/ }), '20');
    await user.type(screen.getByPlaceholderText('例如：每日代码巡检'), '受保护任务');
    await user.type(screen.getByPlaceholderText('到时间后发送给标签页的完整指令…'), '继续工作');
    await user.click(screen.getByRole('button', { name: '创建任务' }));

    await waitFor(() => expect(api.scheduledTasks.create).toHaveBeenCalledWith(expect.objectContaining({
      new_cli_type: 'codex',
      max_successful_runs: 2,
      max_consecutive_failures: 3,
      quota_remaining_below: 20,
    })));
  });
});
