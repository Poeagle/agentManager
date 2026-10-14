import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectView } from '../src/components/ProjectView';
import { api, type Project, type Session } from '../src/lib/api';

vi.mock('../src/components/Terminal', () => ({ Terminal: ({ sessionId }: { sessionId: string }) => <div>Live terminal {sessionId}</div> }));
vi.mock('../src/components/HistoryViewer', () => ({ HistoryViewer: ({ sessionId }: { sessionId: string }) => <div>History {sessionId}</div> }));
vi.mock('../src/components/FileExplorer', () => ({ FileExplorer: () => null }));
vi.mock('../src/components/GitPanel', () => ({ GitPanel: () => null }));
vi.mock('../src/components/ProjectSkillsPanel', () => ({ ProjectSkillsPanel: () => null }));
vi.mock('../src/components/ScheduledTasksPanel', () => ({ ScheduledTasksPanel: () => null }));
vi.mock('../src/lib/api', async (original) => {
  const actual = await original<typeof import('../src/lib/api')>();
  return { ...actual, api: { ...actual.api,
    projects: { ...actual.api.projects, list: vi.fn() },
    sessions: { ...actual.api.sessions, list: vi.fn(), create: vi.fn() },
    userState: { ...actual.api.userState, getAll: vi.fn(), set: vi.fn() },
  } };
});

const oldSession: Session = {
  id: 'old-session', project_id: 'p1', task: 'Earlier conversation', status: 'completed', cli_type: 'codex',
  codex_session_id: 'native-history', pid: null, started_at: null, completed_at: '2026-10-01T08:00:00Z',
  exit_code: 0, created_at: '2026-10-01T07:00:00Z',
};
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  vi.mocked(api.projects.list).mockResolvedValue({ projects: [] });
  vi.mocked(api.sessions.list).mockImplementation(async (_status, projectId) => ({ sessions: projectId ? [oldSession] : [] }));
  vi.mocked(api.userState.set).mockResolvedValue({ ok: true });
  vi.mocked(api.userState.getAll).mockResolvedValue({ state: {} });
});

describe('project workspace navigation', () => {
  it('ignores legacy webpage selection and restores the existing terminal without creating a session', async () => {
    const session = { ...oldSession, id: 'current', status: 'running' as const };
    vi.mocked(api.sessions.list).mockResolvedValue({ sessions: [session] });
    const saved = {
      activeMode: 'terminal', explorerInstances: [], terminalInstances: [{ id: 'current', label: 'Session 1', customLabel: 'Investigation' }],
      activeTerminalId: null, webPageInstances: [{ id: 'u1-p1-webpage-1', label: 'Old preview', url: 'https://example.com' }], activeWebPageId: 'u1-p1-webpage-1',
    };
    localStorage.setItem('agentmanager-project-u1-p1', JSON.stringify(saved));
    vi.mocked(api.userState.getAll).mockResolvedValue({ state: { 'project:p1': saved } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<QueryClientProvider client={client}><ProjectView currentUserId="u1" projectId="p1" projectPath="/workspace/p1" projectName="Workspace" /></QueryClientProvider>);
    try {
      expect(await screen.findByText('Live terminal current')).toBeVisible();
      expect(screen.queryByText('Old preview')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '打开网页' })).not.toBeInTheDocument();
      expect(view.container.querySelector('iframe')).toBeNull();
      expect(api.sessions.create).not.toHaveBeenCalled();
      await waitFor(() => {
        const cached = JSON.parse(localStorage.getItem('agentmanager-project-u1-p1')!);
        expect(cached.activeTerminalId).toBe('current');
        expect(cached.terminalInstances[0].customLabel).toBe('Investigation');
        expect(cached).not.toHaveProperty('webPageInstances');
        expect(cached).not.toHaveProperty('activeWebPageId');
      });
    } finally { view.unmount(); client.clear(); }
  });
  it('ignores the saved Home selection, opens an existing session, and creates or cancels directly from +', async () => {
    const user = userEvent.setup();
    const project: Project = { id: 'p1', name: 'Workspace', path: '/workspace/p1', description: null, session_prompt: null,
      openclaw_prompt: null, color: '', created_at: '2026-10-14T00:00:00Z',
      tool_access: { can_session: true, can_terminal: false, session_clients: ['codex'] } };
    const current: Session = { ...oldSession, id: 'current', status: 'running' };
    let sessions = [current];
    vi.mocked(api.projects.list).mockResolvedValue({ projects: [project] });
    vi.mocked(api.sessions.list).mockImplementation(async () => ({ sessions }));
    vi.mocked(api.sessions.create).mockImplementation(async () => {
      const session: Session = { ...current, id: 'created' }; sessions = [current, session]; return { ok: true, session };
    });
    localStorage.setItem('agentmanager-project-u1-p1', JSON.stringify({ activeMode: 'terminal', explorerInstances: [], terminalInstances: [{ id: 'current', label: 'Session 1' }], activeTerminalId: 'current', showLauncher: true }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<QueryClientProvider client={client}><ProjectView currentUserId="u1" projectId="p1" projectPath={project.path} projectName={project.name} /></QueryClientProvider>);
    try {
      expect(await screen.findByText('Live terminal current')).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Home', exact: true })).not.toBeInTheDocument();
      expect(screen.queryByRole('table', { name: '工作区入口' })).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: '新建会话', exact: true }));
      expect(screen.getByRole('dialog', { name: '新建会话 · Workspace' })).toBeVisible();
      expect(screen.queryByRole('radio', { name: 'Terminal' })).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: '取消' }));
      expect(screen.getByText('Live terminal current')).toBeVisible();
      expect(api.sessions.create).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: '新建会话', exact: true }));
      await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '新建会话', exact: true }));
      expect(await screen.findByText('Live terminal created')).toBeVisible();
      expect(api.sessions.create).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '打开网页' })).not.toBeInTheDocument();
    } finally { view.unmount(); client.clear(); }
  });
  it('opens an older record after saved tabs finish loading and keeps it open through session refreshes', async () => {
    let restore!: (value: { state: Record<string, unknown> }) => void;
    vi.mocked(api.userState.getAll).mockReturnValue(new Promise((resolve) => { restore = resolve; }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const handled = vi.fn();
    const view = render(<QueryClientProvider client={client}><ProjectView currentUserId="u1" projectId="p1" projectPath="/workspace/p1" projectName="p1"
      focusSessionId="old-session" onFocusSessionHandled={handled} /></QueryClientProvider>);
    try {
      await waitFor(() => expect(api.sessions.list).toHaveBeenCalledWith(undefined, 'p1'));
      expect(screen.queryByText('History old-session')).not.toBeInTheDocument();
      expect(handled).not.toHaveBeenCalled();
      await act(async () => restore({ state: { 'project:p1': { terminalInstances: [], hiddenSessionIds: ['old-session'] } } }));
      expect(await screen.findByText('History old-session')).toBeVisible();
      await waitFor(() => expect(handled).toHaveBeenCalled());
      await act(async () => { await client.invalidateQueries({ queryKey: ['sessions'] }); });
      expect(screen.getByText('History old-session')).toBeVisible();
      expect(client.getQueryData(['sessions'])).toEqual({ sessions: [] });
    } finally { view.unmount(); client.clear(); }
  });
});
