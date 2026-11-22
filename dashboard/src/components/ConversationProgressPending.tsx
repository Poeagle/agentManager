import {ChevronRight,Loader2} from 'lucide-react';
import type {ConversationStatistics,ConversationUsageUpdate} from '../lib/api';
import {elapsedBetween,formatConversationTimestamp,formatElapsedEnglish} from '../lib/conversation-timing';
import {useDisplayClock} from '../lib/display-clock';
import {ConversationCard} from './ConversationCard';
import {ConversationStatisticsLabel} from './ConversationStatisticsLabel';
import {englishActivity,type ConversationActivity} from './ConversationActivityLine';

export function ConversationProgressPending({number,tool,startedAt,statistics,liveUsage,now,connected,showStatistics=true}:{number:number;tool?:ConversationActivity;startedAt:string|null;statistics:ConversationStatistics|null;liveUsage?:ConversationUsageUpdate|null;now:number;connected:boolean;showStatistics?:boolean}) {
  useDisplayClock();
  const elapsed=elapsedBetween(startedAt,now);
  const command=tool?(tool.input_preview||englishActivity(tool.label)).replace(/\s+/g,' ').trim():'';
  const characters=Array.from(command);
  const summary=characters.length>100?`${characters.slice(0,100).join('')}…`:command;
  const latest=liveUsage?.usage.last;
  const formatTokens=(value:number|null|undefined)=>typeof value==='number'&&Number.isFinite(value)
    ?new Intl.NumberFormat('en',{notation:'compact',maximumFractionDigits:1}).format(value):'—';
  const hasLatestUsage=!(statistics?.interval??statistics)?.tokens&&!!latest&&Object.values(latest).some(value=>typeof value==='number'&&Number.isFinite(value));
  return <div className="session-chat-progress-entry session-chat-progress-pending" data-active="true" role="status" aria-label={`正在执行的进展 ${number}`}>
    <span className="session-chat-progress-number" aria-label={`进展序号 ${number}`}>{number}</span>
    <div className="session-chat-metadata-row"><span className="session-chat-message-meta">
      {startedAt&&Number.isFinite(Date.parse(startedAt))?<time dateTime={startedAt} title="Progress start time; this update is still running">{formatConversationTimestamp(startedAt)}</time>:<span>Time pending</span>}
      {showStatistics&&<ConversationStatisticsLabel statistics={statistics} interval/>}
      {showStatistics&&hasLatestUsage&&<span className="session-chat-message-statistics" title={`Latest native request usage observed at ${formatConversationTimestamp(liveUsage!.observed_at)}`}>
        Latest request · {formatTokens(latest?.total_tokens)} tokens · input {formatTokens(latest?.input_tokens)} · cache {formatTokens(latest?.cached_input_tokens)} · output {formatTokens(latest?.output_tokens)}
      </span>}
      {showStatistics&&elapsed!==null&&<span className="session-chat-message-duration" title="Elapsed time since this progress update started">Elapsed: {formatElapsedEnglish(elapsed)}</span>}
    </span></div>
    {tool?<ConversationCard key={tool.id} className="session-chat-live-tool" status={tool.status} summary={<><ChevronRight size={12} className="session-chat-live-tool-arrow"/><span className="session-chat-live-tool-label" title={command}>{summary}</span>{tool.status==='running'?<Loader2 size={12} className="animate-spin"/>:<span className="session-chat-live-tool-state">Waiting…</span>}</>}>
      <div className="session-chat-live-tool-details">
        <pre className="session-chat-tool-result">{tool.result_preview??(tool.status==='running'?'Waiting for output…':'No result available')}</pre>
      </div>
    </ConversationCard>:<div className="session-chat-progress-execution"><Loader2 size={12} className={connected?'animate-spin':undefined}/><span>{connected?'Waiting for update…':'Reconnecting…'}</span></div>}
  </div>;
}
