import type {ConversationMessage} from './api';

type ConversationGroup={kind:'progress';id:string;messages:ConversationMessage[]}|{kind:'message';id:string;message:ConversationMessage};

/** Group presentation only; retain every native item ID for reconciliation,
 * document anchors and navigation. A user message or final reply ends a group. */
export function groupConversationProgress(messages:ConversationMessage[]):ConversationGroup[] {
  const groups:ConversationGroup[]=[];
  for(const message of messages) {
    if(message.role==='assistant' && message.phase==='commentary') {
      const previous=groups.at(-1),turn=previous?.kind==='progress'?previous.messages.at(-1)?.turn_id:undefined;
      if(previous?.kind==='progress' && (!turn || !message.turn_id || turn===message.turn_id))previous.messages.push(message);
      else groups.push({kind:'progress',id:message.id,messages:[message]});
    }else groups.push({kind:'message',id:message.id,message});
  }
  return groups;
}
