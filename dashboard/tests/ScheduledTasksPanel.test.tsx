import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  inactive_policy: 'resume',
  daily_stop_time: null,
  enabled: 1,
  next_run_at: '2026-08-14T01:30:00.000Z',
  daily_stop_at: null,
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
    expect(screen.getByRole('table', { name: '定时任务列表' })).toBeVisible();
    expect(screen.queryByLabelText('任务运行情况')).not.toBeInTheDocument();
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
      schedule_kind: 'interval',
      schedule_value: '60',
      daily_start_time: null,
      daily_end_time: null,
      start_conditions: { operator: 'and', conditions: [{ type: 'time_after', value: '09:00' }] },
      daily_stop_conditions: { operator: 'or', conditions: [{ type: 'time_after', value: '18:00' }] },
      condition_unmet_policy: 'skip',
    })));
  });

  it('uses the visible tab name when selecting an existing target', async () => {
    const user = userEvent.setup();
    renderPanel([{ id: session.id, label: 'Session 1', customLabel: '代码巡检主会话' }]);

    await screen.findByText('每日代码巡检');
    await user.click(screen.getByRole('button', { name: '新建任务' }));
    await user.click(screen.getByRole('button', { name: /现有标签页/ }));
    expect(screen.getByRole('option', { name: '代码巡检主会话 · Session · running' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Old terminal/ })).not.toBeInTheDocument();
  });

  it('keeps daily pauses separate from optional permanent limits and shows Codex quota', async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('每日代码巡检');

    await user.click(screen.getByRole('button', { name: '新建任务' }));
    await user.click(screen.getByRole('button', { name: 'Codex' }));
    await user.click(screen.getByText('任务截止限制（可选，到期后需手动重新启用）'));
    const addCondition = screen.getByRole('button', { name: '添加停止条件' });
    await user.click(addCondition);
    await user.selectOptions(screen.getByLabelText('停止条件 1'), 'success_count');
    await user.clear(screen.getByLabelText('成功执行次数'));
    await user.type(screen.getByLabelText('成功执行次数'), '2');
    await user.click(addCondition);
    await user.selectOptions(screen.getByLabelText('停止条件 2'), 'failure_count');
    await user.clear(screen.getByLabelText('连续失败次数'));
    await user.type(screen.getByLabelText('连续失败次数'), '3');
    await user.click(addCondition);
    await user.selectOptions(screen.getByLabelText('停止条件 3'), 'quota_floor');
    expect(await screen.findByText('65%')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Codex 周额度下限'));
    await user.type(screen.getByLabelText('Codex 周额度下限'), '20');
    fireEvent.change(screen.getByLabelText('每天停止条件 1时间'), { target: { value: '18:30' } });
    await user.type(screen.getByPlaceholderText('例如：每日代码巡检'), '受保护任务');
    await user.type(screen.getByPlaceholderText('到时间后发送给标签页的完整指令…'), '继续工作');
    await user.click(screen.getByRole('button', { name: '创建任务' }));

    await waitFor(() => expect(api.scheduledTasks.create).toHaveBeenCalledWith(expect.objectContaining({
      new_cli_type: 'codex',
      max_successful_runs: 2,
      max_consecutive_failures: 3,
      quota_remaining_below: 20,
      daily_stop_time: null,
      daily_stop_conditions: { operator: 'or', conditions: [{ type: 'time_after', value: '18:30' }] },
    })));
  });

  it('separates the list and settings, and preserves an existing unwindowed schedule', async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('每日代码巡检');
    expect(screen.queryByLabelText('任务名称')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: `查看任务 ${task.name}` }));
    expect(screen.queryByLabelText('定时任务展示')).not.toBeInTheDocument();
    expect(screen.getByLabelText('任务名称')).toHaveValue(task.name);
    expect(screen.getByLabelText('任务运行情况')).toBeVisible();
    await user.selectOptions(screen.getByLabelText('执行周期'), 'interval');
    expect(screen.queryByLabelText('限定每天执行时段')).not.toBeInTheDocument();
    expect(screen.getByText('不限制开始条件，按周期执行。')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '返回任务列表' }));
    expect(screen.getByLabelText('定时任务展示')).toBeVisible();
    expect(screen.queryByLabelText('任务名称')).not.toBeInTheDocument();
  });

  it('saves daily conditions in the single execution configuration area', async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText(task.name);
    await user.click(screen.getByRole('button', { name: '新建任务' }));
    await user.type(screen.getByLabelText('任务名称'), '白天巡检');
    await user.type(screen.getByLabelText('提示词'), '继续检查');
    await user.clear(screen.getByLabelText('执行间隔'));
    await user.type(screen.getByLabelText('执行间隔'), '30');
    await user.click(screen.getByRole('button', { name: '创建任务' }));
    await waitFor(() => expect(api.scheduledTasks.create).toHaveBeenCalledWith(expect.objectContaining({
      daily_start_time: null, daily_end_time: null, schedule_value: '30', daily_stop_time: null,
      start_conditions: { operator: 'and', conditions: [{ type: 'time_after', value: '09:00' }] },
      daily_stop_conditions: { operator: 'or', conditions: [{ type: 'time_after', value: '18:00' }] },
      condition_unmet_policy: 'skip',
    })));
    await waitFor(() => expect(screen.getByLabelText('定时任务展示')).toBeVisible());
    expect(screen.queryByLabelText('定时任务设置')).not.toBeInTheDocument();
  });

  it('supports mixed AND/OR groups and preserves them on save', async () => {
    const user = userEvent.setup();
    renderPanel([{ id: session.id, label: '巡检' }]);
    await screen.findByText(task.name);
    await user.click(screen.getByRole('button', { name: '新建任务' }));
    await user.click(screen.getByRole('button', { name: /现有标签页/ }));
    await user.selectOptions(screen.getByLabelText('目标标签页'), session.id);
    await user.click(screen.getByRole('button', { name: '每次开始条件添加分组' }));
    await user.click(screen.getByRole('button', { name: '每次开始条件 2分组添加条件' }));
    await user.selectOptions(screen.getByLabelText('每次开始条件 2分组 2'), 'weekday');
    await user.type(screen.getByLabelText('任务名称'), '条件巡检');
    await user.type(screen.getByLabelText('提示词'), '继续检查');
    await user.click(screen.getByRole('button', { name: '创建任务' }));
    await waitFor(() => expect(api.scheduledTasks.create).toHaveBeenCalledWith(expect.objectContaining({
      condition_unmet_policy: 'skip',
      start_conditions: { operator: 'and', conditions: [
        { type: 'time_after', value: '09:00' },
        { operator: 'or', conditions: [{ type: 'target_idle', value: true }, { type: 'weekday', value: 'workday' }] },
      ] },
    })));
  });

  it('shows execution time, status and result in a table after the prompt', async () => {
    vi.mocked(api.scheduledTasks.runs).mockResolvedValue({ runs: [{
      id: 'skip', task_id: task.id, trigger: 'scheduled', scheduled_for: task.next_run_at!, status: 'skipped',
      session_id: session.id, error: '标签页仍忙，跳过本次', started_at: '2026-10-13T01:30:00Z', completed_at: '2026-10-13T01:30:01Z',
    }] });
    const user = userEvent.setup();
    renderPanel([{ id: session.id, label: '巡检' }]);
    await user.click(await screen.findByRole('button', { name: `查看任务 ${task.name}` }));
    const table = await screen.findByRole('table', { name: '定时任务执行记录' });
    const save = screen.getByRole('button', { name: '保存更改' });
    expect(save.closest('header')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '保存更改' })).toHaveLength(1);
    expect(within(table).getByRole('columnheader', { name: '执行时间' })).toBeVisible();
    expect(await within(table).findByText('已跳过')).toBeVisible();
    expect(within(table).getByText('标签页仍忙，跳过本次')).toBeVisible();
    expect(screen.getByLabelText('提示词').compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
