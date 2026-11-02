import {AlertCircle,Check,Loader2} from 'lucide-react';
import type {CompactionPresentation} from '../lib/use-conversation-compaction';
import {elapsedBetween,formatElapsed} from '../lib/conversation-timing';
export function ConversationCompactionStatus({state,now}:{state:CompactionPresentation;now:number}){
 const running=['pending','running'].includes(state.status),success=state.status==='completed',Icon=running?Loader2:success?Check:AlertCircle;
 const label=state.status==='pending'?'正在启动上下文压缩…':state.status==='running'?'正在压缩上下文':success?'上下文压缩完成':state.status==='interrupted'?'上下文压缩已中断':state.status==='unknown'?'压缩状态待确认':'上下文压缩失败';
 const duration=state.duration_ms??(running?elapsedBetween(state.started_at,now):elapsedBetween(state.started_at,state.completed_at));
 return <span className="conversation-compaction-status" data-state={state.status} title={state.error||undefined}><Icon size={13} className={running?'animate-spin':''}/><span>{label}</span>{duration!==null&&<time>{formatElapsed(duration)}</time>}{success&&state.before!==null&&state.after!==null&&state.before!==state.after&&<span>上下文 {state.before}% → {state.after}%</span>}</span>;
}
