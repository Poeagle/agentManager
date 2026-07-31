import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectSkillsPanel } from '../src/components/ProjectSkillsPanel';
import { api, type SkillMarketplaceSearchResponse } from '../src/lib/api';

vi.mock('../src/components/FileExplorer', () => ({ FileExplorer: () => <div>File explorer</div> }));

vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return {
    ...actual,
    api: {
      ...actual.api,
      skills: {
        ...actual.api.skills,
        list: vi.fn(),
        marketplaceSearch: vi.fn(),
        marketplaceInstall: vi.fn(),
      },
    },
  };
});

const marketResponse: SkillMarketplaceSearchResponse = {
  query: '',
  providers: [{ id: 'clawhub', label: 'ClawHub', enabled: true, ok: true }],
  installTargets: [
    { id: 'claude-code', label: 'Claude Code', description: '.claude/skills' },
    { id: 'codex', label: 'Codex / 通用 Agents', description: '.agents/skills' },
    { id: 'openclaw', label: 'OpenClaw', description: 'skills' },
  ],
  skills: [{
    id: 'clawhub:react-helper',
    provider: 'clawhub',
    providerLabel: 'ClawHub',
    slug: 'react-helper',
    name: 'React Helper',
    description: 'Helps with React.',
    author: 'acme',
    downloads: 1234,
    installs: 42,
    version: '1.0.0',
    url: 'https://clawhub.ai/acme/skills/react-helper',
    featured: false,
    official: false,
    installed: false,
    installedTargets: [],
  }],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.skills.list).mockResolvedValue({ groups: [] });
  vi.mocked(api.skills.marketplaceSearch).mockResolvedValue(marketResponse);
  vi.mocked(api.skills.marketplaceInstall).mockResolvedValue({
    ok: true,
    tool: 'claude',
    scope: 'project',
    dirName: 'react-helper',
    path: '/project/.claude/skills/react-helper',
    name: 'React Helper',
    description: 'Helps with React.',
    installedTargets: ['claude-code', 'codex', 'openclaw'],
    destinations: [],
  });
});

describe('Project Skills marketplace', () => {
  it('lets the user choose multiple agent targets before installing', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={client}>
        <ProjectSkillsPanel projectId="project-1" />
      </QueryClientProvider>,
    );

    expect(await screen.findByText('React Helper')).toBeInTheDocument();
    const claude = screen.getByRole('checkbox', { name: /Claude Code/ });
    const codex = screen.getByRole('checkbox', { name: /Codex \/ 通用 Agents/ });
    const openclaw = screen.getByRole('checkbox', { name: /OpenClaw/ });
    expect(claude).toHaveAttribute('aria-checked', 'true');
    expect(codex).toHaveAttribute('aria-checked', 'true');
    expect(openclaw).toHaveAttribute('aria-checked', 'false');

    await user.click(openclaw);
    await user.click(screen.getByRole('button', { name: '安装到 3 个目标' }));

    await waitFor(() => expect(api.skills.marketplaceInstall).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({ slug: 'react-helper' }),
      ['claude-code', 'codex', 'openclaw'],
    ));
  });
});
