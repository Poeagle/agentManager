import type {ConversationControlsData} from '../lib/api';
import {formatConversationTimestamp} from '../lib/conversation-timing';
import {DataTable} from './table/DataTable';
import {useTableModel} from './table/use-table-model';
import {Fragment} from 'react';
import './ConversationDetailsPanel.css';
import {coverageReason,coverageText,creditsLabel,recordedCachePercent,type SessionMetadata} from '../lib/session-metadata';

export interface ConversationDetailRuntimeRow {
  label:string;
  value:string|null|undefined;
  detail?:string|null;
}

const number=(value:number|null|undefined)=>value==null?'未提供':value.toLocaleString('zh-CN');
const percent=(value:number|null|undefined)=>value==null?'—':`${value.toFixed(1)}%`;
const cumulative=(value:number|null|undefined)=>value==null?'累计 未提供':`累计 ${number(value)}`;

function cache(input:number|null|undefined,hit:number|null|undefined) {
  return input!=null&&hit!=null&&input>0&&hit>=0&&hit<=input?100*hit/input:null;
}

export function ConversationDetailsPanel({usage,observedAt,runtime,nativeId,limits,checkedAt,metadata}:{
  usage:ConversationControlsData['usage'];
  observedAt:string|null;
  runtime:ConversationDetailRuntimeRow[];
  nativeId:string;
  limits:ConversationControlsData['limits'];
  checkedAt:string|null;
  metadata?:SessionMetadata|null;
}) {
  const recent=metadata?metadata.latest?.tokens:usage?.last;
  const total=metadata?metadata.totals?.tokens:usage?.total;
  const recentCache=metadata?recordedCachePercent(recent):cache(recent?.input_tokens,recent?.cached_input_tokens);
  const totalCache=metadata?metadata.reasons.some(reason=>reason==='missing_usage'||reason==='counter_mismatch')
    ? null:recordedCachePercent(total):cache(total?.input_tokens,total?.cached_input_tokens);
  const context=usage?.window&&usage.last.total_tokens!=null?100*usage.last.total_tokens/usage.window:null;
  const rows:ConversationDetailTableRow[]=[
    {key:'usage',label:'Token 用量',group:true},
    ...(usage||metadata?[
      {key:'usage.total',label:'总量 Token',value:number(recent?.total_tokens),detail:cumulative(total?.total_tokens)},
      {key:'usage.input',label:'输入 Token',value:number(recent?.input_tokens),detail:cumulative(total?.input_tokens)},
      {key:'usage.cached',label:'缓存命中输入',value:number(recent?.cached_input_tokens),detail:cumulative(total?.cached_input_tokens)},
      {key:'usage.output',label:'输出 Token',value:number(recent?.output_tokens),detail:cumulative(total?.output_tokens)},
      {key:'usage.reasoning',label:'推理输出',value:number(recent?.reasoning_output_tokens),detail:`${cumulative(total?.reasoning_output_tokens)}（含在输出内）`},
      {key:'usage.context',label:'上下文占用',value:percent(context),detail:`${number(usage?.last.total_tokens)} / ${number(usage?.window)}`},
      {key:'usage.recent-cache',label:'本次缓存命中率',value:percent(recentCache)},
      {key:'usage.total-cache',label:'累计缓存命中率',value:percent(totalCache),detail:'按全部输入加权'},
    ]:[{key:'usage.empty',label:'用量记录',value:'暂无',detail:'收到原生用量事件后会自动显示'}]),
    ...(metadata?[
      {key:'statistics',label:'会话累计与覆盖范围',group:true},
      {key:'statistics.coverage',label:'记录覆盖',value:coverageText[metadata.status],detail:metadata.reasons.map(reason=>coverageReason[reason]).join('、')},
      {key:'statistics.credits',label:'预估积分',value:creditsLabel(metadata.totals?.cost),detail:`按每笔请求的模型与速度估算${metadata.totals?.cost?.rate_date?'，参考费率日期 '+metadata.totals.cost.rate_date:''}${metadata.totals?.cost&&!metadata.totals.cost.complete?'，* 费率或用量覆盖不完整':''}`},
      {key:'statistics.runs',label:'模型请求（Runs）',value:number(metadata.totals?.requests),detail:'已记录的原生模型请求'},
      {key:'statistics.turns',label:'用户输入 / 已完成问答',value:`${number(metadata.user_inputs)} / ${number(metadata.completed_turns)}`,detail:'按原生确认的输入和已产生 Final 的问答统计'},
      {key:'statistics.tools',label:'工具轮次 / 调用',value:`${number(metadata.totals?.tool_rounds)} / ${number(metadata.totals?.tool_calls)}`,detail:'同一响应中的并行调用计各自的次数，共计一轮'},
      {key:'statistics.cache',label:'缓存命中率下降',value:number(metadata.cache_drop_count),detail:'逐条记录见下表'},
    ]:[]),
    {key:'runtime',label:'运行环境',group:true},
    ...runtime.map((row,index)=>({key:`runtime.${index}`,...row})),
    ...(limits.length>0?[
      {key:'limits',label:'可用额度',group:true},
      ...limits.map((limit,index)=>({
        key:`limits.${index}`,
        label:limit.minutes>=6*24*60?'周额度':limit.minutes>=60?`${limit.minutes/60} 小时额度`:`${limit.minutes} 分钟额度`,
        value:`剩余 ${Math.round(100-limit.used_percent)}%`,
        detail:limit.resets_at?`重置 ${new Date(limit.resets_at*1000).toLocaleString('zh-CN',{hour12:false})}`:'未提供重置时间',
      })),
    ]:[]),
    {key:'records',label:'记录',group:true},
    {key:'records.usage',label:'用量记录时间',value:formatConversationTimestamp(metadata?metadata.latest?.at:observedAt)},
    {key:'records.checked',label:'信息读取时间',value:formatConversationTimestamp(checkedAt)},
    {key:'records.native',label:'原生会话编号',value:nativeId},
  ];
  const table=useTableModel(rows,[
    {key:'label',title:'信息项',value:row=>row.group?null:row.label},
    {key:'value',title:'当前值',value:row=>row.group?null:row.value},
    {key:'detail',title:'补充 / 会话累计',value:row=>row.group?null:row.detail},
  ]);
  return <section className="conversation-details-panel" aria-label="用量与运行环境">
    <header className="conversation-details-header">
      <h4>用量与运行环境</h4>
      <span className="conversation-details-live">随会话实时更新</span>
    </header>
    <DataTable label="Token 用量与运行环境" model={table} minWidth={420} className="conversation-details-table">
      {table.rows.map(row=><Fragment key={row.key}>
        {row.group?<tr><th className="conversation-details-group" colSpan={3} scope="colgroup">{row.label}</th></tr>
          :<tr><th scope="row">{row.label}</th><td className={row.key==='statistics.credits'?'session-chat-estimated-cost':undefined}>{row.value||'未提供'}</td><td>{row.detail??''}</td></tr>}
      </Fragment>)}
    </DataTable>
    <p className="conversation-details-note">当前值取最近一次请求；会话累计为多次请求相加，可能超过上下文窗口。未提供的数据不作估算。</p>
  </section>;
}

interface ConversationDetailTableRow {
  key:string;
  label:string;
  value?:string|null;
  detail?:string|null;
  group?:boolean;
}
