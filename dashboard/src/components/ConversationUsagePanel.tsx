import type {ConversationControlsData} from '../lib/api';
import {formatConversationTimestamp} from '../lib/conversation-timing';
import {DataTable} from './table/DataTable';
import {useTableModel} from './table/use-table-model';
import './ConversationUsagePanel.css';

const number=(value:number|null|undefined)=>value==null?'未提供':value.toLocaleString('zh-CN');
const short=(value:number|null|undefined)=>value==null?'—':new Intl.NumberFormat('en',{notation:'compact',maximumFractionDigits:1}).format(value);
function cache(input:number|null|undefined,hit:number|null|undefined) {
  return input!=null&&hit!=null&&input>0&&hit>=0&&hit<=input?{percent:100*hit/input,miss:input-hit}:null;
}

export function ConversationUsagePanel({usage,observedAt}:{usage:ConversationControlsData['usage'];observedAt:string|null}) {
  const recent=cache(usage?.last.input_tokens,usage?.last.cached_input_tokens),total=cache(usage?.total.input_tokens,usage?.total.cached_input_tokens);
  const context=usage?.window&&usage.last.total_tokens!=null?100*usage.last.total_tokens/usage.window:null;
  const percent=(value:number|null|undefined)=>value==null?'—':`${value.toFixed(1)}%`;
  const rows=[['总量','total_tokens'],['输入','input_tokens'],['缓存命中输入','cached_input_tokens'],['输出（包含推理）','output_tokens'],['其中：推理输出','reasoning_output_tokens']].map(([label,key])=>({label,key,last:usage?.last[key],total:usage?.total[key]}));
  const table=useTableModel(rows,[{key:'label',title:'指标',value:row=>row.label},{key:'last',title:'最近一次请求',kind:'number',value:row=>row.last},{key:'total',title:'会话累计',kind:'number',value:row=>row.total}]);
  return <section className="conversation-usage-panel" aria-label="Token 用量">
    <header className="conversation-usage-header"><div><h4>Token 用量</h4><p>先看当前占用与缓存效果，详细计数按需展开。</p></div><span className="conversation-usage-live">随会话实时更新</span></header>
    {!usage?<p className="conversation-controls-note">暂无用量记录，收到原生用量事件后会自动显示。</p>:<>
      <div className="conversation-usage-cards">
        <div className="conversation-usage-card" aria-label="上下文占用"><span>上下文占用</span><strong>{percent(context)}</strong><small>最近请求 {number(usage.last.total_tokens)} / 窗口 {number(usage.window)}</small>
          <div className="conversation-usage-track" role="meter" aria-label="上下文占用比例" aria-valuemin={0} aria-valuemax={100} aria-valuenow={context==null?undefined:Math.min(100,context)} aria-valuetext={percent(context)}><i style={{width:`${Math.min(100,context||0)}%`}}/></div>
        </div>
        <div className="conversation-usage-card cache" aria-label="本次缓存命中率"><span>本次缓存命中率</span><strong>{percent(recent?.percent)}</strong><small>已命中输入 ÷ 本次全部输入</small><p>{recent?'命中的部分可复用已有计算':'尚无完整输入计数'}</p></div>
        <div className="conversation-usage-card small"><span>本次输出</span><strong title={number(usage.last.output_tokens)}>{short(usage.last.output_tokens)} <em>Token</em></strong><small>其中推理输出 {number(usage.last.reasoning_output_tokens)}，已包含在输出中</small></div>
        <div className="conversation-usage-card small"><span>累计缓存命中率</span><strong>{percent(total?.percent)}</strong><small>按会话全部输入加权计算，不是每次百分比的平均值</small></div>
      </div>
      <div className="conversation-usage-input">
        <div className="conversation-usage-input-heading"><strong>这次输入如何处理</strong><span>共 {number(usage.last.input_tokens)} Token</span></div>
        <div className="conversation-usage-stacked" role="img" aria-label={recent?`本次输入缓存命中 ${recent.percent.toFixed(1)}%，未命中 ${number(recent.miss)} Token`:'缓存占比数据未提供'}>
          {recent&&<><i className="hit" style={{width:`${recent.percent}%`}}/><i className="miss" style={{width:`${100-recent.percent}%`}}/></>}
        </div>
        <div className="conversation-usage-legend"><span><i className="hit"/>命中缓存 <b>{number(usage.last.cached_input_tokens)}</b></span><span><i className="miss"/>未命中输入 <b>{number(recent?.miss)}</b></span></div>
      </div>
      <details className="conversation-usage-details"><summary>查看完整用量明细</summary>
        <p className="conversation-controls-note">“会话累计”是多次请求相加，可能大于上下文窗口，不代表当前占用。</p>
        <DataTable label="Token 用量明细" model={table} minWidth={420} className="conversation-usage-table">
          {table.rows.map(row=><tr key={row.key}><td>{row.label}</td><td>{number(row.last)}</td><td>{number(row.total)}</td></tr>)}
        </DataTable>
      </details>
    </>}
    <footer className="conversation-usage-updated">用量记录时间：{formatConversationTimestamp(observedAt)}</footer>
  </section>;
}
