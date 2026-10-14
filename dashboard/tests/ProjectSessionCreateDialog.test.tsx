import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectSessionCreateDialog } from '../src/components/ProjectSessionCreateDialog';
import { api, type Project, type Session } from '../src/lib/api';

vi.mock('../src/lib/api', async (original) => {
  const actual = await original<typeof import('../src/lib/api')>();
  return { ...actual, api: { ...actual.api, sessions: { ...actual.api.sessions, create: vi.fn() } } };
});
const project: Project = {
  id: 'p1', name: 'DolphinDB Manager', path: '/workspace/dolphindb-manager', description: null,
  session_prompt: 'Follow project rules', openclaw_prompt: null, color: '', created_at: '2026-10-14T00:00:00Z',
  tool_access: { can_session: true, can_terminal: true, session_clients: ['codex'] },
};
const created: Session = { id: 'new-session', project_id: 'p1', task: 'Test task', status: 'pending', pid: null, started_at: null, completed_at: null, exit_code: null, created_at: '2026-10-14T00:00:00Z' };
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.sessions.create).mockResolvedValue({ ok: true, session: created }); });
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onClose = vi.fn(), onSessionCreated = vi.fn();
  const view = render(<QueryClientProvider client={client}><ProjectSessionCreateDialog project={project} onClose={onClose} onSessionCreated={onSessionCreated} /></QueryClientProvider>);
  return { client, onClose, onSessionCreated, dispose: () => { view.unmount(); client.clear(); } };
}
describe('shared project creation dialog', () => {
  it('shows authorized choices directly and cancels without creating a session', async () => {
    const user = userEvent.setup(), mounted = mount();
    try {
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
      expect(screen.queryByRole('radio', { name: 'Claude' })).not.toBeInTheDocument();
      expect(screen.getByRole('radio', { name: 'Codex' })).toBeChecked();
      await user.click(screen.getByRole('button', { name: '取消' }));
      expect(mounted.onClose).toHaveBeenCalled(); expect(api.sessions.create).not.toHaveBeenCalled();
    } finally { mounted.dispose(); }
  });
  it('preserves project instructions and adds the returned session to the shared cache', async () => {
    const user = userEvent.setup(), mounted = mount();
    try {
      await user.click(screen.getByRole('button', { name: '新建会话' }));
      await waitFor(() => expect(mounted.onSessionCreated).toHaveBeenCalledWith(created));
      expect(api.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ project_id: 'p1', mode: 'session', cli_type: 'codex', task: expect.stringContaining('Follow project rules') }));
      expect(mounted.client.getQueryData(['sessions'])).toEqual({ sessions: [created] });
    } finally { mounted.dispose(); }
  });
  it('creates Terminal without a client or task flag', async () => {
    const user = userEvent.setup(), mounted = mount();
    try {
      await user.click(screen.getByRole('radio', { name: 'Terminal' }));
      await user.click(screen.getByRole('button', { name: '新建会话' }));
      await waitFor(() => expect(api.sessions.create).toHaveBeenCalledWith({ project_id: 'p1', project_path: project.path, mode: 'terminal' }));
    } finally { mounted.dispose(); }
  });
});
