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

export function conversationTimings(messages: ConversationMessage[], now: number, busy: boolean,activeTurnId?:string|null) {
  const result=new Map<string,{label:string;title:string}>();
  let userTime:string|null=null;
  let userTurn:string|undefined;
  for(let index=0;index<messages.length;index++) {
    const message=messages[index];
    if(message.role==='user') {userTime=message.timestamp;userTurn=message.turn_id;continue;}
    if(message.phase==='final') {
      if(userTurn && message.turn_id && userTurn!==message.turn_id)continue;
      const elapsed=elapsedBetween(userTime,message.timestamp);
      if(elapsed!==null) result.set(message.id,{label:`本轮耗时 ${formatElapsed(elapsed)}`,title:'最近一条用户消息到本条答复记录的时间差，包含等待时间'});
    } else if(message.phase==='commentary') {
      const next=messages[index+1];
      // A later human message, error or different turn is not the end of this
      // progress step. Never turn human/offline waiting into execution time.
      if(next && (next.role!=='assistant' || !['commentary','final'].includes(next.phase||'') || message.turn_id && next.turn_id && message.turn_id!==next.turn_id))continue;
      if(!next && activeTurnId && message.turn_id && activeTurnId!==message.turn_id)continue;
      const elapsed=elapsedBetween(message.timestamp,next?.timestamp ?? (!next && busy ? now : null));
      if(elapsed!==null) result.set(message.id,{label:`${next?'消息间隔':'距上次更新'} ${formatElapsed(elapsed)}`,title:next?'同一轮相邻 Agent 输出的记录时间差，包含等待或暂停；不是工具执行耗时':'当前轮仍在执行，距离最近进展记录的时间；不是工具执行耗时'});
    }
  }
  return result;
}
