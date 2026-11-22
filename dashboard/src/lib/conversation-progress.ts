import type {ConversationCostEstimate,ConversationMessage,ConversationProgressStatistics,ConversationProgressSegment,ConversationStatistics} from './api';
import {isWaitingConversationInput, type TimelineMessage} from './conversation-timeline';

export function mergeConversationStatistics(previous:ConversationStatistics[],incoming:ConversationStatistics[]):ConversationStatistics[] {
  if (!incoming.length) return previous;
  const key = (item:ConversationStatistics) => item.message_id ?? item.turn_id + ':' + item.sequence;
  const result = new Map(previous.map(item => [key(item), item]));
  for (const item of incoming) {
    const id = key(item);
    if ((result.get(id)?.revision ?? 0) <= (item.revision ?? 0)) result.set(id, item);
  }
  return [...result.values()];
}

function costDifference(current: ConversationCostEstimate|null|undefined, previous: ConversationCostEstimate|null|undefined) {
  if (!current || !previous) return current;
  if (!previous.complete || current.unit!==previous.unit || current.basis!==previous.basis ||
      current.amount==null || previous.amount==null || current.amount<previous.amount) return undefined;
  const a=current.breakdown, b=previous.breakdown;
  const breakdown=a&&b&&a.input>=b.input&&a.cache>=b.cache&&a.output>=b.output ? {
    input:a.input-b.input, cache:a.cache-b.cache, output:a.output-b.output,
    reasoning:a.reasoning!=null&&b.reasoning!=null&&a.reasoning>=b.reasoning ? a.reasoning-b.reasoning : null,
  } : undefined;
  return {...current,amount:current.amount-previous.amount,breakdown};
}

/** Difference only matching recorded segment counters, never cumulative totals
 * from different turns or a subtraction of two incomplete lower bounds. */
export function pendingProgressStatistics(live:ConversationProgressStatistics|null,previous:ConversationProgressSegment|undefined,hasPrevious:boolean,boundary?:Pick<ConversationMessage,'id'|'sequence'>):ConversationStatistics|null {
  const step=live?.step;
  if(step&&live?.segment?.id===step.segment_id&&(!hasPrevious?step.after_message_id===null:!!boundary&&(step.after_message_id===boundary.id||step.after_sequence!=null&&step.after_sequence===boundary.sequence))){return {...step,sequence:0,turn_id:live!.turn_id,interval:{...step}};}
  const current=live?.segment;
  if(!current||current.end_reason||hasPrevious&&(!previous||!previous.complete||previous.id!==current.id||previous.start_at!==current.start_at))return null;
  const requests=current.requests-(previous?.requests??0),calls=current.tool_calls-(previous?.tool_calls??0),rounds=current.tool_rounds-(previous?.tool_rounds??0);
  if(Math.min(requests,calls,rounds)<0)return null;
  const tokens=requests&&current.tokens?Object.fromEntries(Object.entries(current.tokens).map(([key,value])=>{
    const before=previous?previous.tokens?.[key]:0;
    return [key,value!=null&&before!=null&&value>=before?value-before:null];
  })):null;
  const cost=previous&&!previous.cost ? current.cost===null?null:undefined : costDifference(current.cost,previous?.cost);
  return {cost,sequence:0,turn_id:live!.turn_id,tokens,requests,tool_calls:calls,tool_rounds:rounds,complete:current.complete,interval:{cost,tokens,requests,tool_calls:calls,tool_rounds:rounds,complete:current.complete,shared_messages:1}};
}

type ConversationGroup={kind:'progress';id:string;messages:ConversationMessage[]}|{kind:'message';id:string;message:ConversationMessage};

export function isEmptyProgress(message:ConversationMessage) {
  return message.role==='assistant'&&message.phase==='commentary'&&message.presentation!=='compaction_summary'&&
    !message.text.trim()&&!message.content_blocks?.length&&!message.async_questions?.length;
}

/** Use recorded Progress ownership when available. With older adapters,
 * accepted inputs and finals provide the presentation boundaries. */
