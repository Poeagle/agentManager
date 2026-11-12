import { Server } from 'lucide-react';
import { useState } from 'react';
import { Dialog } from './Dialog';
import { useServerResources } from '../lib/use-server-resources';

function formatBytes(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  return gib >= 1024 ? `${(gib / 1024).toFixed(1)} TiB` : `${gib.toFixed(1)} GiB`;
}

function usageColor(percent: number | null): string {
  if (percent === null) return 'var(--text-muted)';
  if (percent >= 90) return 'var(--error)';
  if (percent >= 80) return '#e57b18';
  if (percent >= 60) return '#b7790b';
  return 'var(--success)';
}

export function ServerResourceIndicator() {
  const [selected,setSelected]=useState<'CPU'|'Memory'|'Disk'|null>(null);
  const query = useServerResources();
  const resources = query.data?.server_resources;
  const metrics = resources ? [
    {
      label: 'CPU' as const, percent: resources.cpu.usage_percent,
      value: `${resources.cpu.usage_percent.toFixed(0)}%`,
      detail: `CPU 使用率 ${resources.cpu.usage_percent.toFixed(1)}% · ${resources.cpu.core_count} 个逻辑核`,
    },
    {
      label: 'Memory' as const, percent: resources.memory.usage_percent,
      value: `${resources.memory.usage_percent.toFixed(0)}%`,
      detail: `内存已用 ${formatBytes(resources.memory.used_bytes)} / 总量 ${formatBytes(resources.memory.total_bytes)} · 使用率 ${resources.memory.usage_percent.toFixed(1)}%`,
    },
    {
      label: 'Disk' as const, percent: resources.disk?.usage_percent ?? null,
      value: resources.disk ? `${resources.disk.usage_percent.toFixed(0)}%` : 'Unavailable',
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

  const current=metrics.find(metric=>metric.label===selected);
  return (
    <>
    <div aria-label="部署服务器资源" title={title}
      className="workspace-indicator workspace-header-chip flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded border px-1.5 text-[11px]"
      style={{ borderColor: 'var(--border)' }}>
      {resources ? metrics.map(({ label, value, percent, detail }, index) => (
        <button type="button" key={label} aria-label={`${label} usage ${value}`} onClick={()=>setSelected(label)} title={`${detail}\n检测时间：${sampledTime}`} className={`flex items-center gap-1 ${index ? 'border-l pl-1.5' : ''}`} style={{ borderColor: 'var(--border)' }}>
          <span>{label}</span>
          <strong className="text-[11px] font-medium tabular-nums" style={{ color: usageColor(percent) }}>{value}</strong>
        </button>
      )) : <><Server className="h-3.5 w-3.5" aria-hidden="true" /><span role="status">{status}</span></>}
      {stale && <span role="status" title={status} aria-label={status} className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--error)' }} />}
    </div>
    {selected&&resources&&current&&<Dialog title={`${selected} usage`} appearance="manager" onClose={()=>setSelected(null)}>
      <div className="space-y-3 text-sm">
        <div className="flex items-baseline justify-between gap-4"><span>Current usage</span><strong style={{color:usageColor(current.percent)}}>{current.value}</strong></div>
        {current.percent!==null&&<progress aria-label={`${selected} usage`} value={Math.max(0,Math.min(100,current.percent))} max={100} className="w-full" style={{accentColor:usageColor(current.percent)}}/>}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
          {selected==='CPU'&&<><dt>Logical cores</dt><dd>{resources.cpu.core_count}</dd><dt>1 minute load average</dt><dd>{resources.cpu.load_average_1m.toFixed(2)}</dd></>}
          {selected==='Memory'&&<><dt>Used</dt><dd>{formatBytes(resources.memory.used_bytes)}</dd><dt>Available</dt><dd>{formatBytes(resources.memory.available_bytes)}</dd><dt>Total</dt><dd>{formatBytes(resources.memory.total_bytes)}</dd></>}
          {selected==='Disk'&&resources.disk&&<><dt>Mount</dt><dd>{resources.disk.mount}</dd><dt>Used</dt><dd>{formatBytes(resources.disk.used_bytes)}</dd><dt>Available</dt><dd>{formatBytes(resources.disk.available_bytes)}</dd><dt>Total</dt><dd>{formatBytes(resources.disk.total_bytes)}</dd></>}
          <dt>Server</dt><dd>{resources.hostname}</dd><dt>Sampled</dt><dd>{sampledTime}</dd>
        </dl>
        {stale&&<p role="status">Refresh failed; showing the last successful sample.</p>}
      </div>
    </Dialog>}
    </>
  );
}
