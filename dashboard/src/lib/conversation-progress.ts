import type {ConversationMessage,ConversationProgressStatistics,ConversationProgressSegment,ConversationStatistics} from './api';

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
  const cost=current.cost===null?null:current.cost&&(!previous||previous.cost?.complete)&&current.cost.amount!=null?{...current.cost,amount:Math.max(0,current.cost.amount-(previous?.cost?.amount??0))}:undefined;
  return {cost,sequence:0,turn_id:live!.turn_id,tokens,requests,tool_calls:calls,tool_rounds:rounds,complete:current.complete,interval:{cost,tokens,requests,tool_calls:calls,tool_rounds:rounds,complete:current.complete,shared_messages:1}};
}

type ConversationGroup={kind:'progress';id:string;messages:ConversationMessage[]}|{kind:'message';id:string;message:ConversationMessage};

/** Group presentation only; retain every native item ID for reconciliation,
 * document anchors and navigation. A user message or final reply ends a group. */
export function groupConversationProgress(messages:ConversationMessage[]):ConversationGroup[] {
  const groups:ConversationGroup[]=[];
  for(const message of messages) {
    const previous=groups.at(-1);
    // Consecutive native retry notices in the same turn are updates to one
    // incident. Never infer a relationship across a turn or an intervening
    // message, and keep a different explicit error code as a separate error.
    if(message.role==='assistant' && message.phase==='error' && message.turn_id && previous?.kind==='message') {
      const prior=previous.message;
      if(prior.role==='assistant' && prior.phase==='error' && prior.error?.will_retry && prior.turn_id===message.turn_id &&
        (!prior.error.code || !message.error?.code || prior.error.code===message.error.code)) {
        groups[groups.length-1]={...previous,message};
        continue;
      }
    }
    if(message.role==='assistant' && message.phase==='commentary' && message.presentation!=='compaction_summary') {
      const turn=previous?.kind==='progress'?previous.messages.at(-1)?.turn_id:undefined;
      if(previous?.kind==='progress' && (!turn || !message.turn_id || turn===message.turn_id))previous.messages.push(message);
      else groups.push({kind:'progress',id:message.id,messages:[message]});
    }else groups.push({kind:'message',id:message.id,message});
  }
  return groups;
}

export function withObservedToolCounts(statistics:ConversationStatistics|null,count:number,turnId:string):ConversationStatistics|null {
 if(!count||statistics&&('segment_id' in statistics||statistics.tool_calls>=count))return statistics;
 const value=statistics?.interval??statistics;
 const interval={...value,tokens:value?.tokens??null,requests:value?.requests??0,tool_calls:Math.max(value?.tool_calls??0,count),tool_rounds:Math.max(value?.tool_rounds??0,1),complete:false,shared_messages:1};
 return {...statistics,...interval,sequence:0,turn_id:turnId,interval};
}
