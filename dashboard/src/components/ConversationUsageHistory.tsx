import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { creditsLabel, type SessionLifecycleFact, type SessionMetadataDetails } from '../lib/session-metadata';
import { CacheDropTable, MetadataTime } from './ConversationCacheDrop';
import { DataTable } from './table/DataTable';
import { useTableModel } from './table/use-table-model';

const number = (value: number | null | undefined) => value == null ? '—' : value.toLocaleString('zh-CN');
const actions: Record<SessionLifecycleFact['action'], string> = {
  create: '创建', resume: '恢复', reload: '重载', new: '新开', close: '关闭', delete: '删除',
  compact: '压缩', model: '模型设置', speed: '速度设置', environment: 'Engine 切换', account: '账号切换',
  input: '输入', queue: '排队', cancel_queue: '取消排队', stop: '停止执行', interrupt: '中断',
};
const states: Record<SessionLifecycleFact['state'], string> = {
  requested: '已提交', accepted: '已受理', completed: '已完成', failed: '失败', unknown: '结果未知',
};

export function ConversationUsageHistory({sessionId, details}: {sessionId: string; details: SessionMetadataDetails}) {
  const [older, setOlder] = useState<Partial<SessionMetadataDetails>>({});
  const [loading, setLoading] = useState<'event' | 'cache' | null>(null);
  const [error, setError] = useState('');
  const identity = details.summary.native_id + ':' + details.summary.generation;
  useEffect(() => {
    setOlder({});
    setError('');
    setLoading(null);
  }, [identity]);
  const events = [...new Map([...details.events, ...(older.events ?? [])].map(row => [row.id, row])).values()];
  const drops = [...new Map([...details.cache_drops, ...(older.cache_drops ?? [])].map(row => [row.id, row])).values()];
  const nextEvent = older.next_event !== undefined ? older.next_event : details.next_event;
  const nextCache = older.next_cache_drop !== undefined ? older.next_cache_drop : details.next_cache_drop;
  const models = useTableModel(details.models,[
    {key:'model',title:'模型',value:row=>row.model},
    {key:'dimensions',title:'速度 / Engine / 账号',value:row=>[row.speed,row.environment,row.account].filter(Boolean).join(' / ')},
    {key:'runs',title:'Runs',value:row=>row.requests},
    {key:'tools',title:'工具轮次 / 调用',value:row=>row.tool_rounds},
    {key:'total',title:'总量 Token',value:row=>row.tokens?.total_tokens},
    {key:'input',title:'输入 / 命中',value:row=>row.tokens?.input_tokens},
    {key:'output',title:'输出 / 推理',value:row=>row.tokens?.output_tokens},
    {key:'credit',title:'预估积分',value:row=>row.cost?.amount},
  ]);
  const lifecycle=useTableModel(events,[
    {key:'time',title:'时间',value:row=>row.at},
    {key:'action',title:'动作与状态',value:row=>actions[row.action]+' · '+states[row.state]},
    {key:'evidence',title:'来源',value:row=>row.evidence==='native'?'原生记录':'平台记录'},
    {key:'related',title:'关联记录',value:row=>row.turn_id??row.execution?.turn_id??row.related_native_id},
  ]);

  async function load(kind: 'event' | 'cache', before: string) {
    setLoading(kind);
    setError('');
    try {
      const {metadata} = await api.agent.conversationMetadata(sessionId,
        kind === 'event' ? {event_before: before} : {cache_before: before});
      if (!metadata || metadata.summary.native_id + ':' + metadata.summary.generation !== identity) {
        setError('会话记录已更新，请刷新后重试');
        return;
      }
      setOlder(previous => kind === 'event' ? {
        ...previous, events: [...(previous.events ?? []), ...metadata.events], next_event: metadata.next_event,
      } : {
        ...previous, cache_drops: [...(previous.cache_drops ?? []), ...metadata.cache_drops], next_cache_drop: metadata.next_cache_drop,
      });
    } catch {
      setError('读取更早的会话记录失败');
    } finally {
      setLoading(null);
    }
  }

  return <>
    <section className="conversation-metadata-section" aria-label="按模型、速度与环境">
      <h4>按模型、速度与环境</h4>
      {details.models.length > 0 ? <DataTable label="按模型用量" className="conversation-metadata-scroll" model={models} minWidth={700}>
          {models.rows.map(row => <tr key={JSON.stringify([row.model, row.speed, row.environment, row.account])}>
            <th scope="row">{row.model ?? '未知模型'}</th>
            <td>{row.speed ?? '速度未知'} / {row.environment ?? 'Engine 未知'} / {row.account ?? '账号未知'}</td>
            <td>{number(row.requests)}</td><td>{number(row.tool_rounds)} / {number(row.tool_calls)}</td>
            <td>{number(row.tokens?.total_tokens)}</td>
            <td>{number(row.tokens?.input_tokens)} / {number(row.tokens?.cached_input_tokens)}</td>
            <td>{number(row.tokens?.output_tokens)} / {number(row.tokens?.reasoning_output_tokens)}</td>
            <td><span className="session-chat-estimated-cost">{creditsLabel(row.cost)}</span></td>
          </tr>)}
      </DataTable> : <p className="conversation-details-note">暂无可归属的原生请求。</p>}
    </section>
    <section className="conversation-metadata-section" aria-label="缓存命中率异常">
      <h4>缓存命中率下降（{details.summary.cache_drop_count} 次）</h4>
      {drops.length > 0 ? <CacheDropTable drops={drops} /> : <p className="conversation-details-note">已记录的输入中未发现达到规则的下降。</p>}
      {nextCache && <button className="session-chat-older" type="button" disabled={loading !== null} onClick={()=>void load('cache', nextCache)}>更早的缓存异常</button>}
    </section>
    <section className="conversation-metadata-section" aria-label="会话事件">
      <h4>会话事件</h4>
      {events.length > 0 ? <DataTable label="生命周期与输入记录" className="conversation-metadata-scroll" model={lifecycle} minWidth={490}>
          {lifecycle.rows.map(event => <tr key={event.id}>
            <td><MetadataTime at={event.at} /></td>
            <th scope="row">{actions[event.action]} · {states[event.state]}</th>
            <td>{event.evidence === 'native' ? '原生记录' : '平台记录'}</td>
            <td>
              {(event.turn_id || event.execution?.turn_id) && <small>轮次 {event.turn_id || event.execution?.turn_id}</small>}
              {event.message_id && <small>消息 {event.message_id}</small>}
              {event.client_id && <small>提交 ID {event.client_id}</small>}
              {event.related_native_id && <small>关联会话 {event.related_native_id}</small>}
              {event.dimensions && <small>{[event.dimensions.model, event.dimensions.speed, event.dimensions.environment, event.dimensions.account].filter(Boolean).join(' · ')}</small>}
              {event.execution && <>
                {event.execution.last_progress_id && <small>上个 Progress {event.execution.last_progress_id}</small>}
                {event.execution.last_item_id && <small>上个 Item {event.execution.last_item_id}</small>}
                {event.execution.active_item_ids.length > 0 && <small>活动 Item {event.execution.active_item_ids.join('、')}</small>}
                {event.execution.active_tool_ids.length > 0 && <small>活动工具 {event.execution.active_tool_ids.join('、')}</small>}
              </>}
            </td>
          </tr>)}
      </DataTable> : <p className="conversation-details-note">暂无会话事件。</p>}
      {nextEvent && <button className="session-chat-older" type="button" disabled={loading !== null} onClick={()=>void load('event', nextEvent)}>更早的会话事件</button>}
    </section>
    {error && <p role="alert" className="session-chat-error">{error}</p>}
  </>;
}
