import { Server } from 'lucide-react';
import { useServerResources } from '../lib/use-server-resources';

function formatBytes(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  return gib >= 1024 ? `${(gib / 1024).toFixed(1)} TiB` : `${gib.toFixed(1)} GiB`;
}

function usageColor(percent: number): string {
  return percent >= 90 ? 'var(--error)' : percent >= 75 ? '#f59e0b' : 'var(--text-secondary)';
}

export function ServerResourceIndicator() {
  const query = useServerResources();
  const resources = query.data?.server_resources;
  const metrics = resources ? [
    {
      label: 'CPU', percent: resources.cpu.usage_percent,
      value: `${resources.cpu.usage_percent.toFixed(0)}%`,
      detail: `CPU 使用率 ${resources.cpu.usage_percent.toFixed(1)}% · ${resources.cpu.core_count} 个逻辑核`,
    },
    {
      label: '内存', percent: resources.memory.usage_percent,
      value: `${resources.memory.usage_percent.toFixed(0)}%`,
      detail: `内存已用 ${formatBytes(resources.memory.used_bytes)} / 总量 ${formatBytes(resources.memory.total_bytes)} · 使用率 ${resources.memory.usage_percent.toFixed(1)}%`,
    },
    {
      label: '磁盘', percent: resources.disk?.usage_percent ?? 0,
      value: resources.disk ? `${resources.disk.usage_percent.toFixed(0)}%` : '不可用',
      detail: resources.disk
        ? `服务所在磁盘 ${resources.disk.mount} · 已用 ${formatBytes(resources.disk.used_bytes)} / 总量 ${formatBytes(resources.disk.total_bytes)} · 使用率 ${resources.disk.usage_percent.toFixed(1)}%`
        : '无法读取服务所在磁盘用量',
    },
  ] : [];
  const stale = query.isError && !!resources;
  const sampledTime = resources ? new Date(resources.sampled_at).toLocaleString() : '';
  const status = stale ? '刷新失败，显示上次成功采样' : query.isError ? '服务器资源读取失败' : '服务器资源读取中';
  const title = resources
    ? [`部署服务器：${resources.hostname}`, ...metrics.map((metric) => metric.detail),
      `检测时间：${sampledTime}`, '容量单位：GiB · 每 5 秒刷新', ...(stale ? [status] : [])].join('\n')
    : status;

  return (
    <div aria-label="部署服务器资源" title={title}
      className="workspace-indicator flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded border px-1.5 text-[11px]"
      style={{ borderColor: 'var(--border)', background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>
      {resources ? metrics.map(({ label, value, percent, detail }, index) => (
        <span key={label} title={`${detail}\n检测时间：${sampledTime}`} className={`flex items-center gap-1 ${index ? 'border-l pl-1.5' : ''}`} style={{ borderColor: 'var(--border)' }}>
          <span>{label}</span>
          <strong className="font-mono text-[11px] font-medium tabular-nums" style={{ color: usageColor(percent) }}>{value}</strong>
        </span>
      )) : <><Server className="h-3.5 w-3.5" aria-hidden="true" /><span role="status">{status}</span></>}
      {stale && <span role="status" title={status} aria-label={status} className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--error)' }} />}
    </div>
  );
}
