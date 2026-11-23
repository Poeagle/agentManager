import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionHistoryPanel } from '../src/components/SessionHistoryPanel';
import { api, type Session } from '../src/lib/api';

vi.mock('../src/lib/api', async (original) => {
  const actual = await original<typeof import('../src/lib/api')>();
  return { ...actual, api: { ...actual.api, codexEnvironments:{...actual.api.codexEnvironments,list:vi.fn(async()=>({environments:[{id:'native',name:'本机 Engine'}]}))}, sessions: { ...actual.api.sessions, list: vi.fn(), deleteRecord: vi.fn(), queueEndedRecordDeletions: vi.fn(), output: vi.fn() },agent:{...actual.api.agent,conversation:vi.fn()} } };
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
  vi.mocked(api.agent.conversation).mockResolvedValue({messages:[{id:'q',role:'user',text:'用户问题不冒充进展',timestamp:null},{id:'progress',role:'assistant',phase:'commentary',text:'正在核对配置。',timestamp:'2026-10-31T02:00:00Z'},{id:'result',role:'assistant',phase:'final',text:'已完成核对。',timestamp:'2026-10-31T02:01:00Z'}]} as any);
  vi.mocked(api.sessions.output).mockResolvedValue({ chunks: [], hasMore: false, oldestSeq: null });
  vi.mocked(api.sessions.queueEndedRecordDeletions).mockImplementation(async (_project, ids) => {
    records = records.map(record => ids.includes(record.id) ? { ...record, record_deletion: 'pending' } : record);
    return { accepted_ids: ids, rejected_ids: [] };
  });
});
afterEach(() => client.clear());
async function mount() {
  render(<QueryClientProvider client={client}><SessionHistoryPanel projectId="project" openTabIds={new Set(['ended'])}
    displayNames={{ ended: '已关闭的会话' }} onOpen={vi.fn()} /></QueryClientProvider>);
  await screen.findByRole('button', { name: '删除会话 已关闭的会话' });
}

