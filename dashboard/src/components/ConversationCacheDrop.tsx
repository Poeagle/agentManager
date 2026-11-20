import { AlertTriangle } from 'lucide-react';
import type { CacheDropFactor, SessionCacheDrop, SessionCacheSample } from '../lib/session-metadata';
import { formatElapsed } from '../lib/conversation-timing';
import { ConversationDialogCard } from './ConversationDialogCard';
import { DataTable } from './table/DataTable';
import { useTableModel } from './table/use-table-model';

const compact = new Intl.NumberFormat('en', {notation:'compact', maximumFractionDigits: 1});
const date = new Intl.DateTimeFormat('sv-SE', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23', timeZoneName: 'shortOffset',
});
const rate = (value: number) => (value * 100).toFixed(1) + '%';

export const factorNames: Record<CacheDropFactor, string> = {
  input_gap: '输入间隔较长', model: '模型变化', speed: '速度变化', environment: 'Engine 变化',
  account: '账号变化', compact: '上下文压缩', input_size: '输入量变化',
};

export function MetadataTime({at}: {at: string | null | undefined}) {
  return at && Number.isFinite(Date.parse(at)) ? <time dateTime={at} title={at}>{date.format(new Date(at))}</time> : <span>时间未知</span>;
}

function SampleTokens({sample}: {sample: SessionCacheSample}) {
  const label = '输入 ' + sample.input_tokens.toLocaleString() + ' Token，缓存命中 ' +
    sample.cached_input_tokens.toLocaleString() + ' Token，命中率 ' + rate(sample.hit_rate);
  return <span title={label} aria-label={label} className="conversation-cache-sample">
    {compact.format(sample.input_tokens)} / {compact.format(sample.cached_input_tokens)} ({rate(sample.hit_rate)})
  </span>;
}

function SampleCell({sample}: {sample: SessionCacheSample}) {
  const dimensions = [sample.model, sample.speed, sample.environment, sample.account].filter(Boolean);
  return <>
    <SampleTokens sample={sample} />
    <small>输入 <MetadataTime at={sample.input_at} /></small>
    <small>请求 <MetadataTime at={sample.request_at} /></small>
    {dimensions.length > 0 && <small>{dimensions.join(' · ')}</small>}
    <small title={sample.turn_id}>轮次 {sample.turn_id}</small>
    <small title={sample.request_id}>请求 ID {sample.request_id}</small>
  </>;
}

export function CacheDropTable({drops}: {drops: SessionCacheDrop[]}) {
  const model=useTableModel(drops,[
    {key:'time',title:'异常时间',value:row=>row.at},
    {key:'previous',title:'前次输入 / 命中（命中率）',value:row=>row.previous.hit_rate},
    {key:'current',title:'本次输入 / 命中（命中率）',value:row=>row.current.hit_rate},
    {key:'interval',title:'输入间隔',value:row=>row.elapsed_ms},
    {key:'reason',title:'原因与相关因素',value:row=>row.confirmed_cause?.label??row.factors.map(factor=>factorNames[factor]).join('、')},
  ]);
  return <DataTable label="缓存命中率下降明细" className="conversation-metadata-scroll" model={model} minWidth={660}>
      {model.rows.map(drop => <tr key={drop.id}>
        <td><MetadataTime at={drop.at} /><small>下降 {drop.decrease_pp.toFixed(1)} 个百分点</small></td>
        <td><SampleCell sample={drop.previous} /></td>
        <td><SampleCell sample={drop.current} /></td>
        <td>{drop.elapsed_ms === null ? '未知' : formatElapsed(drop.elapsed_ms)}</td>
        <td>{drop.confirmed_cause ? <>
          {drop.confirmed_cause.label}<small>{drop.confirmed_cause.evidence}</small>
        </> : '原因未确认'}
          {drop.factors.length > 0 && <small>相关因素 {drop.factors.map(factor => factorNames[factor]).join('、')}</small>}
        </td>
      </tr>)}
  </DataTable>;
}

export function ConversationCacheDrop({drop, active}: {drop: SessionCacheDrop; active: boolean}) {
  return <div className="conversation-cache-card" data-cache-drop-id={drop.id}>
    <ConversationDialogCard title="缓存命中率下降" active={active} summary={
      <span className="conversation-cache-summary">
        <AlertTriangle size={14} aria-hidden="true" />
        <strong>缓存命中率下降</strong>
        <SampleTokens sample={drop.previous} /><span aria-hidden="true">→</span><SampleTokens sample={drop.current} />
        <span>{drop.elapsed_ms === null ? '输入间隔未知' : '间隔 ' + formatElapsed(drop.elapsed_ms)}</span>
        <MetadataTime at={drop.at} />
      </span>
    }>
      <CacheDropTable drops={[drop]} />
    </ConversationDialogCard>
  </div>;
}
