import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionLauncher } from '../src/components/SessionLauncher';
import { api, type Project, type Session } from '../src/lib/api';

vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return {
    ...actual,
    api: {
      ...actual.api,
      projects: { ...actual.api.projects, projectAgents: vi.fn() },
      git: { ...actual.api.git, status: vi.fn() },
      sessions: { ...actual.api.sessions, list: vi.fn(), create: vi.fn() },
    },
  };
});

const project: Project = {
  id: 'project-1',
  name: 'DolphinDB Manager',
  path: '/workspace/dolphindb-manager',
  description: 'Database operations console',
  session_prompt: null,
  openclaw_prompt: null,
  default_web_url: null,
  skip_permissions: 0,
  color: '#3b82f6',
  created_at: '2026-07-31T00:00:00Z',
  tool_access: {
    can_session: true,
    can_agent: true,
    can_terminal: true,
    can_claude: true,
    can_codex: true,
  },
};

const createdSession = {
  id: 'new-session',
  project_id: project.id,
  task: 'Test task',
  status: 'pending',
  pid: null,
  started_at: null,
  completed_at: null,
  exit_code: null,
  created_at: '2026-07-31T00:00:00Z',
} satisfies Session;

function renderLauncher(onSessionCreated = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <SessionLauncher project={project} onSessionCreated={onSessionCreated} />
    </QueryClientProvider>,
  );
  return { onSessionCreated };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.projects.projectAgents).mockResolvedValue({
    agents: [{ name: 'reviewer', type: 'specialist', description: 'Reviews code', category: 'quality' }],
  });
  vi.mocked(api.git.status).mockResolvedValue({ branch: 'main', ahead: 0, behind: 0, files: [], remoteUrl: null });
  vi.mocked(api.sessions.list).mockResolvedValue({ sessions: [] });
  vi.mocked(api.sessions.create).mockResolvedValue({ ok: true, session: createdSession });
});

describe('SessionLauncher runtime selection', () => {
  it('shows Session and Agents as the top-level workspace choices', async () => {
    renderLauncher();

    expect(screen.getByRole('button', { name: 'Configure Session' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Configure Agents' })).toBeEnabled();
  });

  it('chooses the runtime inside Session and passes Codex to creation', async () => {
    const user = userEvent.setup();
    const { onSessionCreated } = renderLauncher();

    await user.click(screen.getByRole('button', { name: 'Configure Session' }));
    expect(screen.getByRole('heading', { name: 'Configure Session' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Claude Code, Anthropic CLI' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Codex, OpenAI CLI' }));

    await user.type(screen.getByPlaceholderText(/Describe what you want Codex/), 'Investigate query latency');
    await user.click(screen.getByRole('button', { name: 'Launch Codex Session' }));

    await waitFor(() => expect(api.sessions.create).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'session',
      cli_type: 'codex',
      task: 'Investigate query latency',
    })));
    await waitFor(() => expect(onSessionCreated).toHaveBeenCalledWith('new-session', undefined, 'session'));
  });

  it('lets an Agent use Codex and sends both choices to session creation', async () => {
    const user = userEvent.setup();
    renderLauncher();

    await user.click(screen.getByRole('button', { name: 'Configure Agents' }));
    expect(screen.getByRole('heading', { name: 'Configure Agent' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Agent type' })).toHaveValue('reviewer');
    await user.click(screen.getByRole('button', { name: 'Codex, OpenAI CLI' }));
    await user.click(screen.getByRole('button', { name: 'Launch Codex Agent' }));

    await waitFor(() => expect(api.sessions.create).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'agent',
      agent_type: 'reviewer',
      cli_type: 'codex',
    })));
  });
});
