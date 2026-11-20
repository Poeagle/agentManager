import type { ConversationControlsData } from '../lib/api';
import { coverageReason, coverageText, creditsLabel, recordedCachePercent, uncachedInputTokens, type SessionMetadata } from '../lib/session-metadata';
import { TableFrame } from './table/DataTable';
import './ConversationDetailsPanel.css';

interface ConversationDetailRow {
  label: string;
  value: string | null | undefined;
  title?: string;
  credits?: boolean;
}

export const formatSessionNumber = (value: number | null | undefined) =>
  value == null ? '—' : value.toLocaleString('zh-CN');
const percent = (value: number | null) => value == null ? '—' : `${value.toFixed(1)}%`;

function cache(input: number | null | undefined, hit: number | null | undefined) {
  return input != null && hit != null && input > 0 && hit >= 0 && hit <= input ? 100 * hit / input : null;
}

function ConversationValuesTable({label, rows}: {label: string; rows: ConversationDetailRow[]}) {
  return <TableFrame label={label} header={<><th scope="col">指标</th><th scope="col">值</th></>} className="conversation-details-table conversation-values-table">
    {rows.map(row => <tr key={row.label}>
      <th scope="row">{row.label}</th>
      <td className={row.credits ? 'session-chat-estimated-cost' : undefined} title={row.title}>{row.value ?? '—'}</td>
    </tr>)}
  </TableFrame>;
}

export function ConversationDetailsPanel({usage, model, state, statusTitle, metadata}: {
  usage: ConversationControlsData['usage'];
  model?: string | null;
  state?: string | null;
  statusTitle?: string | null;
  metadata?: SessionMetadata | null;
}) {
  const recent = metadata ? metadata.latest?.tokens : usage?.last;
  const total = metadata ? metadata.totals?.tokens : usage?.total;
  const inputCoverage = !metadata?.reasons.some(reason => reason === 'missing_usage' || reason === 'counter_mismatch');
  const recentCache = metadata ? recordedCachePercent(recent) : cache(recent?.input_tokens, recent?.cached_input_tokens);
  const totalCache = metadata
    ? inputCoverage ? recordedCachePercent(total) : null
    : cache(total?.input_tokens, total?.cached_input_tokens);
  const context = usage?.window && usage.last.total_tokens != null ? 100 * usage.last.total_tokens / usage.window : null;
  const counts = formatSessionNumber;
  const metrics = [
    {label: '总量 Token', recent: counts(recent?.total_tokens), total: counts(total?.total_tokens)},
    {label: '未缓存输入', recent: counts(uncachedInputTokens(recent)), total: counts(inputCoverage ? uncachedInputTokens(total) : null)},
    {label: '缓存命中输入', recent: counts(recent?.cached_input_tokens), total: counts(total?.cached_input_tokens)},
    {label: '输出 Token', recent: counts(recent?.output_tokens), total: counts(total?.output_tokens)},
    {label: '推理输出', recent: counts(recent?.reasoning_output_tokens), total: counts(total?.reasoning_output_tokens), title: '包含在输出 Token 中'},
    {label: '缓存命中率', recent: percent(recentCache), total: percent(totalCache)},
    {label: '上下文占用', recent: percent(context), total: '—',
      title: context === null ? undefined : `${counts(usage?.last.total_tokens)} / ${counts(usage?.window)} Token`},
  ];
  const cost = metadata?.totals?.cost;
  const counters: ConversationDetailRow[] = [
    {label: '会话状态', value: state, title: statusTitle ?? undefined},
    {label: '当前模型', value: model},
    {label: '预估积分', value: creditsLabel(cost), credits: true,
      title: cost ? `费率 ${cost.rate_date ?? '未知'}${cost.complete ? '' : ' · 费率或用量覆盖不完整'}` : undefined},
    {label: '模型请求（Runs）', value: counts(metadata?.totals?.requests)},
    {label: '用户输入 / 已完成问答', value: metadata ? `${counts(metadata.user_inputs)} / ${counts(metadata.completed_turns)}` : '—'},
    {label: '工具轮次 / 调用', value: metadata?.totals ? `${counts(metadata.totals.tool_rounds)} / ${counts(metadata.totals.tool_calls)}` : '—'},
    {label: '记录覆盖', value: metadata ? coverageText[metadata.status] : null,
      title: metadata?.reasons.map(reason => coverageReason[reason]).join('、') || undefined},
  ];
  return <div className="conversation-details-overview">
    <section className="conversation-metadata-section">
      <h4>Token 用量</h4>
      <TableFrame label="Token 用量" className="conversation-details-table conversation-token-table"
        header={<><th scope="col">指标</th><th scope="col">最近请求</th><th scope="col">会话累计</th></>}>
        {metrics.map(row => <tr key={row.label} title={row.title}>
          <th scope="row">{row.label}</th><td>{row.recent}</td><td>{row.total}</td>
        </tr>)}
      </TableFrame>
    </section>
    <section className="conversation-metadata-section">
      <h4>会话统计</h4>
      <ConversationValuesTable label="会话统计" rows={counters} />
    </section>
  </div>;
}
