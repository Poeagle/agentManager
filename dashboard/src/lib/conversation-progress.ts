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
  const byProgressId=new Map<string,Extract<ConversationGroup,{kind:'progress'}>>();
  const groupScope=new Map<ConversationGroup,string>();
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
      const owner=scope?byProgressId.get(scope):undefined;
      if(owner&&owner!==previous) {
        owner.messages.push(message);
        continue;
      }
      const priorScope=previous&&groupScope.get(previous);
      const adjacent=previous?.kind==='progress'&&!progressClosed&&(!scope||!priorScope||scope===priorScope)?previous:undefined;
      const group=owner??adjacent??{kind:'progress' as const,id:message.id,messages:[]};
      group.messages.push(message);
      if(!owner&&!adjacent)groups.push(group);
      if(scope&&!owner){byProgressId.set(scope,group);groupScope.set(group,scope);}
      progressClosed=!!(message.phase==='final'||message.phase==='error'||message.presentation==='compaction_summary'||message.async_questions?.length);
    }else {
      groups.push({kind:'message',id:message.id,message});
      progressClosed=!(message.role==='assistant'&&message.phase==='error'&&message.error?.will_retry);
    }
  }
  return [...groups,...waitingInputs];
}

/** Select the most specific recorded usage for a presentation group. Segment
 * counters describe the current input interval; native turn totals remain a
 * valid fallback for adapters that cannot record segment timings. */
export function progressGroupStatistics(messages:ConversationMessage[],final?:ConversationMessage|null):ConversationStatistics|null {
  const recent=messages.slice().reverse();
  for(const message of final?[...recent,final]:recent) {
    const statistics=message.statistics;
    if(statistics?.segment)return {...statistics,...statistics.segment,sequence:0,turn_id:statistics.turn_id||final?.turn_id||message.turn_id||'',interval:{...statistics.segment,shared_messages:1}};
  }
  for(const message of final?[final,...messages.slice().reverse()]:messages.slice().reverse())
    if(message.statistics&&!message.statistics.interval?.coverage)return {...message.statistics,sequence:0};
  return null;
}

/** Claude sends a separate thinking block for each model request in one
 * native turn. Progress is a platform-level execution view, so expose only the
 * newest reasoning snapshot there and replace it as new updates arrive. */
export function latestProgressThinking(messages:ConversationMessage[]):string|null {
  for(const message of messages.slice().reverse()) {
    for(const block of message.content_blocks?.slice().reverse()||[]) {
      if(block.type==='thinking'&&block.text.trim())return block.text;
    }
  }
  return null;
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
