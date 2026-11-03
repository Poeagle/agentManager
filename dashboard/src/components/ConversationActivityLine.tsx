import {useEffect,useRef,useState,type CSSProperties} from 'react';
import {elapsedBetween,formatElapsed} from '../lib/conversation-timing';

export interface ConversationActivity {
  id:string;label:string;status:'running'|'completed'|'failed';started_at:string|null;completed_at:string|null;duration_ms:number|null;
}

export function ConversationActivityLine({activities,busy,now,fallback,totalElapsed}:{activities:ConversationActivity[];busy:boolean;now:number;fallback:string;totalElapsed:number|null}) {
  const viewport=useRef<HTMLSpanElement>(null),text=useRef<HTMLSpanElement>(null);
  const [travel,setTravel]=useState(0);
  // The latest native step wins immediately; never replay a queue of stale
  // completed tools while newer work is already running.
  const item=busy?[...activities].reverse().find(item=>item.status==='running')||activities.at(-1)||null:null;
  const label=item?`${item.status==='completed'?'已完成 · ':item.status==='failed'?'失败 · ':''}${item.label}`:fallback;
  useEffect(()=>{
    const measure=()=>setTravel(Math.max(0,(text.current?.scrollWidth||0)-(viewport.current?.clientWidth||0)));
    measure();
    if(typeof ResizeObserver==='undefined')return;
    const observer=new ResizeObserver(measure);if(viewport.current)observer.observe(viewport.current);
    return ()=>observer.disconnect();
  },[label]);
  const duration=item?.duration_ms ?? (item?.status==='running'?elapsedBetween(item.started_at,now):null);
  return <span className="session-chat-activity-line" data-testid="conversation-activity-line">
    <span ref={viewport} className="session-chat-activity-viewport" title={label}>
      <span key={item?`${item.id}:${item.status}`:label} className="session-chat-activity-switch">
        <span ref={text} className="session-chat-activity-text" data-overflow={travel>0} style={{'--activity-travel':`${-travel}px`,'--activity-duration':`${Math.max(8,travel/30)}s`} as CSSProperties}>{label}</span>
      </span>
    </span>
    {duration!==null && duration!==undefined && <time className="session-chat-activity-duration" title="当前步骤耗时">{formatElapsed(duration)}</time>}
    {busy && totalElapsed!==null && <time className="session-chat-round-duration" title="当前对话从用户发言起的累计时间">本轮 {formatElapsed(totalElapsed)}</time>}
  </span>;
}
