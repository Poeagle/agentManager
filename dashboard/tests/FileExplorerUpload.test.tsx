import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileExplorer } from '../src/components/FileExplorer';
import { api } from '../src/lib/api';
import { MAX_FILE_UPLOAD_BYTES } from '../src/lib/file-upload';

vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return { ...actual, api: { ...actual.api, files: { ...actual.api.files, list: vi.fn(), upload: vi.fn() } } };
});

function transfer(files: File[]) {
  return { types: ['Files'], files, items: [], dropEffect: 'none' };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.files.list).mockImplementation(async path => ({
    path,
    files: path === '/project' ? [
      { name: 'reports', type: 'directory', size: 0, extension: '' },
      { name: 'notes.txt', type: 'file', size: 5, extension: 'txt' },
    ] : [],
  }));
  vi.mocked(api.files.upload).mockResolvedValue({ ok: true, path: '/project/new.txt', size: 3 });
});

describe('FileExplorer drag-and-drop upload', () => {
  it('uploads multiple dropped files to the current directory and refreshes the list', async () => {
    render(<FileExplorer rootPath="/project" />);
    await screen.findByText('notes.txt');
    const files = [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')];
    fireEvent.drop(screen.getByLabelText('文件上传区域'), { dataTransfer: transfer(files) });
    await screen.findByText('已上传 2/2 个文件到 /project');
    expect(api.files.upload).toHaveBeenNthCalledWith(1, '/project', files[0], expect.any(Function));
    expect(api.files.upload).toHaveBeenNthCalledWith(2, '/project', files[1], expect.any(Function));
    expect(api.files.list).toHaveBeenCalledTimes(2);
  });

  it('uploads into a dropped-on folder, expands it, and shows uploaded files', async () => {
    render(<FileExplorer rootPath="/project" />);
    const folder = await screen.findByText('reports');
    const file = new File(['a'], 'new.txt');
    vi.mocked(api.files.list).mockResolvedValue({ path: '/project/reports', files: [{ name: file.name, type: 'file', size: 1, extension: 'txt' }] });
    fireEvent.dragOver(folder, { dataTransfer: transfer([file]) });
    expect(screen.getByText('松开上传到：/project/reports')).toBeVisible();
    fireEvent.drop(folder, { dataTransfer: transfer([file]) });
    expect(await screen.findByText('new.txt')).toBeVisible();
    expect(api.files.upload).toHaveBeenCalledWith('/project/reports', file, expect.any(Function));
  });

  it('drops onto a file into its containing directory, never overwriting that row', async () => {
    render(<FileExplorer rootPath="/project" />);
    const row = await screen.findByText('notes.txt');
    const file = new File(['a'], 'new.txt');
    fireEvent.drop(row, { dataTransfer: transfer([file]) });
    await screen.findByText('已上传 1/1 个文件到 /project');
    expect(api.files.upload).toHaveBeenCalledWith('/project', file, expect.any(Function));
  });

  it('shows progress until the server finishes and prevents a duplicate in-flight upload', async () => {
    let finish!: (result: { ok: boolean; path: string; size: number }) => void;
    vi.mocked(api.files.upload).mockImplementation((_path, _file, progress) => {
      progress?.(0.5);
      return new Promise(resolve => { finish = resolve; });
    });
    render(<FileExplorer rootPath="/project" />);
    await screen.findByText('notes.txt');
    const zone = screen.getByLabelText('文件上传区域');
    const dataTransfer = transfer([new File(['a'], 'new.txt')]);
    fireEvent.drop(zone, { dataTransfer });
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '50');
    fireEvent.drop(zone, { dataTransfer });
    expect(api.files.upload).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ ok: true, path: '/project/new.txt', size: 1 }); });
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('reports name conflicts but continues uploading other files', async () => {
    vi.mocked(api.files.upload).mockRejectedValueOnce(new Error('同名文件已存在，未覆盖'));
    render(<FileExplorer rootPath="/project" />);
    await screen.findByText('notes.txt');
    fireEvent.drop(screen.getByLabelText('文件上传区域'), {
      dataTransfer: transfer([new File(['a'], 'notes.txt'), new File(['b'], 'new.txt')]),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('已上传 1/2 个文件到 /project；notes.txt：同名文件已存在，未覆盖');
    expect(api.files.upload).toHaveBeenCalledTimes(2);
  });

  it('blocks writes in read-only explorers', async () => {
    render(<FileExplorer rootPath="/project" readOnly />);
    await screen.findByText('notes.txt');
    fireEvent.drop(screen.getByLabelText('文件上传区域'), { dataTransfer: transfer([new File(['a'], 'new.txt')]) });
    expect(await screen.findByRole('alert')).toHaveTextContent('只读');
    expect(api.files.upload).not.toHaveBeenCalled();
  });

  it('rejects folders and oversized files with clear feedback', async () => {
    render(<FileExplorer rootPath="/project" />);
    await screen.findByText('notes.txt');
    const zone = screen.getByLabelText('文件上传区域');
    fireEvent.drop(zone, { dataTransfer: { ...transfer([]), items: [{ webkitGetAsEntry: () => ({ isDirectory: true }) }] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('暂不支持拖入文件夹');
    const largeFile = new File(['x'], 'large.bin');
    Object.defineProperty(largeFile, 'size', { value: MAX_FILE_UPLOAD_BYTES + 1 });
    fireEvent.drop(zone, { dataTransfer: transfer([largeFile]) });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('50 MB'));
    expect(api.files.upload).not.toHaveBeenCalled();
  });

  it('handles sidebar requests once and uses the persisted active explorer directory', async () => {
    localStorage.setItem('agentmanager-explorer-test', JSON.stringify({ currentPath: '/project/reports', expandedPaths: [] }));
    const request = { files: [new File(['a'], 'new.txt')], containsDirectories: false, key: 1 };
    const { rerender } = render(<StrictMode><FileExplorer rootPath="/project" instanceId="test" uploadRequest={request} /></StrictMode>);
    await screen.findByText('已上传 1/1 个文件到 /project/reports');
    rerender(<StrictMode><FileExplorer rootPath="/project" instanceId="test" uploadRequest={request} /></StrictMode>);
    expect(api.files.upload).toHaveBeenCalledTimes(1);
    expect(api.files.upload).toHaveBeenCalledWith('/project/reports', request.files[0], expect.any(Function));
  });

  it('does not replace a newly navigated directory with an old upload result', async () => {
    let finish!: (result: { ok: boolean; path: string; size: number }) => void;
    vi.mocked(api.files.upload).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render(<FileExplorer rootPath="/project" />);
    await screen.findByText('notes.txt');
    fireEvent.drop(screen.getByLabelText('文件上传区域'), { dataTransfer: transfer([new File(['a'], 'new.txt')]) });
    const input = screen.getByDisplayValue('/project');
    fireEvent.change(input, { target: { value: '/project/reports' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(api.files.list).toHaveBeenCalledWith('/project/reports', false));
    await act(async () => { finish({ ok: true, path: '/project/new.txt', size: 1 }); });
    expect(screen.getByDisplayValue('/project/reports')).toBeVisible();
    expect(api.files.list).toHaveBeenCalledTimes(2);
  });
});
