import type {ConversationMessage} from './api';
import {automaticConversationContext} from './conversation-context';
import {formatDisplayTimestamp} from './display-clock';

export function formatConversationTimestamp(timestamp: string | null | undefined): string {
  return formatDisplayTimestamp(timestamp);
}

export function elapsedBetween(start: string | null | undefined, end: string | number | null | undefined): number | null {
  if (!start || end == null) return null;
  const from=Date.parse(start),to=typeof end==='number'?end:Date.parse(end);
  return Number.isFinite(from) && Number.isFinite(to) && to>=from ? to-from : null;
}

export function formatElapsed(milliseconds: number): string {
  const seconds=Math.max(0,Math.floor(milliseconds/1000));
  if (seconds<60) return `${seconds}秒`;
  const minutes=Math.floor(seconds/60);
  if (minutes<60) return `${minutes}分${seconds%60}秒`;
  return `${Math.floor(minutes/60)}时${minutes%60}分${seconds%60}秒`;
}

export function conversationTimings(messages: ConversationMessage[], _now: number, _busy: boolean, _activeTurnId?:string|null) {
  messages=messages.filter(message=>message.role!=='user'||!automaticConversationContext(message.text));
  const result=new Map<string,{label:string;title:string}>();
  let userTime:string|null=null,previousCompletion:string|null=null;
  let userTurn:string|undefined,previousTurn:string|undefined;
  for(const message of messages) {
    if(message.role==='user') {userTime=message.timestamp;userTurn=message.turn_id;previousCompletion=null;previousTurn=undefined;continue;}
    if(message.async_questions?.length||message.streaming)continue;
    if(message.phase==='error'){previousCompletion=null;previousTurn=undefined;continue;}
    if(message.phase==='final') {
      if(userTurn && message.turn_id && userTurn!==message.turn_id)continue;
      const elapsed=elapsedBetween(userTime,message.timestamp);
      if(elapsed!==null) result.set(message.id,{label:`本轮耗时 ${formatElapsed(elapsed)}`,title:'最近一条用户消息到本条答复完成的时间差，包含工具执行和等待时间'});
    } else if(message.phase==='commentary') {
      const samePrevious=previousCompletion&&(!previousTurn||!message.turn_id||previousTurn===message.turn_id);
      const sameUser=!userTurn||!message.turn_id||userTurn===message.turn_id;
      const elapsed=elapsedBetween(samePrevious?previousCompletion:sameUser?userTime:null,message.timestamp);
      if(elapsed!==null)result.set(message.id,{label:`耗时 ${formatElapsed(elapsed)}`,title:'上一条进展完成（或本轮用户消息）到本条进展完成的时间差，包含工具执行和等待；不是单独生成这段文字的耗时'});
      previousCompletion=message.timestamp;previousTurn=message.turn_id;
    }
  }
  return result;
}
