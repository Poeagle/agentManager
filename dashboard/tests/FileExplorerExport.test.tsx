import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileExplorer } from '../src/components/FileExplorer';
import { api } from '../src/lib/api';
import { startExportTransfer } from '../src/lib/export-transfer';

vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return {
    ...actual,
    api: {
      ...actual.api,
      files: { ...actual.api.files, list: vi.fn(), export: vi.fn() },
    },
  };
});

vi.mock('../src/lib/export-transfer', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/export-transfer')>('../src/lib/export-transfer');
  return {
    ...actual,
    startExportTransfer: vi.fn(),
    useExportTransferStore: vi.fn((selector) => selector({ task: null })),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.files.list).mockResolvedValue({
    path: '/project',
    files: [
      { name: 'notes.txt', type: 'file', size: 12, extension: 'txt' },
      { name: 'reports', type: 'directory', size: 0, extension: '' },
    ],
  });
  vi.mocked(startExportTransfer).mockResolvedValue(true);
});

describe('FileExplorer export menu', () => {
  it('exports a right-clicked file without requiring write access', async () => {
    const user = userEvent.setup();
    render(<FileExplorer rootPath="/project" readOnly />);

    const file = await screen.findByText('notes.txt');
    fireEvent.contextMenu(file);
    const exportAction = screen.getByRole('button', { name: 'Export to local folder…' });
    expect(exportAction).toBeEnabled();
    await user.click(exportAction);

    await waitFor(() => expect(startExportTransfer).toHaveBeenCalledWith({
      path: '/project/notes.txt',
      name: 'notes.txt',
      isDirectory: false,
    }));
  });

  it('uses a ZIP filename for a directory export', async () => {
    const user = userEvent.setup();
    render(<FileExplorer rootPath="/project" />);

    const folder = await screen.findByText('reports');
    fireEvent.contextMenu(folder);
    await user.click(screen.getByRole('button', { name: 'Export to local folder…' }));

    await waitFor(() => expect(startExportTransfer).toHaveBeenCalledWith({
      path: '/project/reports',
      name: 'reports',
      isDirectory: true,
    }));
  });
});
