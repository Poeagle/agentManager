import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectView } from '../src/components/ProjectView';
import { api, type Session } from '../src/lib/api';
import { useStreamStore } from '../src/lib/websocket';

vi.mock('../src/components/Terminal', () => ({ Terminal: ({ sessionId, onConnectionError }: { sessionId: string; onConnectionError?:(id:string,message:string)=>void }) => <div>Live terminal {sessionId}<button onClick={()=>onConnectionError?.(sessionId,'Session not found or not running')}>模拟连接失败</button></div> }));
vi.mock('../src/components/SessionWorkspacePane', () => ({SessionWorkspacePane: ({session,renderTerminal}: {session:Session;renderTerminal:(visible:boolean,suspend:boolean,onReady:()=>void)=>React.ReactNode})=><div data-testid="session-pane" data-native-id={session.codex_session_id||''}>{renderTerminal(true,false,()=>{})}</div>}));
vi.mock('../src/components/HistoryViewer', () => ({ HistoryViewer: ({ sessionId }: { sessionId: string }) => <div>History {sessionId}</div> }));
vi.mock('../src/components/FileExplorer', () => ({ FileExplorer: () => null }));
vi.mock('../src/components/GitPanel', () => ({ GitPanel: () => null }));
vi.mock('../src/components/ProjectSkillsPanel', () => ({ ProjectSkillsPanel: () => null }));
vi.mock('../src/components/ScheduledTasksPanel', () => ({ ScheduledTasksPanel: () => null }));
vi.mock('../src/lib/api', async (original) => {
  const actual = await original<typeof import('../src/lib/api')>();
  return { ...actual, api: { ...actual.api, codexEnvironments: { ...actual.api.codexEnvironments, list: vi.fn(async()=>({environments:[{id:"native",name:"默认 Codex",kind:"native",enabled:true,allowed_user_ids:null}]})) },
    projects: { ...actual.api.projects, list: vi.fn() },
    sessions: { ...actual.api.sessions, list: vi.fn(), create: vi.fn(), get: vi.fn() },
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
  it('sorts by activity when the project opens and refreshes the order once per minute', async () => {
    const sessions: Session[] = [
      { ...oldSession, id: 'unknown-a', task: 'Unknown A' },
      { ...oldSession, id: 'terminal', task: 'Terminal', cli_type: 'claude', last_activity_at: '2026-10-01T09:00:00Z' },
      { ...oldSession, id: 'unknown-b', task: 'Unknown B' },
      {
        ...oldSession, id: 'native', task: 'Native session',
        agent_runtime: {
          source: 'codex_rollout', session_id: 'native-history', state: 'idle',
          last_activity_at: '2026-10-01T10:00:00Z', observed_at: '2026-10-01T11:00:00Z', reason: 'fixture',
        },
      },
    ];
    const saved = {
      terminalInstances: sessions.map(session => ({ id: session.id, label: session.task, customLabel: session.task })),
      activeTerminalId: 'native',
    };
    vi.mocked(api.sessions.list).mockResolvedValue({ sessions });
    vi.mocked(api.userState.getAll).mockResolvedValue({ state: { 'project:p1': saved } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const view = render(<QueryClientProvider client={client}>
      <ProjectView currentUserId="u1" projectId="p1" projectPath="/workspace/p1" projectName="P1" sessionNavigationExpanded />
    </QueryClientProvider>);
    const expectOrder = (labels: string[]) => {
      const nav = within(screen.getByRole('navigation', { name: '会话标签' }));
      expect(nav.getAllByRole('button', { name: /^(Native session|Terminal|Unknown [AB])$/ }))
        .toEqual(labels.map(name => nav.getByRole('button', { name, exact: true })));
    };
    try {
      await waitFor(() => expectOrder(['Native session', 'Terminal', 'Unknown A', 'Unknown B']));
      const terminalLabel = screen.getByText('Terminal', { exact: true, selector: '.workspace-tab-button span.truncate' });
      const before = terminalLabel.getAttribute('title');
      act(() => useStreamStore.getState().setActivity('terminal', Date.parse('2026-10-01T12:00:00Z')));
      expectOrder(['Native session', 'Terminal', 'Unknown A', 'Unknown B']);
      expect(terminalLabel.getAttribute('title')).not.toBe(before);
      await act(async () => { await vi.advanceTimersByTimeAsync(59_999); });
      expectOrder(['Native session', 'Terminal', 'Unknown A', 'Unknown B']);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expectOrder(['Terminal', 'Native session', 'Unknown A', 'Unknown B']);
      const updated = sessions.map(session => session.agent_runtime ? {
        ...session, agent_runtime: { ...session.agent_runtime, last_activity_at: '2026-10-01T13:00:00Z' },
      } : session);
      vi.mocked(api.sessions.list).mockResolvedValue({ sessions: updated });
      await act(async () => { await client.invalidateQueries({ queryKey: ['project-sessions', 'p1'] }); });
      expectOrder(['Terminal', 'Native session', 'Unknown A', 'Unknown B']);
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expectOrder(['Native session', 'Terminal', 'Unknown A', 'Unknown B']);
      expect(screen.getByRole('button', { name: 'Native session', exact: true })).toHaveAttribute('aria-current', 'true');
    } finally {
      view.unmount();
      client.clear();
      useStreamStore.setState({ activityAt: {} });
      vi.useRealTimers();
    }
  });

  it('uses a newer project snapshot to bind a newly launched session despite a stale global cache',async()=>{
    const pending={...oldSession,id:'fresh',status:'pending' as const,codex_session_id:null};
    vi.mocked(api.sessions.list).mockImplementation(async(_status,projectId)=>({sessions:projectId?[{...pending,status:'running',codex_session_id:'bound-native'}]:[pending]}));
    const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
    client.setQueryData(['sessions'],{sessions:[pending]});
    localStorage.setItem('agentmanager-project-u1-p1',JSON.stringify({terminalInstances:[{id:'fresh',label:'Fresh'}],activeTerminalId:'fresh',explorerInstances:[]}));
    const view=render(<QueryClientProvider client={client}><ProjectView currentUserId="u1" projectId="p1" projectPath="/workspace/p1" projectName="P1"/></QueryClientProvider>);
    try{
      await waitFor(()=>expect(screen.getByTestId('session-pane')).toHaveAttribute('data-native-id','bound-native'));
      expect(client.getQueryData<{sessions:Session[]}>(['sessions'])?.sessions[0].codex_session_id).toBeNull();
    }finally{view.unmount();client.clear();}
  });
  it('opens a freshly created native-pending session from workspace navigation', async () => {
    const current = { ...oldSession, id: 'current', status: 'running' as const };
    const created = { ...oldSession, id: 'created', status: 'pending' as const, codex_session_id: null, native_session_id: null };
    vi.mocked(api.sessions.list).mockResolvedValue({ sessions: [current] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const workspace = (focusSessionId?: string) => <QueryClientProvider client={client}>
      <ProjectView currentUserId="u1" projectId="p1" projectPath="/workspace/p1" projectName="Workspace" focusSessionId={focusSessionId} />
    </QueryClientProvider>;
    const view = render(workspace());
    try {
      expect(await screen.findByText('Live terminal current')).toBeVisible();
      act(() => client.setQueryData(['sessions'], { sessions: [created, current] }));
      view.rerender(workspace(created.id));
      expect(await screen.findByText('Live terminal created')).toBeVisible();
      expect(screen.queryByText('History created')).not.toBeInTheDocument();
      expect(api.sessions.create).not.toHaveBeenCalled();
    } finally { view.unmount(); client.clear(); }
  });
  it.each(['detached','launching'] as const)('keeps an old %s tab omitted from the global window through delayed hydration and refresh',async status=>{
    const jira={...oldSession,id:'jira',status};let hydrate!:(value:{state:Record<string,unknown>})=>void;
    const saved={terminalInstances:[{id:'jira',label:'Jira',customLabel:'Jira'}],activeTerminalId:'jira',hiddenSessionIds:[],explorerInstances:[]};localStorage.setItem('agentmanager-project-u1-p1',JSON.stringify(saved));
    vi.mocked(api.userState.getAll).mockReturnValue(new Promise(resolve=>hydrate=resolve));vi.mocked(api.sessions.list).mockImplementation(async(_status,projectId)=>({sessions:projectId?[jira]:[]}));
    const client=new QueryClient({defaultOptions:{queries:{retry:false}}});const view=render(<QueryClientProvider client={client}><ProjectView currentUserId="u1" projectId="p1" projectPath="/workspace/p1" projectName="P1"/></QueryClientProvider>);
    try{await waitFor(()=>expect(api.sessions.list).toHaveBeenCalledWith(undefined,'p1',expect.any(AbortSignal)));expect(api.userState.set).not.toHaveBeenCalled();await act(async()=>hydrate({state:{'project:p1':saved}}));expect(await screen.findByRole('button',{name:'Jira',exact:true})).toBeVisible();expect(await screen.findByText('Live terminal jira')).toBeVisible();await act(async()=>{await client.invalidateQueries({queryKey:['sessions']});await client.invalidateQueries({queryKey:['project-sessions','p1']});});expect(screen.getByRole('button',{name:'Jira',exact:true})).toBeVisible();expect(JSON.parse(localStorage.getItem('agentmanager-project-u1-p1')!).terminalInstances.map((t:{id:string})=>t.id)).toContain('jira');}finally{view.unmount();client.clear();}
  });
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
  it('ignores the saved Home selection and opens an existing session directly', async () => {
    const current: Session = { ...oldSession, id: 'current', status: 'running' };
    vi.mocked(api.sessions.list).mockResolvedValue({ sessions: [current] });
    localStorage.setItem('agentmanager-project-u1-p1', JSON.stringify({ activeMode: 'terminal', explorerInstances: [], terminalInstances: [{ id: 'current', label: 'Session 1' }], activeTerminalId: 'current', showLauncher: true }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<QueryClientProvider client={client}><ProjectView currentUserId="u1" projectId="p1" projectPath="/workspace/p1" projectName="Workspace" /></QueryClientProvider>);
    try {
      expect(await screen.findByText('Live terminal current')).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Home', exact: true })).not.toBeInTheDocument();
      expect(screen.queryByRole('table', { name: '工作区入口' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '打开网页' })).not.toBeInTheDocument();
      expect(api.sessions.create).not.toHaveBeenCalled();
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
      await waitFor(() => expect(api.sessions.list).toHaveBeenCalledWith(undefined, 'p1', expect.any(AbortSignal)));
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

it('restores a session directly when list enrichment fails, without sending or creating anything',async()=>{
 vi.mocked(api.sessions.list).mockRejectedValue(new Error('History unavailable'));
 vi.mocked(api.sessions.get).mockResolvedValue({session:{...oldSession,status:'running',task:''}});
 const saved={terminalInstances:[{id:oldSession.id,label:'Session 1'}],activeTerminalId:oldSession.id};
 localStorage.setItem('agentmanager-project-u1-p1',JSON.stringify(saved));
 vi.mocked(api.userState.getAll).mockResolvedValue({state:{'project:p1':saved}});
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 const view=render(<QueryClientProvider client={client}><ProjectView currentUserId="u1" projectId="p1" projectPath="/workspace/p1" projectName="P1"/></QueryClientProvider>);
 try{expect(await screen.findByText('Live terminal old-session')).toBeVisible();expect(api.sessions.get).toHaveBeenCalledWith(oldSession.id);expect(api.sessions.create).not.toHaveBeenCalled();}finally{view.unmount();client.clear();}
});

it('refreshes ended session state after a terminal attach failure',async()=>{
 let session:Session={...oldSession,status:'running'};
 vi.mocked(api.sessions.list).mockImplementation(async()=>({sessions:[session]}));
 const saved={terminalInstances:[{id:session.id,label:'Session 1'}],activeTerminalId:session.id};
 localStorage.setItem('agentmanager-project-u1-p1',JSON.stringify(saved));
 vi.mocked(api.userState.getAll).mockResolvedValue({state:{'project:p1':saved}});
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 const view=render(<QueryClientProvider client={client}><ProjectView currentUserId="u1" projectId="p1" projectPath="/workspace/p1" projectName="P1"/></QueryClientProvider>);
 try{await screen.findByText('Live terminal old-session');session={...session,status:'failed'};await userEvent.click(screen.getByText('模拟连接失败'));expect(await screen.findByText('History old-session')).toBeVisible();expect(api.sessions.create).not.toHaveBeenCalled();}finally{view.unmount();client.clear();}
});
