import {AlertCircle,Check,Loader2} from 'lucide-react';
import type {CompactionPresentation} from '../lib/use-conversation-compaction';
import {elapsedBetween,formatElapsedEnglish} from '../lib/conversation-timing';
export function ConversationCompactionStatus({state,now}:{state:CompactionPresentation;now:number}){
 const running=['pending','running'].includes(state.status),success=state.status==='completed',Icon=running?Loader2:success?Check:AlertCircle;
 const label=state.status==='pending'?'Starting context compaction…':state.status==='running'?'Compacting context':success?'Context compaction complete':state.status==='interrupted'?'Context compaction interrupted':state.status==='unknown'?'Compaction status unknown':state.status==='rejected'?'Compaction not started':'Context compaction failed';
 const duration=state.duration_ms??(running?elapsedBetween(state.started_at,now):elapsedBetween(state.started_at,state.completed_at));
 return <span className="conversation-compaction-status" data-state={state.status} title={state.error||undefined}><Icon size={13} className={running?'animate-spin':''}/><span>{label}</span>{state.error&&<span className="conversation-compaction-error">{state.error}</span>}{duration!==null&&<time>{formatElapsedEnglish(duration)}</time>}{success&&state.before!==null&&state.after!==null&&state.before!==state.after&&<span>Context {state.before}% → {state.after}%</span>}</span>;
}
