import type {ConversationMessage,ConversationStatistics} from '../lib/api';
import {formatConversationTimestamp} from '../lib/conversation-timing';
interface Interval {
  tokens:Record<string,number|null>|null;requests:number;tool_calls:number;tool_rounds:number;complete:boolean;shared_messages:number;
}
const number=(value:number)=>new Intl.NumberFormat('en',{notation:'compact',maximumFractionDigits:1}).format(value);
/** New servers supply stable request-bound intervals, including after paging or
 * cache eviction. Older snapshots remain explicitly labelled as turn totals. */
export function ConversationStatisticsLabel({statistics,interval=false}:{statistics:ConversationStatistics;interval?:boolean}) {
  const recorded=(statistics as ConversationStatistics&{interval?:Interval}).interval;
  const part=interval?recorded:undefined;
  const value=part??statistics,shared=!!part&&part.shared_messages>1;
  const scope=part?'step':recorded?'turn':'';
  const token=value.tokens?.total_tokens;
  const calls=shared?'shared':`${value.complete?'':'≥'}${value.tool_calls}`;
  const rounds=shared?'shared':`${value.complete?'':'≥'}${value.tool_rounds}`;
  const title=[
    part?'Usage since the previous progress request completed, through this update’s request completion.':'Cumulative usage for this native turn through this message’s model request.',
    shared?`${part?.shared_messages} updates share the same model request. Per-update usage cannot be split reliably; this request group used ${token==null?'unknown':number(token)} tokens and ${value.tool_calls} tool calls in ${value.tool_rounds} rounds.`:'',
    !value.complete?'Partial log window: ≥ marks a recorded lower bound. Missing token data is shown as —.':'',
    `${value.requests} model requests; ${value.tool_calls} native tool calls; ${value.tool_rounds} tool rounds. Parallel calls in one model response count as one round; code-mode internals are not expanded.`,
    'Tokens include repeated context, cached input and reasoning. This is not the cost of generating this text alone or a monetary charge.',
  ].filter(Boolean).join(' ');
  return <span className="session-chat-message-statistics" title={title}>{scope&&`${scope} · `}token: {shared?'shared':token==null?'—':`${value.complete?'':'≥'}${number(token)}`} · tools: {shared?'shared':part||!interval?`${calls} ${value.tool_calls===1?'call':'calls'} / ${rounds} ${value.tool_rounds===1?'round':'rounds'}`:`${calls}/${rounds}`}</span>;
}
export function englishMetadataDuration(label:string){return label.replace('本轮耗时 ','Total: ').replace('耗时 ','Elapsed: ').replace('距上次更新 ','Since last update: ').replace(/(\d+)时/g,'$1h ').replace(/(\d+)分/g,'$1m ').replace(/(\d+)秒/g,'$1s').trim();}
export function metadataDurationTitle(phase:ConversationMessage['phase']) {return phase==='final'?'Time from the latest user message to this reply, including tools and waits.':'Time between native progress updates, including tools and waits; not text-generation time.';}
export function metadataTimestampTitle(message:ConversationMessage,compact:boolean){return `${compact?'Progress completion time':'Native message time'}: ${formatConversationTimestamp(message.timestamp)} (browser time · ${Intl.DateTimeFormat().resolvedOptions().timeZone})`;}
