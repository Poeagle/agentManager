import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectSessionCreateDialog } from '../src/components/ProjectSessionCreateDialog';
import { api, type Project, type Session } from '../src/lib/api';
import { builtinAgentDescriptors } from '../src/lib/agents';

vi.mock('../src/lib/api', async (original) => {
  const actual = await original<typeof import('../src/lib/api')>();
  return { ...actual, api: { ...actual.api, codexEnvironments: { ...actual.api.codexEnvironments, list: vi.fn(async()=>({environments:[{id:"native",name:"默认 Codex",kind:"native",enabled:true,allowed_user_ids:null}]})) }, sessions: { ...actual.api.sessions, create: vi.fn() } } };
});
const project: Project = {
  id: 'p1', name: 'DolphinDB Manager', path: '/workspace/dolphindb-manager', description: null,
  session_prompt: 'Follow project rules', openclaw_prompt: null, color: '', created_at: '2026-10-14T00:00:00Z',
  tool_access: { can_session: true, can_terminal: true, session_clients: ['codex'] },
};
const created: Session = { id: 'new-session', project_id: 'p1', task: 'Test task', status: 'pending', pid: null, started_at: null, completed_at: null, exit_code: null, created_at: '2026-10-14T00:00:00Z' };
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.sessions.create).mockResolvedValue({ ok: true, session: created }); });
function mount(selectSession?: (client: QueryClient) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onClose = vi.fn(), onSessionCreated = vi.fn(() => selectSession?.(client));
  const view = render(<QueryClientProvider client={client}><ProjectSessionCreateDialog project={project} onClose={onClose} onSessionCreated={onSessionCreated} /></QueryClientProvider>);
  return { client, onClose, onSessionCreated, dispose: () => { view.unmount(); client.clear(); } };
}
describe('shared project creation dialog', () => {
  it('shows authorized choices directly and cancels without creating a session', async () => {
    const user = userEvent.setup(), mounted = mount();
    try {
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
      expect(screen.queryByRole('option', { name: 'Claude' })).not.toBeInTheDocument();
      const mode = screen.getByRole('combobox', { name: '选择打开方式' });
      expect(mode).toHaveValue('codex');
      expect(mode).toHaveFocus();
      expect(screen.queryAllByRole('radio')).toHaveLength(0);
      await user.click(screen.getByRole('button', { name: '取消' }));
      expect(mounted.onClose).toHaveBeenCalled(); expect(api.sessions.create).not.toHaveBeenCalled();
    } finally { mounted.dispose(); }
  });
  it('opens without sending project instructions or a greeting and adds the returned session to the shared cache', async () => {
    const user = userEvent.setup(), mounted = mount();
    try {
      const submit=screen.getByRole('button',{name:'新建会话'});await waitFor(()=>expect(submit).toBeEnabled());await user.click(submit);
      await waitFor(() => expect(mounted.onSessionCreated).toHaveBeenCalledWith(created));
      expect(api.sessions.create).toHaveBeenCalledWith({project_id:'p1',project_path:project.path,mode:'session',cli_type:'codex',environment_id:'native'});
      expect(mounted.client.getQueryData(['sessions'])).toEqual({ sessions: [created] });
      expect(mounted.client.getQueryData(['project-sessions', project.id])).toEqual({ sessions: [created] });
    } finally { mounted.dispose(); }
  });
  it('refreshes the authoritative lists after the workspace selects the new tab', async () => {
    const keys = [['sessions'], ['project-sessions', project.id]];
    const mounted = mount(client => {
      for (const queryKey of keys) expect(client.getQueryData(queryKey)).toEqual({ sessions: [created] });
    });
    const running = { ...created, status: 'running' as const };
    const subscriptions = keys.map(queryKey => {
      mounted.client.setQueryData(queryKey, { sessions: [] });
      return new QueryObserver(mounted.client, {
        queryKey, queryFn: async () => ({ sessions: [running] }), staleTime: Infinity,
      }).subscribe(() => {});
    });
    try {
      const submit = screen.getByRole('button', { name: '新建会话' });
      await waitFor(() => expect(submit).toBeEnabled());
      fireEvent.click(submit);
      await waitFor(() => {
        for (const queryKey of keys) expect(mounted.client.getQueryData(queryKey)).toEqual({ sessions: [running] });
      });
    } finally {
      for (const unsubscribe of subscriptions) unsubscribe();
      mounted.dispose();
    }
  });
  it('creates Terminal without a client or task flag', async () => {
    const user = userEvent.setup(), mounted = mount();
    try {
      await user.selectOptions(screen.getByRole('combobox', { name: '选择打开方式' }), 'terminal');
      const submit=screen.getByRole('button',{name:'新建会话'});await waitFor(()=>expect(submit).toBeEnabled());await user.click(submit);
      await waitFor(() => expect(api.sessions.create).toHaveBeenCalledWith({ project_id: 'p1', project_path: project.path, mode: 'terminal' }));
    } finally { mounted.dispose(); }
  });
  it('waits for the Claude Provider after switching from Codex and submits its identity', async () => {
    const supported = builtinAgentDescriptors();
    const p: Project = {
      ...project,
      agent_catalog: ['codex', 'claude'].map(id => supported.find(agent => agent.id === id)!),
      tool_access: { can_session: true, can_terminal: false, session_clients: ['codex', 'claude'] },
    };
    let resolveClaude!: (value: Awaited<ReturnType<typeof api.claudeEnvironments.list>>) => void;
    vi.spyOn(api.claudeEnvironments,'list').mockImplementationOnce(() => new Promise(resolve => { resolveClaude = resolve; }));
    const client = new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
    const view=render(<QueryClientProvider client={client}><ProjectSessionCreateDialog project={p} onClose={vi.fn()} onSessionCreated={vi.fn()}/></QueryClientProvider>);
    try {
      const submit = screen.getByRole('button', { name: '新建会话' });
      await waitFor(() => expect(submit).toBeEnabled());
      fireEvent.change(screen.getByRole('combobox', { name: '选择打开方式' }), { target: { value: 'claude' } });
      expect(submit).toBeDisabled();
      fireEvent.click(submit);
      expect(api.sessions.create).not.toHaveBeenCalled();
      resolveClaude({
        current: 'claude-provider:anthropic',
        environments: [{ id: 'claude-provider:anthropic', name: 'Anthropic', kind: 'native', enabled: true, allowed_user_ids: null }],
      });
      await waitFor(()=>expect(screen.getByRole('combobox',{name:'新会话 Claude Provider'})).toHaveValue('claude-provider:anthropic'));
      await waitFor(()=>expect(screen.getByRole('button',{name:'新建会话'})).toBeEnabled());
      fireEvent.click(screen.getByRole('button',{name:'新建会话'}));
      await waitFor(()=>expect(api.sessions.create).toHaveBeenCalledWith(expect.objectContaining({cli_type:'claude',environment_id:'claude-provider:anthropic',client_id:expect.stringMatching(/^[a-f0-9]{32}$/)})));
    } finally {view.unmount();client.clear();}
  });
});