describe('project session deletion', () => {
  it('shows background deletion and enables retry only after failure', async () => {
    records = [{...ended,record_deletion:'pending'}];
    const user = userEvent.setup();
    await mount();
    expect(screen.getByText('后台删除中')).toBeVisible();
    expect(screen.getByRole('button',{name:'删除会话 已关闭的会话'})).toBeDisabled();
    expect(screen.getByRole('button',{name:'已关闭的会话',exact:true})).toBeDisabled();

    records = [{...ended,record_deletion:'failed'}];
    await act(async () => { await client.invalidateQueries({queryKey:['project-sessions','project']}); });
    expect(await screen.findByText('删除失败，可重试')).toBeVisible();
    await user.click(screen.getByRole('button',{name:'删除会话 已关闭的会话'}));
    await user.click(within(screen.getByRole('dialog')).getByRole('button',{name:'删除记录',exact:true}));
    await waitFor(() => expect(screen.queryByText('删除失败，可重试')).not.toBeInTheDocument());
  });

  it('closes bulk confirmation on queue acceptance, keeps rejected rows selected, and allows more work', async () => {
    records = [ended, active, { ...ended, id: 'second', task: 'Second task', agent_environment_id: 'provider:xindu' }];
    vi.mocked(api.sessions.queueEndedRecordDeletions).mockImplementation(async () => {
      records = records.map(row => row.id === 'ended' ? { ...row, record_deletion: 'pending' } : row);
      return { accepted_ids: ['ended'], rejected_ids: ['second'] };
    });
    const user = userEvent.setup();
    await mount();
    expect(await screen.findByText('xindu')).toBeVisible();
    expect(screen.getByRole('checkbox', { name: '选择会话 Active task' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: '全选可删除会话' }));
    await user.click(screen.getByRole('button', { name: '批量删除 (2)' }));
    expect(api.sessions.queueEndedRecordDeletions).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '确认批量删除' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.sessions.queueEndedRecordDeletions).toHaveBeenCalledExactlyOnceWith('project', ['ended', 'second']);
    expect(api.sessions.deleteRecord).not.toHaveBeenCalled();
    expect(await screen.findByText('后台删除中')).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('1 条未提交');
    expect(screen.getByRole('checkbox', { name: '选择会话 Second task' })).toBeChecked();
    expect(screen.getByRole('button', { name: '批量删除 (1)' })).toBeEnabled();
  });

  it('keeps the bulk confirmation and selection when the queue request fails', async () => {
    vi.mocked(api.sessions.queueEndedRecordDeletions).mockRejectedValueOnce(new Error('暂时无法提交'));
    const user = userEvent.setup();
    await mount();
    await user.click(screen.getByRole('checkbox', { name: '选择会话 已关闭的会话' }));
    await user.click(screen.getByRole('button', { name: '批量删除 (1)' }));
    const dialog = screen.getByRole('dialog', { name: '批量删除会话记录' });
    await user.click(within(dialog).getByRole('button', { name: '确认批量删除' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('暂时无法提交');
    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(screen.getByRole('checkbox', { name: '选择会话 已关闭的会话' })).toBeChecked();
  });
  it('uses the common actions column and seven-column detail rows, and waits for confirmation', async () => {
    const user = userEvent.setup();
    await mount();
    const table = screen.getByRole('table', { name: '会话历史' });
    expect(within(table).getAllByRole('columnheader').at(-1)).toHaveTextContent('操作');
    expect(screen.getByRole('button', { name: '删除会话 Active task' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '展开会话 已关闭的会话' }));
    expect((await screen.findByText('最近会话内容')).closest('td')).toHaveAttribute('colspan', '8');await screen.findByText('已完成核对。');expect(screen.getByText('正在核对配置。')).toBeVisible();expect(screen.getByText('进展')).toBeVisible();expect(screen.getByText('结果')).toBeVisible();expect(screen.queryByText('用户问题不冒充进展')).not.toBeInTheDocument();expect(api.sessions.output).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '删除会话 已关闭的会话' }));
    expect(api.sessions.queueEndedRecordDeletions).not.toHaveBeenCalled();
    await user.click(within(screen.getByRole('dialog', { name: '删除记录' })).getByRole('button', { name: '取消' }));
    expect(api.sessions.queueEndedRecordDeletions).not.toHaveBeenCalled();
    expect(within(table).getByRole('button', { name: '删除会话 已关闭的会话' })).toBeVisible();
  });

  it('closes single confirmation on acceptance and retains the pending row until cleanup', async () => {
    const user = userEvent.setup();
    await mount();
    await user.click(screen.getByRole('button', { name: '删除会话 已关闭的会话' }));
    await user.click(within(screen.getByRole('dialog', { name: '删除记录' })).getByRole('button', { name: '删除记录', exact: true }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.sessions.queueEndedRecordDeletions).toHaveBeenCalledExactlyOnceWith('project', ['ended']);
    expect(api.sessions.deleteRecord).not.toHaveBeenCalled();
    expect(await screen.findByText('已提交 1 条后台删除。')).toBeVisible();
    expect(screen.getByRole('button', { name: '删除会话 已关闭的会话' })).toBeDisabled();
    expect(screen.getByText('后台删除中')).toBeVisible();
    records = [active];
    await act(async () => { await client.invalidateQueries({ queryKey: ['project-sessions', 'project'] }); });
    await waitFor(() => expect(screen.queryByRole('button', { name: '删除会话 已关闭的会话' })).not.toBeInTheDocument());
  });

  it('keeps the single confirmation open when the record could not be accepted', async () => {
    vi.mocked(api.sessions.queueEndedRecordDeletions).mockResolvedValueOnce({ accepted_ids: [], rejected_ids: ['ended'] });
    const user = userEvent.setup();
    await mount();
    const remove = screen.getByRole('button', { name: '删除会话 已关闭的会话' });
    await user.click(remove);
    const dialog = screen.getByRole('dialog', { name: '删除记录' });
    await user.click(within(dialog).getByRole('button', { name: '删除记录', exact: true }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('未能提交这条会话记录');
    expect(screen.queryByText('后台删除中')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(remove).toBeEnabled();
  });

  it('blocks duplicate submissions and closing while pending, and preserves the row and tab on failure', async () => {
    const user = userEvent.setup();
    await mount();
    let reject!: (error: Error) => void;
    vi.mocked(api.sessions.queueEndedRecordDeletions).mockImplementationOnce(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
    await user.click(screen.getByRole('button', { name: '删除会话 已关闭的会话' }));
    const dialog = screen.getByRole('dialog', { name: '删除记录' });
    await user.dblClick(within(dialog).getByRole('button', { name: '删除记录', exact: true }));
    expect(api.sessions.queueEndedRecordDeletions).toHaveBeenCalledOnce();
    expect(within(dialog).getByRole('button', { name: '取消' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(dialog).toBeVisible();
    await act(async () => reject(new Error('无法删除记录')));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('无法删除记录');
    expect(client.getQueryData<{ sessions: Session[] }>(['project-sessions', 'project'])?.sessions).toContainEqual(ended);
    await user.click(within(dialog).getByRole('button', { name: '删除记录', exact: true }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByText('后台删除中')).toBeVisible();
  });
});
