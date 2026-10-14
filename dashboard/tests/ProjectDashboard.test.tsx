import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectDashboard } from '../src/components/ProjectDashboard';
import { api, type Project, type Session } from '../src/lib/api';
import { useStreamStore } from '../src/lib/websocket';

vi.mock('../src/lib/api', async (original) => {
  const actual = await original<typeof import('../src/lib/api')>();
  return { ...actual, api: { ...actual.api,
    auth: { ...actual.api.auth, status: vi.fn() }, rbac: { ...actual.api.rbac, me: vi.fn() },
    projects: { ...actual.api.projects, list: vi.fn(), create: vi.fn(), delete: vi.fn() }, settings: { ...actual.api.settings, get: vi.fn() },
    sessions: { ...actual.api.sessions, list: vi.fn(), create: vi.fn() },
    git: { ...actual.api.git, status: vi.fn(), branches: vi.fn(), ghAccounts: vi.fn() },
  } };
});

const project = (id: string, name: string, cli: string[], terminal = true): Project => ({
  id, name, path: `/workspace/${name}`, description: null, owner_id: 'admin',
  owner: { id: 'admin', username: 'admin', display_name: '管理员' },
  session_prompt: 'Follow project rules', openclaw_prompt: null, color: '', created_at: '2026-10-13T08:00:00Z',
  tool_access: { can_session: cli.length > 0, can_terminal: terminal, session_clients: cli },
});
const projects = [project('p1', 'Zulu', ['claude', 'codex']), project('p2', 'Alpha', ['codex']), project('p3', 'Denied', [], false)];
const session: Session = { id: 's1', project_id: 'p1', task: 'Investigate memory', status: 'running', mode: 'session', cli_type: 'codex',
  processState: 'idle', content_summary: 'Found an idle worker', last_activity_at: '2026-10-13T08:00:00Z',
  pid: null, exit_code: null, started_at: null, completed_at: null, created_at: '2026-10-13T07:00:00Z' };
let client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks();
  useStreamStore.setState({ liveStates: {}, activityAt: {} });
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  vi.mocked(api.auth.status).mockResolvedValue({ authenticated: true, needsSetup: false, user: { id: 'admin', username: 'admin', display_name: '管理员', role: 'admin' } });
  vi.mocked(api.rbac.me).mockResolvedValue({ user_id: 'admin', roles: [], catalog: [], permissions: { projects_create: 'write' } });
  vi.mocked(api.projects.list).mockResolvedValue({ projects });
  vi.mocked(api.settings.get).mockResolvedValue({ settings: { statusline_prompted: 'true' } });
  vi.mocked(api.sessions.list).mockImplementation(async (_status, projectId) => ({ sessions: projectId ? [session].filter((item) => item.project_id === projectId) : [session] }));
  vi.mocked(api.sessions.create).mockImplementation(async (input) => ({ ok: true, session: { ...session, id: 'new-session', project_id: input.project_id ?? null, mode: input.mode, cli_type: input.cli_type } }));
  vi.mocked(api.git.status).mockResolvedValue({ branch: 'main', ahead: 0, behind: 0, files: [], remoteUrl: null });
  vi.mocked(api.git.branches).mockResolvedValue({ branches: [] });
  vi.mocked(api.git.ghAccounts).mockResolvedValue({ accounts: [] });
});
afterEach(() => client.clear());
async function mount() {
  const open = vi.fn();
  render(<QueryClientProvider client={client}><ProjectDashboard projectOrder={[]} onProjectOrderChange={vi.fn()} onOpenProject={vi.fn()} onOpenSession={open} /></QueryClientProvider>);
  await screen.findByRole('button', { name: '打开项目 Zulu' });
  return open;
}