export function groupConversationProgress(messages:TimelineMessage[]):ConversationGroup[] {
  const groups:ConversationGroup[]=[];
  const waitingInputs:ConversationGroup[]=[];
  const byProgressId=new Map<string,{group:Extract<ConversationGroup,{kind:'progress'}>;input:ConversationMessage|undefined}>();
  let lastInput:ConversationMessage|undefined;
  let progressClosed=false;
  for(const message of messages) {
    if (isWaitingConversationInput(message)) {
      waitingInputs.push({kind:'message',id:message.id,message});
      continue;
    }
    const previous=groups.at(-1);
    // A live tool round can carry text only in its content blocks. The same
    // shared presentation rule applies after the platform strips tool data
    // from durable history, so do not require literal message text here.
    if(isEmptyProgress(message))continue;
    const progressMessage=message.role==='assistant' && (message.phase==='commentary' || !message.phase && message.content_blocks?.length) && message.presentation!=='compaction_summary';
    // Consecutive native retry notices in the same turn are updates to one
    // incident. Never infer a relationship across a turn or an intervening
    // message, and keep a different explicit error code as a separate error.
    if(message.role==='assistant' && message.phase==='error' && message.turn_id && previous?.kind==='message' && !progressClosed) {
      const prior=previous.message;
      if(prior.role==='assistant' && prior.phase==='error' && prior.error?.will_retry && prior.turn_id===message.turn_id &&
        (!prior.error.code || !message.error?.code || prior.error.code===message.error.code)) {
        groups[groups.length-1]={...previous,message};
        continue;
      }
    }
    if(progressMessage) {
      const scope=message.statistics?.progress_id;
      const recorded=scope?byProgressId.get(scope):undefined;
      const afterInput=lastInput&&(message.sequence!=null&&lastInput.sequence!=null
        ?message.sequence>lastInput.sequence
        :Date.parse(message.timestamp??'')>=Date.parse(lastInput.timestamp??''));
      const owner=recorded&&(recorded.input===lastInput||!afterInput)?recorded.group:undefined;
      if(owner&&owner!==previous) {
        owner.messages.push(message);
        continue;
      }
      const adjacent=previous?.kind==='progress'&&!progressClosed?previous:undefined;
      const group=owner??adjacent??{kind:'progress' as const,id:message.id,messages:[]};
      group.messages.push(message);
      if(!owner&&!adjacent)groups.push(group);
      if(scope&&!owner)byProgressId.set(scope,{group,input:lastInput});
      progressClosed=!!(message.phase==='final'||message.phase==='error'||message.presentation==='compaction_summary'||message.async_questions?.length);
    }else {
      groups.push({kind:'message',id:message.id,message});
      if(message.role==='user')lastInput=message;
      progressClosed=!(message.role==='assistant'&&message.phase==='error'&&message.error?.will_retry);
    }
  }
  return [...groups,...waitingInputs];
}

function aggregateCost(segments:ConversationProgressSegment[]):ConversationCostEstimate|null|undefined {
  const costs=segments.map(segment=>segment.cost);
  if(costs.every(cost=>cost===null))return null;
  const estimates=costs.filter((cost):cost is ConversationCostEstimate=>!!cost);
  const latest=estimates.at(-1);
  if(!latest||estimates.some(cost=>cost.unit!==latest.unit||cost.basis!==latest.basis))return undefined;
  const priced=estimates.filter(cost=>cost.amount!==null);
  const breakdowns=priced.flatMap(cost=>cost.breakdown?[cost.breakdown]:[]);
  const breakdown=breakdowns.length>0&&breakdowns.length===priced.length?{
    input:breakdowns.reduce((sum,value)=>sum+value.input,0),
    cache:breakdowns.reduce((sum,value)=>sum+value.cache,0),
    output:breakdowns.reduce((sum,value)=>sum+value.output,0),
    reasoning:breakdowns.every(value=>value.reasoning!==null)?breakdowns.reduce((sum,value)=>sum+value.reasoning!,0):null,
  }:undefined;
  const amount=priced.length?priced.reduce((sum,value)=>sum+value.amount!,0):null;
  const complete=segments.every(segment=>!segment.requests||segment.cost?.complete===true);
  return {...latest,amount,complete,breakdown};
}

function aggregateSegments(segments:ConversationProgressSegment[]):ConversationProgressSegment {
  if(segments.length===1)return segments[0];
  const tokenKeys=new Set(segments.flatMap(segment=>Object.keys(segment.tokens||{})));
  const tokens=tokenKeys.size?Object.fromEntries([...tokenKeys].map(key=>[
    key,segments.some(segment=>segment.tokens?.[key]!=null)
      ?segments.reduce((sum,segment)=>sum+(segment.tokens?.[key]??0),0):null,
  ])):null;
  const reasons=[...new Set(segments.flatMap(segment=>segment.reasons||[]))];
  const newest=segments.at(-1)!;
  const complete=segments.every(segment=>segment.complete);
  const coverage=segments.some(segment=>segment.coverage)
    ?complete?'complete':segments.some(segment=>segment.coverage==='partial'||segment.coverage==='unavailable')?'partial':'pending'
    :undefined;
  const starts=segments.map(segment=>segment.start_at).filter((value):value is string=>!!value).sort();
  const ends=segments.map(segment=>segment.end_at).filter((value):value is string=>!!value).sort();
  return {
    ...newest,
    start_at:starts[0]??null,
    end_at:segments.every(segment=>segment.end_at)?ends.at(-1)??null:null,
    elapsed_ms:segments.every(segment=>segment.elapsed_ms!=null)
      ?segments.reduce((sum,segment)=>sum+segment.elapsed_ms!,0):null,
    tokens,
    requests:segments.reduce((sum,segment)=>sum+segment.requests,0),
    tool_calls:segments.reduce((sum,segment)=>sum+segment.tool_calls,0),
    tool_rounds:segments.reduce((sum,segment)=>sum+segment.tool_rounds,0),
    complete,coverage,
    ...(reasons.length?{reasons}:{}),
    cost:aggregateCost(segments),
  };
}

