import type {ConversationMessage} from './api';

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
