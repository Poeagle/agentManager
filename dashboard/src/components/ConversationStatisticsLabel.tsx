import {Fragment} from 'react';
import type {ConversationMessage,ConversationStatistics} from '../lib/api';
import {formatConversationTimestamp} from '../lib/conversation-timing';
import {coverageReason,intervalCoverageText,recordedCachePercent,uncachedInputTokens} from '../lib/session-metadata';
const number=(value:number)=>new Intl.NumberFormat('en',{notation:'compact',maximumFractionDigits:1}).format(value);
const valid=(value:number|null|undefined)=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
/** Every displayed field belongs to the same recorded interval. Cache hit is a
 * ratio of those counters; neither reasoning nor cached input is added twice. */
export function ConversationStatisticsLabel({statistics,interval=false,progress=false}:{statistics:ConversationStatistics|null;interval?:boolean;progress?:boolean}) {
 const recorded=statistics?.interval,summary=!interval?statistics?.conclusion:undefined;
 const part=interval?recorded:summary,value=part??statistics,shared=!!part&&part.shared_messages>1;
 const complete=value?.complete??false,tokens=value?.tokens;
 const coverage=value?.coverage, pending=coverage==='pending';
 const coverageLabel=coverage&&intervalCoverageText(coverage,value?.reasons);
 if(interval&&recorded?.shared_reference)return <span className="session-chat-message-statistics" title="请求用量已计入同组 Item">共享请求</span>;
 if(pending&&!tokens&&!value?.requests&&!value?.tool_calls){
  return <span className="session-chat-message-statistics session-chat-statistics-coverage"
    title="原生用量回执到达后自动更新。">{coverageLabel}</span>;
 }
 const totalInput=valid(tokens?.input_tokens),cached=valid(tokens?.cached_input_tokens),output=valid(tokens?.output_tokens);
 const inputsKnown=!value?.reasons?.some(reason=>reason==='missing_usage'||reason==='counter_mismatch');
 const input=inputsKnown?uncachedInputTokens(tokens):null;
 const hit=!inputsKnown?null:coverage?recordedCachePercent(tokens):totalInput!==null&&totalInput>0&&cached!==null&&cached<=totalInput?cached/totalInput*100:null;
 const hitText=hit===null?'—':new Intl.NumberFormat('en',{maximumFractionDigits:2}).format(hit)+'%';
 const partialPrefix=!coverage&&!complete?'≥':'';
 const count=(n:number|null|undefined)=>valid(n)===null||!complete&&!value?.requests&&n===0?'—':partialPrefix+n;
 const formatted=(value:number|null|undefined)=>{const n=valid(value);return n===null?'—':partialPrefix+number(n);};
 const cost=value?.cost,includeCost=cost!==null,costValue=valid(cost?.amount);
 const costLabel=cost?.unit==='USD'?'Est. $':cost&&cost.unit!=='credits'?'Est. cost':'Est. Cr';
 const exact=(value:number|null|undefined)=>valid(value)===null?'unknown':new Intl.NumberFormat('en').format(value!);
 const title=[
  summary?'Usage between completed Final boundaries.':progress?'Usage for the Items in this Progress.':part?'Usage for this Item.':'Cumulative usage for this native turn (legacy snapshot).',
  `Total ${exact(tokens?.total_tokens)}; Input ${exact(input)} (uncached); Cache ${exact(cached)}; total input ${exact(totalInput)}; cache hit ${hitText}; Reasoning ${exact(tokens?.reasoning_output_tokens)} (included in Output); Output ${exact(output)}.`,
  shared?`${part?.shared_messages} updates share the same model request. Per-update usage cannot be split reliably; this request group used ${tokens?.total_tokens==null?'unknown':number(tokens.total_tokens)} tokens.`:'',
  coverage&&coverage!=='complete'?coverageLabel+'。'+(value?.reasons??[]).map(reason=>coverageReason[reason]).join('、'):!complete?'Partial recorded interval: ≥ marks a lower bound.':'',
  'Rounds count recorded model requests. Calls count native tool calls. One request issuing three tools is 1 round | 3 calls.',
  includeCost?`Estimated ${cost?.unit??'credits'}: ${costValue??'unknown'}; rate date ${cost?.rate_date??'unknown'}. ${costValue===null?'Pricing is unavailable until usage and supported model/speed settings are recorded. ':''}Input credits exclude cached input; reasoning credits are included in output credits. Per-request model and speed are used before aggregation. * marks incomplete usage or pricing coverage. Subscription-reference estimates are not an invoice. API pricing is separate.`:'No credit estimate applies to this engine.',
 ].filter(Boolean).join(' ');
 const amount=(n:number|null|undefined)=>{const v=valid(n);return v===null?'—':`${v>0&&v<.001?'<0.001':new Intl.NumberFormat('en',{maximumFractionDigits:3}).format(v)}${cost?.complete&&complete?'':'*'}`;};
 const credit=(n:number|null|undefined,label:string)=> <span className="session-chat-estimated-cost" title={label}>{amount(n)}</span>;
 const breakdown=cost?.breakdown;
 const values=[<Fragment key="total">{formatted(tokens?.total_tokens)}{includeCost&&<> ({credit(costValue,'Estimated total credits')})</>}</Fragment>,<Fragment key="input">{formatted(input)}{breakdown&&<> ({credit(breakdown.input,'Estimated uncached input credits')})</>}</Fragment>,<Fragment key="cache">{formatted(cached)}{cached!==null&&<> ({breakdown&&<>{credit(breakdown.cache,'Estimated cached input credits')} | </>}<span className="session-chat-cache-hit" title={`Cache hit rate = cached input / input: ${hitText}${!complete?' (recorded requests only)':''}`} style={{color:hit===null?'var(--text-muted)':`hsl(${Math.round(hit*1.4)} 60% var(--cache-hit-lightness, 32%))`}}>{hitText}</span>)</>}</Fragment>,<Fragment key="reasoning">{formatted(tokens?.reasoning_output_tokens)}{breakdown&&<> ({credit(breakdown.reasoning,'Estimated reasoning credits, included in output')})</>}</Fragment>,<Fragment key="output">{formatted(output)}{breakdown&&<> ({credit(breakdown.output,'Estimated output credits, including reasoning')})</>}</Fragment>];
 return <span className="session-chat-message-statistics" title={title}>
  {coverage&&coverage!=='complete'&&<span className="session-chat-statistics-coverage">{coverageLabel} · </span>}
  {shared&&<span>Shared request · </span>}
  <span>Total｜Input｜Cache｜Reasoning｜Output{includeCost?`｜${costLabel}`:''} : </span>
  {values.map((value,index)=><Fragment key={index}>{index>0&&'｜'}{value}</Fragment>)} · <span className="session-chat-tool-counts">
   {count(value?.requests)} {value?.requests===1?'round':'rounds'} | {count(value?.tool_calls)} {value?.tool_calls===1?'call':'calls'}
  </span>
 </span>;
}
export function englishMetadataDuration(label:string){return label.replace('本轮耗时 ','Total time: ').replace('耗时 ','Elapsed: ').replace('距上次更新 ','Since last update: ').replace(/(\d+)时/g,'$1h ').replace(/(\d+)分/g,'$1m ').replace(/(\d+)秒/g,'$1s').trim();}
export function metadataDurationTitle(phase:ConversationMessage['phase']) {return phase==='final'?'Time from the previous conclusion completing to this conclusion completing, including time waiting for input, tools and retries. The first conclusion starts at the first task.':'Time between native progress updates, including tools and waits; not text-generation time.';}
export function metadataTimestampTitle(message:ConversationMessage,compact:boolean){return `${compact?'Progress completion time':'Native message time'}: ${formatConversationTimestamp(message.timestamp)} (browser time · ${Intl.DateTimeFormat().resolvedOptions().timeZone})`;}
