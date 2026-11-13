import {useEffect,useRef,useState,type CSSProperties} from 'react';
import {elapsedBetween,formatElapsedEnglish} from '../lib/conversation-timing';
import {browserTimestamp,formatDisplayTimestamp,useDisplayClock} from '../lib/display-clock';

export interface ConversationActivity {
  id:string;label:string;status:'running'|'completed'|'failed';started_at:string|null;completed_at:string|null;duration_ms:number|null;
}
const activityLabels:Record<string,string>={'运行命令':'Run command','调用工具':'Call tool','修改文件':'Edit files','读取文件':'Read file','搜索文件':'Search files','搜索':'Search','读取网页':'Read page','压缩会话上下文':'Compact context'};
const activityDefaults:Record<string,string>={'终端命令':'terminal command','MCP 工具':'MCP tool','工具':'tool','项目文件':'project files','网页搜索':'web search','网页':'web page'};
function englishActivity(label:string){const [prefix,...rest]=label.split(' · ');if(!activityLabels[prefix])return label;return [activityLabels[prefix],...rest.map(part=>activityDefaults[part]||part.replaceAll('[隐藏]','[redacted]'))].join(' · ');}
export function currentConversationActivity(activities:ConversationActivity[],busy:boolean){return busy?[...activities].reverse().find(item=>item.status==='running')||activities.at(-1)||null:null;}
export function conversationActivityDuration(item:ConversationActivity|null,now:number){return item?.duration_ms??(item?.status==='running'?elapsedBetween(item.started_at,now):null);}

export function ConversationActivityLine({activities,busy,now,fallback,totalElapsed,hideTiming=false}:{activities:ConversationActivity[];busy:boolean;now:number;fallback:string;totalElapsed:number|null;hideTiming?:boolean}) {
  useDisplayClock();
  const viewport=useRef<HTMLSpanElement>(null),text=useRef<HTMLSpanElement>(null);
  const [travel,setTravel]=useState(0);
  // The latest native step wins immediately; never replay a queue of stale
  // completed tools while newer work is already running.
  const item=currentConversationActivity(activities,busy);
  const completedAt=item?.completed_at?browserTimestamp(item.completed_at):NaN;
  const completionTime=Number.isFinite(completedAt)&&Math.abs(completedAt)<=8.64e15?`${formatDisplayTimestamp(item!.completed_at).replaceAll('-','.')}.${String(new Date(completedAt).getUTCMilliseconds()).padStart(3,'0')}`:'time unavailable';
  const label=item?item.status==='running'?englishActivity(item.label):`Running · Last ${item.status==='completed'?'completed':'failed'} (${completionTime})`:fallback;
  useEffect(()=>{
    const measure=()=>setTravel(Math.max(0,(text.current?.scrollWidth||0)-(viewport.current?.clientWidth||0)));
    measure();
    if(typeof ResizeObserver==='undefined')return;
    const observer=new ResizeObserver(measure);if(viewport.current)observer.observe(viewport.current);
    return ()=>observer.disconnect();
  },[label]);
  const duration=conversationActivityDuration(item,now);
  return <span className="session-chat-activity-line" data-testid="conversation-activity-line">
    <span ref={viewport} className="session-chat-activity-viewport" title={label}>
      <span key={item?`${item.id}:${item.status}`:label} className="session-chat-activity-switch">
        <span ref={text} className="session-chat-activity-text" data-overflow={travel>0} style={{'--activity-travel':`${-travel}px`,'--activity-duration':`${Math.max(8,travel/30)}s`} as CSSProperties}>{label}</span>
      </span>
    </span>
    {!hideTiming&&item?.status==='running'&&duration!==null && duration!==undefined && <time className="session-chat-activity-duration" title="Current step duration">{formatElapsedEnglish(duration)}</time>}
    {!hideTiming&&busy && totalElapsed!==null && <time className="session-chat-round-duration" title="Elapsed time since the user's message">Turn {formatElapsedEnglish(totalElapsed)}</time>}
  </span>;
}
