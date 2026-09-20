import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexQuotaIndicator } from '../src/components/CodexQuotaIndicator';
import { api } from '../src/lib/api';

vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return {
    ...actual,
    api: { ...actual.api, codexQuota: { read: vi.fn() } },
  };
});

describe('CodexQuotaIndicator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(api.codexQuota.read).mockResolvedValue({
      quota: {
        usedPercent: 35,
        remainingPercent: 65,
        windowDurationMins: 10_080,
        resetsAt: 1_787_196_804,
        planType: 'pro',
        checkedAt: '2026-08-13T08:00:00.000Z',
      },
    });
  });

  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

  it('shows the global weekly quota and refreshes it every five minutes', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><CodexQuotaIndicator /></QueryClientProvider>);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByLabelText('Codex 周额度剩余 65%')).toBeInTheDocument();
    expect(screen.getByText(/检测 \d{2}:\d{2}:\d{2}/)).toBeInTheDocument();
    expect(api.codexQuota.read).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(api.codexQuota.read).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(295_000); });
    expect(api.codexQuota.read).toHaveBeenCalledTimes(2);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '刷新 Codex 额度' })); });
    expect(api.codexQuota.read).toHaveBeenLastCalledWith(true);
    client.clear();
  });
  it('pauses automatic polling when the page is hidden', async () => {
    const { focusManager } = await import('@tanstack/react-query');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><CodexQuotaIndicator /></QueryClientProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    focusManager.setFocused(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(600_000); });
    expect(api.codexQuota.read).toHaveBeenCalledTimes(1);
    client.clear(); focusManager.setFocused(undefined);
  });

});
