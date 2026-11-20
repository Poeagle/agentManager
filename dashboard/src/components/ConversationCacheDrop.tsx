import { AlertTriangle } from 'lucide-react';
import type { CacheDropFactor, SessionCacheDrop, SessionCacheSample } from '../lib/session-metadata';
import { formatElapsed } from '../lib/conversation-timing';
import { ConversationDialogCard } from './ConversationDialogCard';
import { TableFrame, TableStateRow } from './table/DataTable';

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

function SampleTokens({sample}: {sample: SessionCacheSample}) {
  const label = '总输入 ' + sample.input_tokens.toLocaleString() + ' Token，缓存命中 ' +
    sample.cached_input_tokens.toLocaleString() + ' Token，命中率 ' + rate(sample.hit_rate);
  return <span title={label} aria-label={label} className="conversation-cache-sample">
    {compact.format(sample.input_tokens)} / {compact.format(sample.cached_input_tokens)} ({rate(sample.hit_rate)})
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

export function ConversationCacheDrop({drop, active}: {drop: SessionCacheDrop; active: boolean}) {
  return <div className="conversation-cache-card" data-cache-drop-id={drop.id}>
    <ConversationDialogCard title="缓存命中输入减少" active={active} summary={
      <span className="conversation-cache-summary">
        <AlertTriangle size={14} aria-hidden="true" />
        <strong>缓存命中输入减少</strong>
        <SampleTokens sample={drop.previous} /><span aria-hidden="true">→</span><SampleTokens sample={drop.current} />
        <span>减少 {(drop.previous.cached_input_tokens - drop.current.cached_input_tokens).toLocaleString('zh-CN')} Token</span>
        <span>{dropInterval(drop)}</span>
        <MetadataTime at={drop.at} />
      </span>
    }>
      <CacheDropTable drops={[drop]} />
    </ConversationDialogCard>
  </div>;
}
