import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ServerResourceIndicator } from '../src/components/ServerResourceIndicator';
import { api } from '../src/lib/api';
import { AdminMonitorPage } from '../src/components/AdminMonitorPage';
import { cacheServerResources } from '../src/lib/server-resource-cache';
import { useStreamStore } from '../src/lib/websocket';

vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return { ...actual, api: { ...actual.api, admin: { ...actual.api.admin, serverResources: vi.fn(), monitor: vi.fn(), resourceBreakdown: vi.fn() } } };
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
  vi.mocked(api.admin.resourceBreakdown).mockImplementation(async(kind,path)=>kind==='disk'?{kind:'disk',path:path||'/',mount:'/',partial:false,sampled_at:'2026-10-13T08:00:00Z',rows:[{path:'/home',bytes:1024**3}]}:{kind,partial:false,cpu_method:'sampled',sampled_at:'2026-10-13T08:00:00Z',rows:[{pid:42,user:'alice',program:'node',cpu_percent:12,memory_bytes:128*1024**2}]});
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
  expect(screen.getByText('Memory').parentElement).toHaveAttribute('title', expect.stringContaining('8.0 GiB / 总量 32.0 GiB'));
  expect(screen.getByText('Disk').parentElement).toHaveAttribute('title', expect.stringContaining('100.0 GiB / 总量 250.0 GiB'));
  expect(screen.getByLabelText('部署服务器资源')).toHaveClass('workspace-header-chip');
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
  expect(screen.getByText('Unavailable')).toBeVisible();
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

it('colors usage from healthy to critical', async () => {
  vi.mocked(api.admin.serverResources).mockResolvedValue({server_resources:{...resources,cpu:{...resources.cpu,usage_percent:12},memory:{...resources.memory,usage_percent:75},disk:{...resources.disk,usage_percent:95}}});
  await mount();
  expect(screen.getByText('12%')).toHaveAttribute('style',expect.stringContaining('var(--success)'));
  expect(screen.getByText('75%')).toHaveAttribute('style',expect.stringContaining('rgb(183, 121, 11)'));
  expect(screen.getByText('95%')).toHaveAttribute('style',expect.stringContaining('var(--error)'));
});

it('shows processes and drillable directories in resource tables', async () => {
  await mount();
  fireEvent.click(screen.getByRole('button',{name:'Memory usage 25%'}));
  await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
  let dialog=screen.getByRole('dialog',{name:'Memory usage'});
  expect(within(dialog).getByRole('table',{name:'Process usage'})).toHaveTextContent('node');
  expect(within(dialog).getByText('128.0 MiB')).toBeVisible();
  fireEvent.click(within(dialog).getByRole('button',{name:'关闭Memory usage'}));
  fireEvent.click(screen.getByRole('button',{name:'CPU usage 12%'}));
  await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
  dialog=screen.getByRole('dialog',{name:'CPU usage'});
  expect(within(dialog).getByRole('table',{name:'Process usage'})).toHaveTextContent('12.0%');
  fireEvent.click(within(dialog).getByRole('button',{name:'关闭CPU usage'}));
  fireEvent.click(screen.getByRole('button',{name:'Disk usage 40%'}));
  await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
  dialog=screen.getByRole('dialog',{name:'Disk usage'});
  expect(within(dialog).getByRole('table',{name:'Directory usage'})).toHaveTextContent('1.0 GiB');
  fireEvent.click(within(dialog).getByRole('button',{name:'/home'}));
  await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
  expect(api.admin.resourceBreakdown).toHaveBeenCalledWith('disk','/home');
});

it('keeps the disk table visible when reopening and while a refresh fails', async()=>{
  await mount();fireEvent.click(screen.getByRole('button',{name:'Disk usage 40%'}));await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
  let dialog=screen.getByRole('dialog',{name:'Disk usage'});expect(within(dialog).getByRole('table',{name:'Directory usage'})).toHaveTextContent('/home');
  fireEvent.click(within(dialog).getByRole('button',{name:'关闭Disk usage'}));fireEvent.click(screen.getByRole('button',{name:'Disk usage 40%'}));
  dialog=screen.getByRole('dialog',{name:'Disk usage'});expect(within(dialog).getByRole('table',{name:'Directory usage'})).toHaveTextContent('/home');
  vi.mocked(api.admin.resourceBreakdown).mockRejectedValueOnce(new Error('timeout'));fireEvent.click(within(dialog).getByRole('button',{name:'Refresh'}));await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
  expect(within(dialog).getByText('Refresh failed; showing the previous sample.')).toBeVisible();expect(within(dialog).getByRole('table',{name:'Directory usage'})).toHaveTextContent('/home');
});
