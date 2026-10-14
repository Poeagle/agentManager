import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsModal } from '../src/components/SettingsModal';
import { api } from '../src/lib/api';

vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>();
  return { ...actual, api: { ...actual.api,
    settings: { ...actual.api.settings, get: vi.fn(), update: vi.fn() },
    promptEnhancer: { ...actual.api.promptEnhancer, config: vi.fn() },
  } };
});

describe('server memory cleanup settings', () => {
  let client: QueryClient;

  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    vi.mocked(api.settings.get).mockResolvedValue({ settings: {
      memory_cleanup_enabled: 'true', memory_cleanup_threshold_percent: '90', memory_cleanup_idle_minutes: '20',
    } });
    vi.mocked(api.settings.update).mockImplementation(async (settings) => ({ ok: true, settings }));
    vi.mocked(api.promptEnhancer.config).mockResolvedValue({ config: {
      enabled: false, endpoint: '', model: '', mode: 'standard', context_rounds: 3, timeout_ms: 30000, has_api_key: false,
    } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ addresses: [], port: 42010 }) }));
  });

  afterEach(() => { client.clear(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

  async function mount(readOnly = false) {
    render(<QueryClientProvider client={client}><SettingsModal onClose={vi.fn()} readOnly={readOnly} /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByLabelText('内存使用率阈值（%）')).toHaveValue(90));
    fireEvent.click(screen.getByRole('button', { name: '服务器' }));
  }

  it('loads saved values and saves an edited threshold, idle duration and switch', async () => {
    await mount();
    const enabled = screen.getByLabelText('内存不足时自动关闭空闲会话');
    expect(enabled).toBeChecked();
    expect(screen.getByLabelText('最短空闲时间（分钟）')).toHaveValue(20);
    fireEvent.click(enabled);
    fireEvent.change(screen.getByLabelText('内存使用率阈值（%）'), { target: { value: '87.5' } });
    fireEvent.change(screen.getByLabelText('最短空闲时间（分钟）'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
    await waitFor(() => expect(api.settings.update).toHaveBeenCalledWith(expect.objectContaining({
      memory_cleanup_enabled: 'false', memory_cleanup_threshold_percent: '87.5', memory_cleanup_idle_minutes: '30',
    })));
  });

  it('blocks invalid thresholds and fractional idle times before sending an update', async () => {
    await mount();
    fireEvent.change(screen.getByLabelText('内存使用率阈值（%）'), { target: { value: '101' } });
    expect(screen.getByRole('alert')).toHaveTextContent('1% 到 100%');
    expect(screen.getByRole('button', { name: '保存设置' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('内存使用率阈值（%）'), { target: { value: '85' } });
    fireEvent.change(screen.getByLabelText('最短空闲时间（分钟）'), { target: { value: '1.5' } });
    expect(screen.getByRole('alert')).toHaveTextContent('整数');
    expect(screen.getByRole('button', { name: '保存设置' })).toBeDisabled();
    expect(api.settings.update).not.toHaveBeenCalled();
  });

  it('keeps memory controls read-only for members', async () => {
    await mount(true);
    expect(screen.getByLabelText('内存不足时自动关闭空闲会话')).toBeDisabled();
    expect(screen.getByLabelText('内存使用率阈值（%）')).toBeDisabled();
    expect(screen.getByLabelText('最短空闲时间（分钟）')).toBeDisabled();
    expect(screen.queryByRole('button', { name: '保存设置' })).not.toBeInTheDocument();
  });

  it('shows a save failure so the user can correct it', async () => {
    await mount();
    vi.mocked(api.settings.update).mockRejectedValueOnce(new Error('保存失败'));
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('保存失败');
  });
});
