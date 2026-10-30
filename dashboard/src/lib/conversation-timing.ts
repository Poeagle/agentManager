import type {ConversationMessage} from './api';

const timestampFormatter=new Intl.DateTimeFormat('sv-SE',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});

export function formatConversationTimestamp(timestamp: string | null | undefined): string {
  const value=timestamp?Date.parse(timestamp):NaN;
  return Number.isFinite(value)?timestampFormatter.format(new Date(value)):'时间未知';
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

export function conversationTimings(messages: ConversationMessage[], now: number, busy: boolean) {
  const result=new Map<string,{label:string;title:string}>();
  let userTime:string|null=null;
  for(let index=0;index<messages.length;index++) {
    const message=messages[index];
    if(message.role==='user') {userTime=message.timestamp;continue;}
    if(message.phase==='final') {
      const elapsed=elapsedBetween(userTime,message.timestamp);
      if(elapsed!==null) result.set(message.id,{label:`本轮耗时 ${formatElapsed(elapsed)}`,title:'从本轮用户消息到这条答复的时间间隔'});
    } else {
      const next=messages[index+1];
      const elapsed=elapsedBetween(message.timestamp,next?.timestamp ?? (!next && busy ? now : null));
      if(elapsed!==null) result.set(message.id,{label:`${next?'阶段间隔':'已持续'} ${formatElapsed(elapsed)}`,title:next?'从本条进展到下一条对话的时间间隔；不代表单个工具的执行耗时':'从本条进展开始计时，等待下一条进展或答复'});
    }
  }
  return result;
}
