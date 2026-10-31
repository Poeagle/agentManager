import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionHistoryPanel } from '../src/components/SessionHistoryPanel';
import { api, type Session } from '../src/lib/api';

vi.mock('../src/lib/api', async (original) => {
  const actual = await original<typeof import('../src/lib/api')>();
  return { ...actual, api: { ...actual.api, sessions: { ...actual.api.sessions, list: vi.fn(), deleteRecord: vi.fn(), output: vi.fn() } } };
});

const ended: Session = { id: 'ended', project_id: 'project', task: 'Ended task', status: 'cancelled', mode: 'session', cli_type: 'codex',
  pid: null, exit_code: null, started_at: null, completed_at: '2026-10-14T08:00:00Z', created_at: '2026-10-14T07:00:00Z' };
const active: Session = { ...ended, id: 'active', task: 'Active task', status: 'running' };
let client: QueryClient;
let records: Session[];
beforeEach(() => {
  vi.clearAllMocks();
  records = [ended, active];
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(['sessions'], { sessions: [ended, active, { ...ended, id: 'other-project', project_id: 'other' }] });
  vi.mocked(api.sessions.list).mockImplementation(async () => ({ sessions: records }));
  vi.mocked(api.sessions.output).mockResolvedValue({ chunks: [], hasMore: false, oldestSeq: null });
  vi.mocked(api.sessions.deleteRecord).mockImplementation(async (id) => { records = records.filter((record) => record.id !== id); return { ok: true }; });
});
afterEach(() => client.clear());
async function mount() {
  const onDeleted = vi.fn();
  render(<QueryClientProvider client={client}><SessionHistoryPanel projectId="project" openTabIds={new Set(['ended'])}
    displayNames={{ ended: '已关闭的会话' }} onOpen={vi.fn()} onDeleted={onDeleted} /></QueryClientProvider>);
  await screen.findByRole('button', { name: '删除会话 已关闭的会话' });
  return onDeleted;
}

describe('project session deletion', () => {
  it('uses the common actions column and seven-column detail rows, and waits for confirmation', async () => {
    const user = userEvent.setup();
    await mount();
    const table = screen.getByRole('table', { name: '会话历史' });
    expect(within(table).getAllByRole('columnheader').at(-1)).toHaveTextContent('操作');
    expect(screen.getByRole('button', { name: '删除会话 Active task' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '展开会话 已关闭的会话' }));
    expect((await screen.findByText('最近会话内容')).closest('td')).toHaveAttribute('colspan', '7');
    await user.click(screen.getByRole('button', { name: '删除会话 已关闭的会话' }));
    expect(api.sessions.deleteRecord).not.toHaveBeenCalled();
    await user.click(within(screen.getByRole('dialog', { name: '删除记录' })).getByRole('button', { name: '取消' }));
    expect(api.sessions.deleteRecord).not.toHaveBeenCalled();
    expect(within(table).getByRole('button', { name: '删除会话 已关闭的会话' })).toBeVisible();
  });

  it('removes the deleted record and its detail cache, and notifies the workspace to remove the open tab', async () => {
    const user = userEvent.setup();
    const onDeleted = await mount();
    client.setQueryData(['project-session-detail', 'ended'], { chunks: [] });
    await user.click(screen.getByRole('button', { name: '删除会话 已关闭的会话' }));
    await user.click(within(screen.getByRole('dialog', { name: '删除记录' })).getByRole('button', { name: '删除记录', exact: true }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.sessions.deleteRecord).toHaveBeenCalledWith('ended');
    expect(onDeleted).toHaveBeenCalledOnce();
    expect(onDeleted).toHaveBeenCalledWith('ended');
    expect(screen.queryByRole('button', { name: '删除会话 已关闭的会话' })).not.toBeInTheDocument();
    expect(client.getQueryData<{ sessions: Session[] }>(['sessions'])?.sessions.map((session) => session.id)).toEqual(['active', 'other-project']);
    expect(client.getQueryData(['project-session-detail', 'ended'])).toBeUndefined();
  });

  it('blocks duplicate submissions and closing while pending, and preserves the row and tab on failure', async () => {
    const user = userEvent.setup();
    const onDeleted = await mount();
    let reject!: (error: Error) => void;
    vi.mocked(api.sessions.deleteRecord).mockImplementation(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
    await user.click(screen.getByRole('button', { name: '删除会话 已关闭的会话' }));
    const dialog = screen.getByRole('dialog', { name: '删除记录' });
    await user.dblClick(within(dialog).getByRole('button', { name: '删除记录', exact: true }));
    expect(api.sessions.deleteRecord).toHaveBeenCalledOnce();
    expect(within(dialog).getByRole('button', { name: '取消' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(dialog).toBeVisible();
    await act(async () => reject(new Error('无法删除记录')));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('无法删除记录');
    expect(onDeleted).not.toHaveBeenCalled();
    expect(client.getQueryData<{ sessions: Session[] }>(['project-sessions', 'project'])?.sessions).toContainEqual(ended);
    vi.mocked(api.sessions.deleteRecord).mockImplementation(async (id) => { records = records.filter((record) => record.id !== id); return { ok: true }; });
    await user.click(within(dialog).getByRole('button', { name: '删除记录', exact: true }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith('ended'));
  });
});