/** Merge distinct recorded segments in a presentation group. Repeated message
 * snapshots share a segment ID and count once. */
export function progressGroupStatistics(messages:ConversationMessage[],final?:ConversationMessage|null,current?:ConversationProgressSegment):ConversationStatistics|null {
  const segments=new Map<string,{segment:ConversationProgressSegment;revision:number}>();
  for(const message of messages) {
    const statistics=message.statistics;
    const segment=statistics?.segment;
    const revision=statistics?.revision??0;
    if(segment&&revision>=(segments.get(segment.id)?.revision??0))segments.set(segment.id,{segment,revision});
  }
  const finalSegment=final?.statistics?.segment;
  const finalRevision=final?.statistics?.revision??0;
  if(finalSegment&&segments.has(finalSegment.id)&&finalRevision>=(segments.get(finalSegment.id)?.revision??0))segments.set(finalSegment.id,{segment:finalSegment,revision:finalRevision});
  if(current)segments.set(current.id,{segment:current,revision:0});
  if(segments.size) {
    const segment=aggregateSegments([...segments.values()].map(value=>value.segment));
    const interval={...segment,shared_messages:1};
    const last=messages.at(-1);
    return {...segment,sequence:0,turn_id:last?.statistics?.turn_id||final?.turn_id||last?.turn_id||'',interval,segment};
  }
  const recent=messages.slice().reverse();
  for(const message of final?[...recent,final]:recent)
    if(message.statistics&&!message.statistics.interval?.coverage)return {...message.statistics,sequence:0};
  return null;
}

export function isThinkingOnly(message:ConversationMessage) {
  return message.role==='assistant' && !message.text.trim() && !!message.content_blocks?.length &&
    message.content_blocks.every(block=>block.type==='thinking');
}

/** The preview follows the latest reasoning. The disclosure keeps earlier
 * parts of the same Progress group, including those before a tool call. */
export function progressThinking(messages: ConversationMessage[]) {
  const parts: string[] = [];
  let latest: {text:string;messageId:string;atTail:boolean}|undefined;
  let remaining = 64 * 1024;
  for (const message of messages.slice().reverse()) {
    const blocks = message.content_blocks ?? [];
    for (const block of blocks.slice().reverse()) {
      if (block.type !== 'thinking' || !block.text.trim()) continue;
      latest ??= {text:block.text,messageId:message.id,atTail:message===messages.at(-1)&&block===blocks.at(-1)};
      parts.push(block.text.slice(-remaining));
      remaining -= Math.min(remaining,block.text.length+1);
      if (!remaining) break;
    }
    if (!remaining) break;
  }
  return latest ? {...latest,body:parts.reverse().join('\n')} : null;
}

/** Keep tool calls and commentary text on their numbered items, while all
 * request-level reasoning moves to one platform-level row. Thinking-only
 * requests do not occupy empty numbered rows. The blocks stay in durable
 * messages for reconciliation and are not discarded. */
export function withoutProgressThinking(messages:ConversationMessage[]):ConversationMessage[] {
  return messages.flatMap(message=>{
    const content_blocks=message.content_blocks?.filter(block=>block.type!=='thinking');
    if(!message.text.trim()&&!content_blocks?.some(block=>block.type==='tool_use'||block.text.trim()))return [];
    return [{...message,...(content_blocks?{content_blocks}:{})}];
  });
}

export function withObservedToolCounts(statistics:ConversationStatistics|null,count:number,turnId:string):ConversationStatistics|null {
 if(statistics&&(statistics.coverage||statistics.interval?.coverage))return statistics;
 if(!count||statistics&&('segment_id' in statistics||statistics.tool_calls>=count))return statistics;
 const value=statistics?.interval??statistics;
 const interval={...value,tokens:value?.tokens??null,requests:value?.requests??0,tool_calls:Math.max(value?.tool_calls??0,count),tool_rounds:Math.max(value?.tool_rounds??0,1),complete:false,shared_messages:1};
 return {...statistics,...interval,sequence:0,turn_id:turnId,interval};
}
