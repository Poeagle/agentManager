import {Fragment} from 'react';
import type {ConversationMessage,ConversationStatistics} from '../lib/api';
import {formatConversationTimestamp} from '../lib/conversation-timing';
const number=(value:number)=>new Intl.NumberFormat('en',{notation:'compact',maximumFractionDigits:1}).format(value);
const valid=(value:number|null|undefined)=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
/** Every displayed field belongs to the same recorded interval. Cache hit is a
 * ratio of those counters; neither reasoning nor cached input is added twice. */
export function ConversationStatisticsLabel({statistics,interval=false,scope}:{statistics:ConversationStatistics|null;interval?:boolean;scope?:string}) {
 const recorded=statistics?.interval,summary=!interval?statistics?.conclusion:undefined;
 const part=interval?recorded:summary,value=part??statistics,shared=!!part&&part.shared_messages>1;
 const prefix=scope??(summary?'summary':part?'step':recorded?'turn':statistics?'':'step');
 const complete=value?.complete??false,tokens=value?.tokens;
 const input=valid(tokens?.input_tokens),cached=valid(tokens?.cached_input_tokens),output=valid(tokens?.output_tokens);
 const hit=input!==null&&input>0&&cached!==null&&cached<=input?cached/input*100:null;
 const hitText=hit===null?'—':new Intl.NumberFormat('en',{maximumFractionDigits:2}).format(hit)+'%';
 const formatted=(value:number|null|undefined)=>{const n=valid(value);return n===null?'—':`${complete?'':'≥'}${number(n)}`;};
 const cost=value?.cost,includeCost=cost!==null,costValue=valid(cost?.amount);
 const costLabel=cost?.unit==='USD'?'Est. $':cost&&cost.unit!=='credits'?'Est. cost':'Est. Cr';
 const costText=costValue===null?'—':`${costValue>0&&costValue<.001?'<0.001':new Intl.NumberFormat('en',{maximumFractionDigits:3}).format(costValue)}${cost?.complete&&complete?'':'*'}`;
 const exact=(value:number|null|undefined)=>valid(value)===null?'unknown':new Intl.NumberFormat('en').format(value!);
 const title=[
  prefix==='segment'?'Recorded usage for this input segment.':summary?'Usage since the previous conclusion completed, through this conclusion’s request completion.':part?'Usage since the previous progress request completed, through this update’s request completion.':'Cumulative usage for this native turn (legacy snapshot).',
  `Total ${exact(tokens?.total_tokens)}; Input ${exact(input)} (includes cached input); Cache ${exact(cached)}; cache hit ${hitText}; Reasoning ${exact(tokens?.reasoning_output_tokens)} (included in Output); Output ${exact(output)}.`,
  shared?`${part?.shared_messages} updates share the same model request. Per-update usage cannot be split reliably; this request group used ${tokens?.total_tokens==null?'unknown':number(tokens.total_tokens)} tokens.`:'',
  !complete?'Partial recorded interval: ≥ marks a lower bound. Missing token data remains unknown.':'',
  `${value?.tool_rounds??'unknown'} native tool rounds; ${value?.tool_calls??'unknown'} native tool calls. One model response calling three parallel tools is 1 round | 3 calls. Code-mode internals are not expanded.`,
  includeCost?`Estimated ${cost?.unit??'credits'}: ${costValue??'unknown'}; rate date ${cost?.rate_date??'unknown'}. Per-request model and speed are used before aggregation. * means partial pricing or an assumed Standard speed. Subscription-reference estimates are not an invoice. API pricing is separate.`:'No credit estimate applies to this engine.',
 ].filter(Boolean).join(' ');
 const values=[formatted(tokens?.total_tokens),formatted(input),<Fragment key="cache">{formatted(cached)}{cached!==null&&<> (<span className="session-chat-cache-hit" title={`Cache hit rate = cached input / input: ${hitText}${!complete?' (recorded requests only)':''}`} style={{color:hit===null?'var(--text-muted)':`hsl(${Math.round(hit*1.4)} 60% var(--cache-hit-lightness, 32%))`}}>{hitText}</span>)</>}</Fragment>,formatted(tokens?.reasoning_output_tokens),formatted(output),...includeCost?[costText]:[]];
 return <span className="session-chat-message-statistics" title={title}>{prefix&&`${prefix} · `}{shared?'Shared request':<><span>Total｜Input｜Cache｜Reasoning｜Output{includeCost?`｜${costLabel}`:''} : </span>{values.map((value,index)=><Fragment key={index}>{index>0&&'｜'}{value}</Fragment>)} · {value?`${complete?'':'≥'}${value.tool_rounds} ${value.tool_rounds===1?'round':'rounds'} | ${complete?'':'≥'}${value.tool_calls} ${value.tool_calls===1?'call':'calls'}`:'— rounds | — calls'}</>}</span>;
}
export function englishMetadataDuration(label:string){return label.replace('本轮耗时 ','Total: ').replace('耗时 ','Elapsed: ').replace('距上次更新 ','Since last update: ').replace(/(\d+)时/g,'$1h ').replace(/(\d+)分/g,'$1m ').replace(/(\d+)秒/g,'$1s').trim();}
export function metadataDurationTitle(phase:ConversationMessage['phase']) {return phase==='final'?'Time from the previous conclusion completing to this conclusion completing, including time waiting for input, tools and retries. The first conclusion starts at the first task.':'Time between native progress updates, including tools and waits; not text-generation time.';}
export function metadataTimestampTitle(message:ConversationMessage,compact:boolean){return `${compact?'Progress completion time':'Native message time'}: ${formatConversationTimestamp(message.timestamp)} (browser time · ${Intl.DateTimeFormat().resolvedOptions().timeZone})`;}
