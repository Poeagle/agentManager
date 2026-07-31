import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExportTransferOverlay } from '../src/components/ExportTransferOverlay';
import {
  startExportTransfer,
  useExportTransferStore,
} from '../src/lib/export-transfer';
import { exportBlobToLocalFolder } from '../src/lib/file-export';

vi.mock('../src/lib/file-export', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/file-export')>('../src/lib/file-export');
  return { ...actual, exportBlobToLocalFolder: vi.fn() };
});

beforeEach(() => {
  useExportTransferStore.setState({ task: null });
});

afterEach(() => {
  useExportTransferStore.setState({ task: null });
});

describe('global export transfer overlay', () => {
  it('stays in the global overlay, reports progress, and cancels the active request', async () => {
    vi.mocked(exportBlobToLocalFolder).mockImplementation(async (_load, _name, options) => {
      options.onProgress?.({ loaded: 4 * 1024, total: 16 * 1024 });
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
      });
    });

    render(<ExportTransferOverlay />);
    const transfer = startExportTransfer({
      path: '/project/reports',
      name: 'reports',
      isDirectory: true,
    });

    expect(await screen.findByText('正在传输')).toBeInTheDocument();
    expect(screen.getByText('切换项目或 Session 不会中断此任务。')).toBeInTheDocument();
    expect(screen.getByText('4.0 KB / 16.0 KB')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '取消传输' }));
    await transfer;

    await waitFor(() => expect(screen.getByText('已取消导出')).toBeInTheDocument());
    expect(useExportTransferStore.getState().task?.phase).toBe('cancelled');
  });

  it('shows speed and an estimated remaining time for an active transfer', () => {
    useExportTransferStore.setState({
      task: {
        id: 'transfer-1',
        sourcePath: '/project/server',
        fileName: 'server.zip',
        isDirectory: true,
        phase: 'transferring',
        loaded: 8 * 1024 * 1024,
        total: 24 * 1024 * 1024,
        totalIsEstimate: true,
        speedBytesPerSecond: 4 * 1024 * 1024,
        etaSeconds: 4,
        startedAt: Date.now(),
      },
    });

    render(<ExportTransferOverlay />);

    expect(screen.getByText('4.0 MB/s')).toBeInTheDocument();
    expect(screen.getByText('约 4 秒')).toBeInTheDocument();
    expect(screen.getByText('8.0 MB / ≈24.0 MB')).toBeInTheDocument();
  });
});
