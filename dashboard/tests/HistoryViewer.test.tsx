import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HistoryViewer } from '../src/components/HistoryViewer';
import { api } from '../src/lib/api';

const terminal = vi.hoisted(() => ({ write: vi.fn(), dispose: vi.fn(), fit: vi.fn() }));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 120;
    rows = 40;
    loadAddon() {}
    open() {}
    write = terminal.write;
    scrollToBottom() {}
    dispose = terminal.dispose;
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit = terminal.fit; } }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { onContextLoss() {} } }));
vi.mock('../src/lib/api', () => ({ api: { sessions: { renderedOutput: vi.fn() } } }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.sessions.renderedOutput).mockResolvedValue({ rendered: 'Previous conversation' });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0; });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('HistoryViewer resume controls', () => {
  it('keeps one centered action group and disables resume and close while restoring an empty screen', async () => {
    vi.useFakeTimers();
    vi.mocked(api.sessions.renderedOutput).mockResolvedValue({ rendered: '' });
    const onResume = vi.fn();
    const onClose = vi.fn();
    render(<HistoryViewer sessionId="session-1" onClose={onClose} ended onResume={onResume} resuming />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(2);
    expect(screen.getByRole('group', { name: '会话操作' }).parentElement).toHaveClass('inset-0', 'items-center', 'justify-center');
    for (const button of buttons) {
      expect(button).toBeDisabled();
      button.click();
    }
    expect(screen.getByRole('button', { name: '正在恢复…' })).toHaveAttribute('aria-busy', 'true');
    expect(onResume).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('offers a usable retry button after a failed resume', async () => {
    const onResume = vi.fn();
    render(<HistoryViewer sessionId="session-1" onClose={vi.fn()} ended onResume={onResume} resumeFailed />);
    const button = screen.getByRole('button', { name: '重试恢复会话' });
    expect(button).toBeEnabled();
    await userEvent.setup().click(button);
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('awaits resource cleanup, prevents duplicate closes, and offers a retry if closing fails', async () => {
    let reject!: (error: Error) => void;
    const onClose = vi.fn().mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail; }))
      .mockResolvedValueOnce(undefined);
    const onResume = vi.fn();
    render(<HistoryViewer sessionId="session-1" onClose={onClose} ended onResume={onResume} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '关闭会话' }));
    const closing = screen.getByRole('button', { name: '正在关闭…' });
    expect(closing).toBeDisabled();
    expect(screen.getByRole('button', { name: '恢复会话' })).toBeDisabled();
    await user.click(closing);
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => reject(new Error('Cleanup failed')));
    expect(screen.getByRole('alert')).toHaveTextContent('Cleanup failed');
    await user.click(screen.getByRole('button', { name: '关闭会话' }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('provides a close action even when the session cannot resume', async () => {
    const onClose = vi.fn();
    render(<HistoryViewer sessionId="session-1" onClose={onClose} ended />);
    expect(screen.getByRole('button', { name: '恢复会话' })).toBeDisabled();
    await userEvent.setup().click(screen.getByRole('button', { name: '关闭会话' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps the live-terminal history close control', async () => {
    render(<HistoryViewer sessionId="session-1" onClose={vi.fn()} />);
    expect(screen.getByTitle('Close History (back to live terminal)')).toBeEnabled();
    expect(screen.queryByRole('group', { name: '会话操作' })).not.toBeInTheDocument();
    await act(async () => { await Promise.resolve(); });
  });

  it('cancels empty-screen retries and disposes the terminal on close', async () => {
    vi.useFakeTimers();
    vi.mocked(api.sessions.renderedOutput).mockResolvedValue({ rendered: '' });
    const { unmount } = render(<HistoryViewer sessionId="session-1" onClose={vi.fn()} ended />);
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    const signal = vi.mocked(api.sessions.renderedOutput).mock.calls[0][3];
    unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(api.sessions.renderedOutput).toHaveBeenCalledOnce();
    expect(terminal.dispose).toHaveBeenCalledOnce();
  });

  it('ignores a history response that arrives after the terminal was disposed', async () => {
    let resolve!: (output: { rendered: string }) => void;
    vi.mocked(api.sessions.renderedOutput).mockReturnValue(new Promise((finish) => { resolve = finish; }));
    const { unmount } = render(<HistoryViewer sessionId="session-1" onClose={vi.fn()} ended />);
    unmount();
    await act(async () => resolve({ rendered: 'Late screen' }));
    expect(terminal.write).not.toHaveBeenCalled();
    expect(terminal.dispose).toHaveBeenCalledOnce();
  });
});
