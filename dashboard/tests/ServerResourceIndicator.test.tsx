import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ServerResourceIndicator } from '../src/components/ServerResourceIndicator';
import { api } from '../src/lib/api';
import { AdminMonitorPage } from '../src/components/AdminMonitorPage';
import { cacheServerResources } from '../src/lib/server-resource-cache';
import { useStreamStore } from '../src/lib/websocket';

vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return { ...actual, api: { ...actual.api, admin: { ...actual.api.admin, serverResources: vi.fn(), monitor: vi.fn() } } };
});
const resources = {
  sampled_at: '2026-10-13T08:00:00.000Z',
  hostname: 'deployment-server', uptime_seconds: 100,
  cpu: { usage_percent: 12, core_count: 8, load_average_1m: 1 },
  memory: { used_bytes: 8 * 1024 ** 3, total_bytes: 32 * 1024 ** 3, available_bytes: 24 * 1024 ** 3, usage_percent: 25 },
  disk: { used_bytes: 100 * 1024 ** 3, total_bytes: 250 * 1024 ** 3, available_bytes: 150 * 1024 ** 3, usage_percent: 40, mount: '/' },
};
let client: QueryClient;
beforeEach(() => {
  vi.useFakeTimers();
  useStreamStore.getState().setConnected(false);
  vi.mocked(api.admin.serverResources).mockResolvedValue({ server_resources: resources });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => { client.clear(); useStreamStore.getState().setConnected(false); vi.useRealTimers(); vi.clearAllMocks(); });
async function mount() {
  render(<QueryClientProvider client={client}><ServerResourceIndicator /></QueryClientProvider>);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

it('shows compact usage percentages, keeps capacities in tooltips, and refreshes every five seconds', async () => {
  await mount();
  expect(screen.getByText('12%')).toBeVisible();
  expect(screen.getByText('25%')).toBeVisible();
  expect(screen.getByText('40%')).toBeVisible();
  expect(screen.getByText('内存').parentElement).toHaveAttribute('title', expect.stringContaining('8.0 GiB / 总量 32.0 GiB'));
  expect(screen.getByText('磁盘').parentElement).toHaveAttribute('title', expect.stringContaining('100.0 GiB / 总量 250.0 GiB'));
  expect(screen.getByLabelText('部署服务器资源')).toHaveAttribute('title', expect.stringContaining('8 个逻辑核'));
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(api.admin.serverResources).toHaveBeenCalledTimes(2);
});

it('keeps successful data visibly marked stale on a failed refresh', async () => {
  await mount();
  vi.mocked(api.admin.serverResources).mockRejectedValue(new Error('offline'));
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  expect(screen.getByText('12%')).toBeVisible();
  expect(screen.getByLabelText('刷新失败，显示上次成功采样')).toBeInTheDocument();
});

it('keeps CPU and memory available when the platform cannot sample disk', async () => {
  vi.mocked(api.admin.serverResources).mockResolvedValue({ server_resources: { ...resources, disk: null } });
  await mount();
  expect(screen.getByText('不可用')).toBeVisible();
  expect(screen.getByText('12%')).toBeVisible();
});

it('shares one resource query between the header and monitor and updates both from one pushed sample', async () => {
  useStreamStore.getState().setConnected(true);
  vi.mocked(api.admin.monitor).mockResolvedValue({
    generated_at: resources.sampled_at, server_resources: resources,
    active_users: 0, active_sessions: 0, total_memory_bytes: 0, users: [],
  });
  render(<QueryClientProvider client={client}>
    <ServerResourceIndicator /><AdminMonitorPage onBack={vi.fn()} onOpenSession={vi.fn()} />
  </QueryClientProvider>);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(screen.getAllByText('12%')).toHaveLength(2);
  expect(api.admin.serverResources).toHaveBeenCalledTimes(1);
  await act(async () => {
    cacheServerResources(client, { server_resources: {
      ...resources, sampled_at: '2026-10-13T08:00:05.000Z', cpu: { ...resources.cpu, usage_percent: 44 },
    } });
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(screen.getAllByText('44%')).toHaveLength(2);
  expect(api.admin.serverResources).toHaveBeenCalledTimes(1);
});
