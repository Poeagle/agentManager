import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileExplorer } from '../src/components/FileExplorer';
import { api } from '../src/lib/api';
import { isWithinExplorerRoot } from '../src/lib/explorer-path';

vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return { ...actual, api: { ...actual.api, files: { ...actual.api.files, list: vi.fn(), read: vi.fn() } } };
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.files.list).mockImplementation(async path => ({ path, files: [] }));
  vi.mocked(api.files.read).mockImplementation(async path => ({ path, content: 'hello', extension: 'txt', size: 5 }));
});

describe('project explorer boundaries', () => {
  it('disables parent navigation at the project root', async () => {
    render(<FileExplorer rootPath="/project" projectId="project-1" />);
    await screen.findByText('No files found');
    expect(screen.getByTitle('Parent directory')).toBeDisabled();
    fireEvent.click(screen.getByTitle('Parent directory'));
    expect(api.files.list).toHaveBeenCalledTimes(1);
    expect(api.files.list).toHaveBeenCalledWith('/project', false, 'project-1');
  });

  it.each(['/home', '/project-other', '/project/../home', '../project', '/'])('refuses manual navigation to %s', async path => {
    render(<FileExplorer rootPath="/project" />);
    await screen.findByText('No files found');
    const input = screen.getByDisplayValue('/project');
    fireEvent.change(input, { target: { value: path } });
    fireEvent.submit(input.closest('form')!);
    expect(screen.getByText('只能访问当前项目目录及其子目录')).toBeVisible();
    expect(input).toHaveValue('/project');
    expect(api.files.list).toHaveBeenCalledTimes(1);
  });

  it('allows subdirectories and return to the root', async () => {
    render(<FileExplorer rootPath="/project" />);
    await screen.findByText('No files found');
    const input = screen.getByDisplayValue('/project');
    fireEvent.change(input, { target: { value: '/project/reports/./' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(api.files.list).toHaveBeenCalledWith('/project/reports', false));
    expect(screen.getByTitle('Parent directory')).toBeEnabled();
    fireEvent.click(screen.getByTitle('Parent directory'));
    await waitFor(() => expect(input).toHaveValue('/project'));
    expect(screen.getByTitle('Parent directory')).toBeDisabled();
  });

  it('discards saved paths and file tabs outside the current root', async () => {
    localStorage.setItem('agentmanager-explorer-old', JSON.stringify({
      currentPath: '/home', expandedPaths: ['/home', '/project-other'],
      selectedFile: '/etc/passwd', activeTabPath: '/etc/passwd',
      openTabPaths: [{ path: '/etc/passwd', pinned: true }, { path: '/project/../secret', pinned: true }],
    }));
    render(<FileExplorer rootPath="/project" instanceId="old" projectId="project-1" />);
    await screen.findByText('No files found');
    expect(screen.getByDisplayValue('/project')).toBeVisible();
    expect(api.files.list).toHaveBeenCalledTimes(1);
    expect(api.files.read).not.toHaveBeenCalled();
    await waitFor(() => expect(JSON.parse(localStorage.getItem('agentmanager-explorer-old')!).currentPath).toBe('/project'));
  });

  it('keeps an in-project saved subdirectory', async () => {
    localStorage.setItem('agentmanager-explorer-valid', JSON.stringify({ currentPath: '/project/reports', expandedPaths: [] }));
    render(<FileExplorer rootPath="/project" instanceId="valid" />);
    await screen.findByText('No files found');
    expect(api.files.list).toHaveBeenCalledWith('/project/reports', false);
  });

  it('ignores external file-open requests', async () => {
    render(<FileExplorer rootPath="/project" openFileRequest={{ path: '/etc/passwd', key: 1 }} />);
    await screen.findByText('只能访问当前项目目录及其子目录');
    expect(api.files.read).not.toHaveBeenCalled();
  });

  it('compares normalized path segments instead of a raw prefix', () => {
    expect(isWithinExplorerRoot('/project/a/../b', '/project/')).toBe(true);
    expect(isWithinExplorerRoot('/project2', '/project')).toBe(false);
    expect(isWithinExplorerRoot('/project/../../etc', '/project')).toBe(false);
    expect(isWithinExplorerRoot('/any', '/')).toBe(true);
  });
});
