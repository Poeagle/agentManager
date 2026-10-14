import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileExplorer } from '../src/components/FileExplorer';
import { api } from '../src/lib/api';

vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return {
    ...actual,
    api: {
      ...actual.api,
      files: { ...actual.api.files, list: vi.fn(), read: vi.fn(), preview: vi.fn() },
    },
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('URL', Object.assign(URL, {
    createObjectURL: vi.fn(() => 'blob:diagram'),
    revokeObjectURL: vi.fn(),
  }));
  vi.mocked(api.files.list).mockResolvedValue({
    path: '/project',
    files: [{ name: 'README.md', type: 'file', size: 100, extension: 'md' }],
  });
  vi.mocked(api.files.read).mockImplementation(async (path) => ({
    path,
    content: path.endsWith('README.md')
      ? '## 先看整体流程\n\n[diagram](backupRestore.png)\n\n![backupRestore](./backupRestore.png)\n\n1. `initParamsEnv`\n   作用：检查环境\n\n2. `initFunctionEnv`\n   作用：初始化函数'
      : '',
    extension: path.endsWith('.md') ? 'md' : 'png',
    size: 100,
    previewType: path.endsWith('.md') ? 'text' : 'image',
  }));
  vi.mocked(api.files.preview).mockResolvedValue(new Blob(['image'], { type: 'image/png' }));
});

describe('Markdown file preview', () => {
  it('loads a relative image through the scoped file preview API', async () => {
    render(<FileExplorer rootPath="/project" projectId="project-1" />);
    fireEvent.click(await screen.findByText('README.md'));

    const image = await screen.findByRole('img', { name: 'backupRestore' });
    await waitFor(() => expect(image).toHaveAttribute('src', 'blob:diagram'));
    expect(api.files.preview).toHaveBeenCalledWith('/project/backupRestore.png', expect.any(AbortSignal), 'project-1');
  });

  it('opens relative file links with Ctrl-click while editing', async () => {
    render(<FileExplorer rootPath="/project" projectId="project-1" />);
    fireEvent.click(await screen.findByText('README.md'));
    fireEvent.click(await screen.findByRole('link', { name: 'diagram' }), { ctrlKey: true });

    await waitFor(() => expect(api.files.read).toHaveBeenCalledWith('/project/backupRestore.png', 'project-1'));
  });

});
