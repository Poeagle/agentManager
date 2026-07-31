import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportBlobToLocalFolder, localExportFileName } from '../src/lib/file-export';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('local file export', () => {
  it('names directory exports as ZIP archives', () => {
    expect(localExportFileName('reports', true)).toBe('reports.zip');
    expect(localExportFileName('report.csv', false)).toBe('report.csv');
  });

  it('opens the save picker before loading data and writes the chosen file', async () => {
    const order: string[] = [];
    const write = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    const showSaveFilePicker = vi.fn(async () => {
      order.push('picker');
      return {
        name: 'renamed-report.txt',
        createWritable: async () => ({ write, close }),
      };
    });
    const loadBlob = vi.fn(async () => {
      order.push('load');
      return new Blob(['hello']);
    });

    const result = await exportBlobToLocalFolder(
      loadBlob,
      'report.txt',
      {
        browserWindow: { showSaveFilePicker } as unknown as Window & { showSaveFilePicker: typeof showSaveFilePicker },
      },
    );

    expect(order).toEqual(['picker', 'load']);
    expect(showSaveFilePicker).toHaveBeenCalledWith({ suggestedName: 'report.txt' });
    expect(result).toEqual({ kind: 'saved', fileName: 'renamed-report.txt' });
    expect(write).toHaveBeenCalledWith(expect.any(Blob));
    expect(close).toHaveBeenCalled();
  });

  it('streams a response into the selected file and reports transferred bytes', async () => {
    const write = vi.fn(async (data: Blob | BufferSource | string) => { void data; });
    const close = vi.fn(async () => {});
    const showSaveFilePicker = vi.fn(async () => ({
      name: 'server.zip',
      createWritable: async () => ({ write, close }),
    }));
    const onProgress = vi.fn();
    const response = new Response(new TextEncoder().encode('hello'), {
      headers: { 'Content-Length': '5', 'Content-Type': 'application/zip' },
    });

    await expect(exportBlobToLocalFolder(
      async () => response,
      'server.zip',
      {
        browserWindow: { showSaveFilePicker } as unknown as Window & { showSaveFilePicker: typeof showSaveFilePicker },
        onProgress,
      },
    )).resolves.toEqual({ kind: 'saved', fileName: 'server.zip' });

    const writtenChunk = write.mock.calls[0][0];
    expect(ArrayBuffer.isView(writtenChunk)).toBe(true);
    if (ArrayBuffer.isView(writtenChunk)) expect(writtenChunk.byteLength).toBe(5);
    expect(close).toHaveBeenCalledOnce();
    expect(onProgress).toHaveBeenLastCalledWith({ loaded: 5, total: 5, totalIsEstimate: false });
  });

  it('uses the server archive-size estimate when a streamed ZIP has no content length', async () => {
    const write = vi.fn(async (data: Blob | BufferSource | string) => { void data; });
    const close = vi.fn(async () => {});
    const showSaveFilePicker = vi.fn(async () => ({
      name: 'project.zip',
      createWritable: async () => ({ write, close }),
    }));
    const onProgress = vi.fn();
    const response = new Response(new TextEncoder().encode('zip'), {
      headers: { 'X-Export-Estimated-Size': '1200' },
    });

    await exportBlobToLocalFolder(
      async () => response,
      'project.zip',
      {
        browserWindow: { showSaveFilePicker } as unknown as Window & { showSaveFilePicker: typeof showSaveFilePicker },
        onProgress,
      },
    );

    expect(onProgress).toHaveBeenLastCalledWith({ loaded: 3, total: 1200, totalIsEstimate: true });
  });

  it('does not fetch the export when saving is cancelled', async () => {
    const loadBlob = vi.fn(async () => new Blob(['unused']));
    const showSaveFilePicker = vi.fn(async () => {
      throw new DOMException('cancelled', 'AbortError');
    });

    await expect(exportBlobToLocalFolder(
      loadBlob,
      'folder.zip',
      {
        browserWindow: { showSaveFilePicker } as unknown as Window & { showSaveFilePicker: typeof showSaveFilePicker },
      },
    )).resolves.toEqual({ kind: 'cancelled', fileName: 'folder.zip' });
    expect(loadBlob).not.toHaveBeenCalled();
  });

  it('uses a normal download instead of requesting access to an entire directory', async () => {
    const createObjectURL = vi.fn(() => 'blob:export-test');
    const revokeObjectURL = vi.fn();
    const showDirectoryPicker = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    await expect(exportBlobToLocalFolder(
      async () => new Blob(['download']),
      'reports.zip',
      { browserWindow: { showDirectoryPicker } as unknown as Window },
    )).resolves.toEqual({ kind: 'download', fileName: 'reports.zip' });

    expect(showDirectoryPicker).not.toHaveBeenCalled();
    expect(createObjectURL).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
  });
});
