import {useState} from 'react';
import {ChevronRight} from 'lucide-react';
import { cacheHitColor, type CacheDropFactor, type SessionCacheDrop, type SessionCacheSample } from '../lib/session-metadata';
import { formatElapsed } from '../lib/conversation-timing';
import { TableFrame, TableStateRow } from './table/DataTable';
import { formatEstimatedTokenCost } from './estimated-token-cost';

const compact = new Intl.NumberFormat('en', {notation:'compact', maximumFractionDigits: 1});
const date = new Intl.DateTimeFormat('sv-SE', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23',
});
const percent = new Intl.NumberFormat('en', {minimumFractionDigits:1, maximumFractionDigits:2});
const rate = (value: number) => percent.format(value * 100) + '%';

export const factorNames: Record<CacheDropFactor, string> = {
  input_gap: '输入间隔较长', model: '模型变化', speed: '速度变化', environment: 'Engine 变化',
  account: '账号变化', compact: '上下文压缩', input_size: '输入量变化',
};

export function MetadataTime({at}: {at: string | null | undefined}) {
  return at && Number.isFinite(Date.parse(at)) ? <time dateTime={at} title={at}>{date.format(new Date(at))}</time> : <span>时间未知</span>;
}

function SampleTokens({sample, inline = false}: {sample: SessionCacheSample; inline?: boolean}) {
  const label = '总输入 ' + sample.input_tokens.toLocaleString() + ' Token，缓存命中 ' +
    sample.cached_input_tokens.toLocaleString() + ' Token，命中率 ' + rate(sample.hit_rate);
  return <span title={label} aria-label={label} className="conversation-cache-sample">
    {compact.format(sample.input_tokens)}{inline ? ' ｜ ' : ' / '}{compact.format(sample.cached_input_tokens)} (
    {inline ? <span className="session-chat-cache-hit" style={{color:cacheHitColor(sample.hit_rate * 100)}}>{rate(sample.hit_rate)}</span> : rate(sample.hit_rate)})
  </span>;
}

function dropInterval(drop: SessionCacheDrop) {
  const label = drop.interval_kind === 'request' ? '请求间隔' : '输入间隔';
  const elapsed = drop.elapsed_ms;
  return elapsed === null ? `${label}未知` : `${label} ${elapsed < 60_000 ? elapsed / 1000 + '秒' : formatElapsed(elapsed)}`;
}

function CacheDropCause({drop}: {drop: SessionCacheDrop}) {
  const compacted = drop.factors.includes('compact');
  const factors = drop.factors.filter(factor => factor !== 'input_size' || !compacted).map(factor => factorNames[factor]);
  const names = new Set(drop.confirmed_cause ? [drop.confirmed_cause.label, ...factors] : factors);
  const basis = compacted ? '比较压缩前最后一笔和压缩后第一笔原生请求的缓存命中输入' : undefined;
  return <span title={basis}>{[...names].join('、') || '原因未确认'}</span>;
}

export function CacheDropTable({drops, loading, error, onRetry}: {
  drops: SessionCacheDrop[];
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
}) {
  return <TableFrame label="缓存命中输入减少明细" className="conversation-metadata-scroll conversation-cache-table" loading={loading}
    header={<>{['异常时间', '前次总输入 / 命中', '本次总输入 / 命中', '间隔', '原因']
      .map(label => <th key={label} scope="col">{label}</th>)}</>} style={{minWidth: 660}}>
      {loading ? <TableStateRow columnCount={5} loading>加载中…</TableStateRow>
      : error ? <TableStateRow columnCount={5} error onRetry={onRetry}>{error}</TableStateRow>
      : drops.length === 0 ? <TableStateRow columnCount={5}>暂无缓存异常记录</TableStateRow>
      : drops.map(drop => <tr key={drop.id}>
        <td className="conversation-time-cell"><MetadataTime at={drop.at} /></td>
        <td><SampleTokens sample={drop.previous} /></td>
        <td><SampleTokens sample={drop.current} /></td>
        <td>{dropInterval(drop)}</td>
        <td><CacheDropCause drop={drop}/></td>
      </tr>)}
  </TableFrame>;
}

export function ConversationCacheDrop({drop, summaryLabel}: {drop: SessionCacheDrop; summaryLabel?: string}) {
  const elapsed = drop.elapsed_ms === null ? '—' : `${drop.elapsed_ms / 1000}s`;
  const extra = drop.extra_cost;
  const extraAmount = extra ? formatEstimatedTokenCost(Math.abs(extra.amount),extra.unit,false) : null;
  const extraLabel = extra
    ? `${extra.amount < 0 ? '预估节省' : '预估多耗'} ${extraAmount}`
    : '额外费用未知';
  const extraTitle = extra ? '未缓存输入、缓存读取和缓存写入的费用净差，均按本次费率计算' : '缺少可用的费率或用量，无法估算';
  return <div className="conversation-cache-notice" data-cache-drop-id={drop.id} role="group" aria-label="缓存命中输入减少">
    <MetadataTime at={drop.current.request_at ?? drop.at} />
    <SampleTokens sample={drop.current} inline />
    <span aria-hidden="true">←</span>
    <MetadataTime at={drop.previous.request_at} />
    <SampleTokens sample={drop.previous} inline />
    <span title={dropInterval(drop)}>Elapsed: {elapsed}</span>
    <span title={summaryLabel ? '本组记录的预估多耗与节省净合计，按各次请求费率计算' : extraTitle}>{summaryLabel ?? extraLabel}</span>
  </div>;
}

function combinedExtraLabel(drops: SessionCacheDrop[]) {
  const extras = drops.map(drop => drop.extra_cost);
  if (extras.some(extra => !extra) || new Set(extras.map(extra => extra?.unit)).size !== 1) {
    return '累计净多耗未知';
  }
  const first = extras[0]!;
  const total = extras.reduce((sum, extra) => sum + extra!.amount, 0);
  const amount = formatEstimatedTokenCost(Math.abs(total), first.unit, false);
  return `${total < 0 ? '累计净节省' : '累计净多耗'} ${amount}`;
}

export function ConversationCacheDropGroup({drops}: {drops: SessionCacheDrop[]}) {
  const [expanded, setExpanded] = useState(false);
  if (drops.length < 2) return drops.map(drop => <ConversationCacheDrop key={drop.id} drop={drop}/>);
  const count = drops.length;
  return <div className="conversation-cache-drop-group">
    <div className="conversation-cache-drop-row">
      <button type="button" className="conversation-cache-toggle" aria-label={`${expanded ? '收起' : '展开'} ${count} 条缓存记录`}
        aria-expanded={expanded} title={expanded ? '收起缓存记录' : '展开缓存记录'} onClick={()=>setExpanded(value=>!value)}>
        <ChevronRight size={13} aria-hidden="true"/>
      </button>
      <ConversationCacheDrop drop={drops[0]} summaryLabel={expanded ? undefined : `共 ${count} 条 · ${combinedExtraLabel(drops)}`}/>
    </div>
    {expanded&&drops.slice(1).map(drop=><ConversationCacheDrop key={drop.id} drop={drop}/>)}
  </div>;
}
