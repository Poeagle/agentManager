import { Fragment, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type ConversationCostEstimate } from '../lib/api';
import {
  coverageReason, intervalCoverageText, recordedCachePercent, uncachedInputTokens, unassignedUsageDescription, unassignedUsageLabel,
  type SessionCacheDrop, type SessionMetadataDetails,
  type SessionUsageIntervalPage, type SessionUsageIntervalRow,
} from '../lib/session-metadata';
import { conversationCostHeading, formatConversationCost } from './estimated-token-cost';
import { CacheDropTable, MetadataTime } from './ConversationCacheDrop';
import { formatSessionNumber as number } from './ConversationDetailsPanel';
import { TableDetailRow, TableExpandButton, TableFrame, TableStateRow } from './table/DataTable';

type HistoryPage<T> = {rows: T[]; next: string | null};

function mergeRows<T extends {id:string}>(current:T[], older:T[]) {
  const ids = new Set(current.map(row=>row.id));
  return [...current, ...older.filter(row=>!ids.has(row.id))];
}

function useEarlierRows<T extends {id: string}>(current: HistoryPage<T>,
  read: (before: string, signal: AbortSignal) => Promise<HistoryPage<T>>) {
  const [older, setOlder] = useState<HistoryPage<T> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const before = older ? older.next : current.next;

  async function load() {
    if (!before || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    setError('');
    try {
      const next = await read(before, controller.signal);
      if (!controller.signal.aborted)
        setOlder({rows:mergeRows(current.rows, mergeRows(older?.rows ?? [], next.rows)), next:next.next});
    } catch {
      if (!controller.signal.aborted) setError('无法读取更早的记录');
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  return {rows:mergeRows(current.rows, older?.rows ?? []), before, loading, error, load};
}

export function ConversationCacheHistory({sessionId, details, loading, error, onRetry}: {
  sessionId: string;
  details: SessionMetadataDetails | null;
  loading: boolean;
  error?: string;
  onRetry: () => void;
}) {
  const history = useEarlierRows<SessionCacheDrop>({rows: details?.cache_drops ?? [], next: details?.next_cache_drop ?? null},
    async (before, signal) => {
      const {metadata} = await api.agent.conversationMetadata(sessionId, {cache_before: before}, signal);
      if (!metadata || metadata.summary.native_id !== details?.summary.native_id || metadata.summary.generation !== details?.summary.generation)
        throw new Error('Cache history changed');
      return {rows: metadata.cache_drops, next: metadata.next_cache_drop};
    });
  const count = details?.summary.cache_drop_count;
  return <section className="conversation-metadata-section">
    <h4>缓存命中输入减少{count == null ? '' : `（${count} 次）`}</h4>
    <CacheDropTable drops={history.rows} loading={loading} error={error} onRetry={onRetry} />
    {history.before && <button className="session-chat-older" type="button" disabled={history.loading} onClick={()=>void history.load()}>
      {history.loading ? '正在读取…' : '更早的缓存异常'}
    </button>}
    {history.error && <p role="alert" className="conversation-details-note">{history.error}</p>}
  </section>;
}

interface ModelUsage {
  model: string | null;
  speed: string | null;
  tokens: number | null;
  requests: number;
  calls: number;
  cost: ConversationCostEstimate | null;
}

function usageByModel(models: SessionMetadataDetails['models']): ModelUsage[] {
  const groups = new Map<string, ModelUsage>();
  for (const row of models) {
    const key = JSON.stringify([row.model,row.speed,row.cost?.unit]);
    const previous = groups.get(key);
    const tokens = row.tokens?.total_tokens ?? null;
    if (!previous) {
      groups.set(key, {model: row.model, speed: row.speed, tokens, requests: row.requests,
        calls: row.tool_calls, cost: row.cost});
      continue;
    }
    previous.tokens = tokens == null || previous.tokens == null ? null : previous.tokens + tokens;
    previous.requests += row.requests;
    previous.calls += row.tool_calls;
    if (previous.cost && row.cost) {
      const { amount, unit, complete } = previous.cost;
      const nextAmount = row.cost.amount;
      previous.cost = {unit, amount: amount == null && nextAmount == null ? null : (amount ?? 0) + (nextAmount ?? 0),
        complete: complete && row.cost.complete};
    }
  }
  return [...groups.values()].sort((a, b) => (b.tokens ?? -1) - (a.tokens ?? -1));
}

const requestCountColumns = [
  {label:'Round', title:'有原生记录的模型请求次数，含只进行推理或只输出文字的请求。'},
  {label:'Call', title:'Agent 发出的原生工具调用次数。'},
];

function ModelUsageTable({details, costHeading, loading, error, onRetry}: {
  details: SessionMetadataDetails | null;
  costHeading: string;
  loading: boolean;
  error?: string;
  onRetry: () => void;
}) {
  const models = usageByModel(details?.models ?? []);
  return <section className="conversation-metadata-section">
    <h4>按模型用量</h4>
    <TableFrame label="按模型用量" className="conversation-metadata-scroll conversation-model-usage" style={{minWidth: 520}}
      loading={loading} header={<>
        <th scope="col">模型</th><th scope="col">速度</th><th scope="col">总量 Token</th>
        {requestCountColumns.map(({label,title}) => <th key={label} scope="col" title={title}>{label}</th>)}
        <th scope="col">{costHeading}</th>
      </>}>
      {loading ? <TableStateRow columnCount={6} loading>加载中…</TableStateRow>
      : error ? <TableStateRow columnCount={6} error onRetry={onRetry}>{error}</TableStateRow>
      : models.length === 0 ? <TableStateRow columnCount={6}>暂无模型用量</TableStateRow>
      : models.map(row => <tr key={JSON.stringify([row.model,row.speed,row.cost?.unit])}>
        <th scope="row">{row.model ?? '未知模型'}</th><td>{row.speed ?? '—'}</td>
        <td>{number(row.tokens)}</td><td>{number(row.requests)}</td>
        <td>{number(row.calls)}</td>
        <td className={row.cost?.amount == null ? undefined : 'session-chat-estimated-cost'}>{row.cost?.amount == null ? '—' : formatConversationCost(row.cost, costHeading !== '预估积分')}</td>
      </tr>)}
    </TableFrame>
  </section>;
}

const intervalColumns: Array<{label: string; title?: string}> = [
  {label:'时间'}, {label:'总输入'}, {label:'缓存输入'}, {label:'未缓存输入'},
  {label:'缓存率'}, {label:'输出'}, {label:'总量'},
  ...requestCountColumns,
];
const intervalColumnCount = intervalColumns.length + 1;

interface UsageScope {
  sessionId:string; nativeId:string; generation?:string; revision?:number; enabled:boolean; showCreditsUnit:boolean;
}

function UsageLevel({scope,parent,depth=0}: {
  scope:UsageScope; parent?:SessionUsageIntervalRow; depth?:number;
}) {
  const {sessionId,nativeId,generation,revision,enabled}=scope;
  const parentId=parent?.id;
  const matches = (page: SessionUsageIntervalPage | null | undefined) =>
    page?.native_id === nativeId && (!generation || page.generation === generation) ? page : null;
  const query = useQuery({
    queryKey: ['conversation-usage-intervals', sessionId, nativeId, generation, parentId],
    queryFn: ({signal}) => api.agent.conversationUsageIntervals(sessionId, parentId ? {parent:parentId} : {}, signal),
    enabled: enabled && !!nativeId, retry: false, refetchOnWindowFocus:false,
  });
  const first = matches(query.data?.intervals);
  useEffect(() => {
    if (!enabled || !first || !revision || first.revision >= revision) return;
    const timer = setTimeout(() => void query.refetch(), 500);
    return () => clearTimeout(timer);
  }, [enabled, revision, first?.revision, query.refetch]);
  const history = useEarlierRows({rows: first?.rows ?? [], next: first?.next_before ?? null}, async (before, signal) => {
    const result = matches((await api.agent.conversationUsageIntervals(sessionId, parentId ? {parent:parentId,before} : {before}, signal)).intervals);
    if (!result || result.generation !== first?.generation) throw new Error('Interval history changed');
    return {rows:result.rows,next:result.next_before};
  });
  const rows = history.rows.filter(row => row.kind!=='open' && row.kind!=='unassigned' ||
    first?.rows.some(current => current.id===row.id));
  const loading = enabled && query.isFetching && !first;
  if (loading) return <TableStateRow columnCount={intervalColumnCount} loading>加载中…</TableStateRow>;
  if (query.isError && !first) return <TableStateRow columnCount={intervalColumnCount} error onRetry={()=>void query.refetch()}>无法读取区间用量</TableStateRow>;
  if (!rows.length) return <TableStateRow columnCount={intervalColumnCount}>暂无区间用量记录</TableStateRow>;
  const finalReply = parent?.kind === 'final' ? rows.find(row => row.phase === 'final') : undefined;
  return <>
    {finalReply&&<UsageRow key={finalReply.id} scope={scope} row={finalReply} depth={depth}/>}
    {rows.filter(row=>row!==finalReply).map(row=><UsageRow key={row.id} scope={scope} row={row} depth={depth}/>)}
    {history.error && <TableStateRow columnCount={intervalColumnCount} error>{history.error}</TableStateRow>}
    {history.before && <TableDetailRow columnCount={intervalColumnCount}>
      <button className="session-chat-older" type="button" style={{marginInlineStart:14*depth}} disabled={history.loading} onClick={()=>void history.load()}>
        {history.loading ? '正在读取…' : parent ? '更多子项' : '更早的用量'}
      </button>
    </TableDetailRow>}
  </>;
}

function UsageRow({scope,row,depth}: {
  scope:UsageScope; row:SessionUsageIntervalRow; depth:number;
}) {
  const [expanded,setExpanded]=useState(false);
  const expandLabel=row.kind==='final'?'轮次用量':row.kind==='progress'?'进展用量':'未完成答复';
  const role=row.kind==='progress'?'Progress':row.phase==='final'?'Final':null;
  const reference=row.usage?.shared_reference;
  const usage=reference?null:row.usage;
  const tokens=usage?.tokens;
  const cacheCountersConsistent=!usage?.reasons?.includes('counter_mismatch');
  const uncached=cacheCountersConsistent?uncachedInputTokens(tokens):null;
  const cacheRate=cacheCountersConsistent?recordedCachePercent(tokens):null;
  const coverage=usage&&!usage.complete ? intervalCoverageText(usage.coverage??'partial',usage.reasons) : null;
  const waitingForCounts=usage?.coverage==='pending'&&!usage.requests;
  const count=(value:number)=>number(waitingForCounts&&value===0?null:value);
  return <Fragment>
    <tr data-interval-kind={row.kind} data-interval-depth={depth}>
      <th scope="row" style={{paddingInlineStart:9+14*depth}}>
        <span className="conversation-interval-time">
          {row.expandable&&<TableExpandButton expanded={expanded} label={expandLabel} onClick={()=>setExpanded(value=>!value)}/>}
          <span>
            {row.kind==='open'?'未完成答复':row.kind==='unassigned'
              ?<span title={unassignedUsageDescription}>{unassignedUsageLabel}</span>:<MetadataTime at={row.at}/>}
            {role&&<>{' '}<span className="conversation-interval-role">{role}</span></>}
            {reference&&<span className="conversation-interval-footnote" title="请求用量已计入同组 Item">共享请求</span>}
          </span>
        </span>
      </th>
      <td>{usage&&number(tokens?.input_tokens)}</td>
      <td>{usage&&number(tokens?.cached_input_tokens)}</td>
      <td>{usage&&number(uncached)}</td>
      <td>{usage&&(cacheRate===null?'—':cacheRate.toFixed(2)+'%')}</td>
      <td><span title={tokens?.reasoning_output_tokens==null?undefined:`含推理输出 ${number(tokens.reasoning_output_tokens)} Token`}>
        {usage&&number(tokens?.output_tokens)}
      </span></td>
      <td>{usage&&number(tokens?.total_tokens)}
        {coverage&&<span className="conversation-interval-footnote"
          title={[coverage,...(usage?.reasons??[]).map(reason=>coverageReason[reason])].join(' · ')} aria-label={coverage}>*</span>}
      </td>
      <td>{usage&&count(usage.requests)}</td>
      <td>{usage&&count(usage.tool_calls)}</td>
      <td className={usage?.cost?.amount==null?undefined:'session-chat-estimated-cost'}>{usage&&(usage.cost?.amount==null?'—':formatConversationCost(usage.cost, scope.showCreditsUnit))}</td>
    </tr>
    {expanded&&<UsageLevel scope={scope} parent={row} depth={depth+1}/>}
  </Fragment>;
}

export function ConversationUsageHistory({sessionId,nativeId,details,cost,billingMode,generation,revision,active,supported,loading,error,onRetry}: {
  sessionId:string; nativeId:string; details:SessionMetadataDetails|null; generation?:string; revision?:number;
  cost?:ConversationCostEstimate|null; billingMode?:'api'|'account'|null;
  active:boolean; supported:boolean; loading:boolean; error?:string; onRetry:()=>void;
}) {
  const costHeading = conversationCostHeading(cost, billingMode);
  return <>
    <ModelUsageTable details={details} costHeading={costHeading} loading={loading} error={error} onRetry={onRetry} />
    <section className="conversation-metadata-section">
      <h4>逐区间用量</h4>
      <TableFrame label="逐区间用量" className="conversation-metadata-scroll conversation-interval-table" style={{minWidth:900}}
        header={<>
          {intervalColumns.map(({label,title})=><th key={label} scope="col" title={title}>{label}</th>)}
          <th scope="col">{costHeading}</th>
        </>}>
        <UsageLevel key={JSON.stringify([nativeId,generation])} scope={{sessionId,nativeId,generation,revision,enabled:active&&supported,showCreditsUnit:costHeading!=='预估积分'}}/>
      </TableFrame>
    </section>
  </>;
}
