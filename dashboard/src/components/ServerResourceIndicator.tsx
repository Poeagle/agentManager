import { Server } from 'lucide-react';
import { useState } from 'react';
import {useQuery} from '@tanstack/react-query';
import {api} from '../lib/api';
import {DataTable} from './table/DataTable';
import {useTableModel} from './table/use-table-model';
import { Dialog } from './Dialog';
import { useServerResources } from '../lib/use-server-resources';

function formatBytes(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  if(gib>=1024)return `${(gib/1024).toFixed(1)} TiB`;
  if(gib>=1)return `${gib.toFixed(1)} GiB`;
  if(bytes>=1024**2)return `${(bytes/1024**2).toFixed(1)} MiB`;
  if(bytes>=1024)return `${(bytes/1024).toFixed(1)} KiB`;
  return `${bytes} B`;
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
    {selected&&resources&&current&&<Dialog title={`${selected} usage`} size="lg" appearance="manager" onClose={()=>setSelected(null)}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pb-3 text-xs"><span>Current usage <strong style={{color:usageColor(current.percent)}}>{current.value}</strong></span>{stale&&<span role="status">Showing the last successful sample.</span>}</div>
      <ResourceBreakdown key={selected} kind={selected}/>
    </Dialog>}
    </>
  );
}

function ResourceBreakdown({kind}:{kind:'CPU'|'Memory'|'Disk'}) {
 const [path,setPath]=useState<string|undefined>();
 const resourceKind=kind==='CPU'?'cpu':kind==='Memory'?'memory':'disk';
 const query=useQuery({queryKey:['resource-breakdown',resourceKind,path],queryFn:()=>api.admin.resourceBreakdown(resourceKind,path),retry:false,refetchOnWindowFocus:false});
 const result=query.data,processes=result&&result.kind!=='disk'?result.rows:[],directories=result?.kind==='disk'?result.rows:[];
 const processTable=useTableModel(processes,[
  {key:'program',title:'Program',value:row=>row.program},
  {key:'user',title:'User',value:row=>row.user},
  {key:'pid',title:'PID',value:row=>row.pid},
  {key:'cpu',title:'CPU %',value:row=>row.cpu_percent},
  {key:'memory',title:'Memory',value:row=>row.memory_bytes},
 ]);
 const directoryTable=useTableModel(directories,[{key:'directory',title:'Directory',value:row=>row.path},{key:'usage',title:'Used',value:row=>row.bytes}]);
 const location=result?.kind==='disk'?result.path:undefined;
 const up=location&&result?.kind==='disk'&&location!==result.mount?(location.slice(0,location.lastIndexOf('/'))||'/'):null;
 return <div className="space-y-2 text-xs">
  <div className="flex flex-wrap items-center gap-2"><span className="min-w-0 flex-1 break-all">{result?.kind==='disk'?result.path:kind==='Disk'?'Scanning directories…':result?`Sampled ${new Date(result.sampled_at).toLocaleString()}`:'Sampling processes…'}</span>{up&&<button type="button" className="rounded border px-2 py-1" style={{borderColor:'var(--border)'}} disabled={query.isFetching} onClick={()=>setPath(up)}>Up</button>}<button type="button" className="rounded border px-2 py-1" style={{borderColor:'var(--border)'}} disabled={query.isFetching} onClick={()=>void query.refetch()}>Refresh</button></div>
  {query.isPending?<p role="status">{kind==='Disk'?'Scanning directories (up to 15 seconds)…':'Sampling processes…'}</p>:query.isError?<p role="alert">{query.error instanceof Error?query.error.message:'Resource details unavailable'}</p>:result?.kind==='disk'?<DataTable label="Directory usage" model={directoryTable} minWidth={480} empty={!directories.length} emptyMessage="No readable directories found">{directoryTable.rows.map(row=><tr key={row.path}><td><button type="button" className="text-left" style={{color:'var(--accent)'}} disabled={query.isFetching} onClick={()=>setPath(row.path)}>{row.path}</button></td><td>{formatBytes(row.bytes)}</td></tr>)}</DataTable>:<DataTable label="Process usage" model={processTable} minWidth={600} empty={!processes.length} emptyMessage="No readable processes found">{processTable.rows.map(row=><tr key={row.pid}><td>{row.program}</td><td>{row.user}</td><td>{row.pid}</td><td>{row.cpu_percent===null?'—':`${row.cpu_percent.toFixed(1)}%`}</td><td>{formatBytes(row.memory_bytes)}</td></tr>)}</DataTable>}
  {result?.partial&&<p role="status">Results are incomplete because some entries were inaccessible or the scan was limited.</p>}
  {result&&result.kind!=='disk'&&<p style={{color:'var(--text-secondary)'}}>Top 100 by {kind==='CPU'?'CPU':'memory'}. {result.cpu_method==='sampled'?'CPU is measured over a short interval; one core equals 100%.':'CPU is the process average reported by the operating system.'} Memory is resident size and can include shared pages.</p>}
  {result?.kind==='disk'&&<p style={{color:'var(--text-secondary)'}}>Top 100 directories on the same filesystem. Select a directory to inspect it.</p>}
 </div>;
}
