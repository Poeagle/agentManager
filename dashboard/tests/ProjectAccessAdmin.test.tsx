import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectAccessAdmin } from '../src/components/AccountModal';
import { api, type ProjectToolPermissions, type ProjectUserAccess } from '../src/lib/api';

vi.mock('../src/lib/api', () => ({ api: {
  projects: { list: vi.fn(), access: vi.fn(), setAccess: vi.fn(), removeAccess: vi.fn() },
  users: { list: vi.fn() },
} }));

const clients = [{ id: 'claude', label: 'Claude' }, { id: 'codex', label: 'Codex' }];
let grants: ProjectUserAccess[];
beforeEach(() => {
  vi.clearAllMocks(); grants = [];
  vi.mocked(api.projects.list).mockResolvedValue({ projects: [{ id: 'project-1', name: 'Project', path: '/workspace', description: null, session_prompt: null, openclaw_prompt: null, color: '', created_at: '' }] });
  vi.mocked(api.users.list).mockResolvedValue({ users: [{ id: 'member-1', username: 'member', display_name: 'Member', role: 'member' }] });
  vi.mocked(api.projects.access).mockImplementation(async () => ({ access: grants, clients }));
  vi.mocked(api.projects.setAccess).mockImplementation(async (_projectId, userId, access: ProjectToolPermissions) => {
    const row: ProjectUserAccess = { ...access, user_id: userId, username: 'member', display_name: 'Member', role: 'member' };
    grants = [row]; return { ok: true, access: row };
  });
  vi.mocked(api.projects.removeAccess).mockResolvedValue({ ok: true });
});

describe('project authorization with Session clients and Terminal', () => {
  it('offers only two tool columns, multi-selects clients, and saves Terminal independently', async () => {
    const user = userEvent.setup(); render(<ProjectAccessAdmin />);
    const table = await screen.findByRole('table', { name: '项目授权' });
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['用户', 'Session', 'Terminal', '操作']);
    await user.click(screen.getByRole('button', { name: '配置 member 的 Session 客户端' }));
    await user.click(screen.getByRole('checkbox', { name: 'Claude' }));
    await user.click(screen.getByRole('checkbox', { name: 'Codex' }));
    await user.click(screen.getByRole('checkbox', { name: '允许 member 使用 Terminal' }));
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(api.projects.setAccess).toHaveBeenCalledWith('project-1', 'member-1', { can_session: true, can_terminal: true, session_clients: ['claude', 'codex'] }));
    expect(await screen.findByRole('button', { name: '配置 member 的 Session 客户端' })).toHaveTextContent('Claude、Codex');
  });

  it('removes Session access when the last selected client is cleared without revoking Terminal', async () => {
    grants = [{ user_id: 'member-1', username: 'member', display_name: 'Member', role: 'member', can_session: true, can_terminal: true, session_clients: ['codex'] }];
    const user = userEvent.setup(); render(<ProjectAccessAdmin />);
    await user.click(await screen.findByRole('button', { name: '配置 member 的 Session 客户端' }));
    await user.click(screen.getByRole('checkbox', { name: 'Codex' }));
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(api.projects.setAccess).toHaveBeenCalledWith('project-1', 'member-1', { can_session: false, can_terminal: true, session_clients: [] }));
    expect(api.projects.removeAccess).not.toHaveBeenCalled();
  });

  it('renders additional clients from the server catalog without additional tool columns', async () => {
    vi.mocked(api.projects.access).mockResolvedValue({ access: [], clients: [...clients, { id: 'future-client', label: 'Future client' }] });
    const user = userEvent.setup(); render(<ProjectAccessAdmin />);
    await user.click(await screen.findByRole('button', { name: '配置 member 的 Session 客户端' }));
    expect(screen.getByRole('checkbox', { name: 'Future client' })).toBeEnabled();
    expect(screen.queryByRole('columnheader', { name: 'Future client' })).not.toBeInTheDocument();
  });
});