describe('project table interactions', () => {
  it('opens project creation in a dialog and preserves the expanded list when cancelled', async () => {
    const user = userEvent.setup();
    await mount();
    await user.click(screen.getByRole('button', { name: '展开项目 Zulu 的会话' }));
    const list = screen.getByRole('table', { name: '项目列表' });
    const add = screen.getByRole('button', { name: '新增项目', exact: true });
    await user.click(add);
    const dialog = screen.getByRole('dialog', { name: '新增项目', exact: true });
    expect(within(dialog).queryByText('Default Web Page URL')).not.toBeInTheDocument();
    expect(dialog.querySelector('input[type="url"]')).toBeNull();
    expect(list).toBeVisible();
    expect(within(dialog).getByRole('textbox', { name: '项目路径' })).toHaveFocus();
    await user.type(within(dialog).getByRole('textbox', { name: '项目路径' }), '/workspace/New');
    expect(within(dialog).getByRole('textbox', { name: '项目名称' })).toHaveValue('New');
    await user.click(within(dialog).getByRole('button', { name: '取消', exact: true }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('table', { name: '项目列表' })).toBe(list);
    expect(screen.getByRole('button', { name: '收起项目 Zulu 的会话' })).toHaveAttribute('aria-expanded', 'true');
    expect(add).toHaveFocus();
    expect(api.projects.create).not.toHaveBeenCalled();
    await user.click(add);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps failed project creation in the dialog, blocks closing during submission and closes on success', async () => {
    const user = userEvent.setup();
    await mount();
    let reject!: (error: Error) => void;
    vi.mocked(api.projects.create).mockImplementation(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
    await user.click(screen.getByRole('button', { name: '新增项目', exact: true }));
    const dialog = screen.getByRole('dialog', { name: '新增项目', exact: true });
    await user.type(within(dialog).getByRole('textbox', { name: '项目路径' }), '/workspace/New');
    await user.click(within(dialog).getByRole('button', { name: '新增项目', exact: true }));
    expect(within(dialog).getByRole('button', { name: '关闭新增项目' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: '取消' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(dialog).toBeVisible();
    await act(async () => reject(new Error('目录不存在')));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('目录不存在');
    expect(within(dialog).getByRole('textbox', { name: '项目路径' })).toHaveValue('/workspace/New');
    vi.mocked(api.projects.create).mockResolvedValue({ ok: true, project: project('new-project', 'New', ['claude']) });
    await user.click(within(dialog).getByRole('button', { name: '新增项目', exact: true }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.projects.create).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'New', path: '/workspace/New' }));
  });

  it('excludes ended records from the expanded activity list and removes a row when its session closes', async () => {
    const user = userEvent.setup();
    let rows: Session[] = [session, { ...session, id: 'closed', task: 'Closed task', status: 'cancelled' }, { ...session, id: 'finished', task: 'Finished task', status: 'completed' }];
    vi.mocked(api.sessions.list).mockImplementation(async (_status, projectId) => ({ sessions: projectId ? rows.filter((item) => item.project_id === projectId) : rows }));
    await mount();
    await user.click(screen.getByRole('button', { name: '展开项目 Zulu 的会话' }));
    const detail = await screen.findByRole('table', { name: '项目会话' });
    expect(within(detail).getByText('Investigate memory')).toBeVisible();
    expect(within(detail).queryByText('Closed task')).not.toBeInTheDocument();
    expect(within(detail).queryByText('Finished task')).not.toBeInTheDocument();
    expect(screen.queryByText(/活动会话 ·/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '刷新', exact: true })).not.toBeInTheDocument();
    rows = rows.map((item) => ({ ...item, status: 'cancelled' }));
    await act(async () => { await Promise.all([client.invalidateQueries({ queryKey: ['sessions'] }), client.invalidateQueries({ queryKey: ['project-sessions'] })]); });
    expect(await screen.findByText('该项目暂无活动会话')).toBeVisible();
    expect(screen.getByRole('table', { name: '项目会话' })).toBeVisible();
    expect(client.getQueryData(['project-sessions', 'p1'])).toEqual({ sessions: rows });
  });
  it('keeps the shared table structure when expanding a project with no active sessions', async () => {
    const user = userEvent.setup();
    await mount();
    await user.click(screen.getByRole('button', { name: '展开项目 Alpha 的会话' }));
    expect(await screen.findByText('该项目暂无活动会话')).toBeVisible();
    const detail = screen.getByRole('table', { name: '项目会话' });
    expect(detail).toBeVisible();
    expect(within(detail).getAllByRole('columnheader')).toHaveLength(6);
    expect(screen.queryByText(/活动会话 ·/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '刷新', exact: true })).not.toBeInTheDocument();
  });
  it('keeps two row actions, sorts columns, and preserves management actions inside More', async () => {
    const user = userEvent.setup(); await mount();
    const table = screen.getByRole('table', { name: '项目列表' });
    const row = within(table).getByRole('button', { name: '打开项目 Zulu' }).closest('tr')!;
    expect(within(row.lastElementChild as HTMLElement).getAllByRole('button')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: '编辑项目 Zulu' })).not.toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Zulu 的更多操作' }));
    expect(screen.getByRole('menuitem', { name: '编辑项目' })).toBeVisible();
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['编辑项目', '移除项目']);
    await user.keyboard('{Escape}');
    await user.click(within(table).getByRole('button', { name: '项目排序' }));
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent('Alpha');
    expect(screen.queryByLabelText('拖动 Zulu 排序')).not.toBeInTheDocument();
  });

  it('shows only authorized modes, waits for confirmation, creates the selected session, and opens its actual ID', async () => {
    const user = userEvent.setup(); const open = await mount();
    await user.click(screen.getByRole('button', { name: '打开项目 Alpha' }));
    const dialog = screen.getByRole('dialog', { name: '打开项目 · Alpha' });
    expect(within(dialog).queryByRole('radio', { name: 'Claude' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('radio', { name: 'Codex' })).toBeChecked();
    expect(api.sessions.create).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: '新建会话' }));
    await waitFor(() => expect(api.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ project_id: 'p2', mode: 'session', cli_type: 'codex' })));
    expect(vi.mocked(api.sessions.create).mock.calls[0][0].task).toContain('Follow project rules');
    await waitFor(() => expect(open).toHaveBeenCalledWith('p2', 'new-session'));
    expect(screen.getByRole('button', { name: '打开项目 Denied' })).toBeDisabled();
  });

  it('creates Terminal without a session-client flag or task', async () => {
    const user = userEvent.setup(); await mount();
    await user.click(screen.getByRole('button', { name: '打开项目 Alpha' }));
    await user.click(screen.getByRole('radio', { name: 'Terminal' }));
    await user.click(screen.getByRole('button', { name: '新建会话' }));
    await waitFor(() => expect(api.sessions.create).toHaveBeenCalledWith({ project_id: 'p2', project_path: '/workspace/Alpha', mode: 'terminal' }));
  });

  it('loads a project-specific session list only after expansion, and opens an existing session', async () => {
    const user = userEvent.setup(); const open = await mount();
    expect(api.sessions.list).not.toHaveBeenCalledWith(undefined, 'p1');
    await user.click(screen.getByRole('button', { name: '展开项目 Zulu 的会话' }));
    await waitFor(() => expect(api.sessions.list).toHaveBeenCalledWith(undefined, 'p1'));
    expect(await screen.findByText('Investigate memory')).toBeVisible();
    expect(screen.getByText('空闲')).toBeVisible();
    expect(screen.getByText('Found an idle worker')).toBeVisible();
    const callsBefore = vi.mocked(api.sessions.list).mock.calls.length;
    act(() => {
      useStreamStore.getState().setLiveState('s1', { processState: 'busy', promptType: null, isPermission: false, at: Date.now() });
      useStreamStore.getState().setActivity('s1', Date.parse('2026-10-13T10:00:00Z'));
    });
    expect(screen.getByText('处理中')).toBeVisible();
    expect(api.sessions.list).toHaveBeenCalledTimes(callsBefore);
    await user.click(within(screen.getByRole('table', { name: '项目会话' })).getByRole('button', { name: '查看' }));
    expect(open).toHaveBeenCalledWith('p1', 's1');
  });

  it('keeps creation failures visible and blocks duplicate submissions while a request is pending', async () => {
    const user = userEvent.setup(); await mount();
    let reject!: (error: Error) => void;
    vi.mocked(api.sessions.create).mockImplementation(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
    await user.click(screen.getByRole('button', { name: '打开项目 Zulu' }));
    await user.click(screen.getByRole('button', { name: '新建会话' }));
    expect(screen.getByRole('button', { name: '正在创建…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled();
    await act(async () => reject(new Error('已达到会话额度')));
    expect(await screen.findByRole('alert')).toHaveTextContent('已达到会话额度');
    expect(api.sessions.create).toHaveBeenCalledTimes(1);
  });
});
