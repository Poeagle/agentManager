import {ChevronRight,Loader2} from 'lucide-react';
import type {ConversationStatistics} from '../lib/api';
import {elapsedBetween,formatConversationTimestamp,formatElapsedEnglish} from '../lib/conversation-timing';
import {useDisplayClock} from '../lib/display-clock';
import {ConversationCard} from './ConversationCard';
import {ConversationStatisticsLabel} from './ConversationStatisticsLabel';
import {englishActivity,type ConversationActivity} from './ConversationActivityLine';

export function ConversationProgressPending({number,tool,startedAt,statistics,now,connected}:{number:number;tool?:ConversationActivity;startedAt:string|null;statistics:ConversationStatistics|null;now:number;connected:boolean}) {
  useDisplayClock();
  const elapsed=elapsedBetween(startedAt,now);
  return <div className="session-chat-progress-entry session-chat-progress-pending" data-active="true" role="status" aria-label={`正在执行的进展 ${number}`}>
    <span className="session-chat-progress-number" aria-label={`进展序号 ${number}`}>{number}</span>
    <div className="session-chat-metadata-row"><span className="session-chat-message-meta">
      {startedAt&&Number.isFinite(Date.parse(startedAt))?<time dateTime={startedAt} title="Progress start time; this update is still running">{formatConversationTimestamp(startedAt)}</time>:<span>Time pending</span>}
      {statistics?<ConversationStatisticsLabel statistics={statistics} interval/>:<span className="session-chat-message-statistics" title="Usage for the current progress update is not yet available">step · token: — · tools: —</span>}
      <span className="session-chat-message-duration" title="Elapsed time since this progress update started">Elapsed: {elapsed===null?'—':formatElapsedEnglish(elapsed)}</span>
    </span></div>
    {tool?<ConversationCard key={tool.id} className="session-chat-live-tool" status={tool.status} summary={<><ChevronRight size={12} className="session-chat-live-tool-arrow"/><span className="session-chat-live-tool-label" title={tool.status==='running'?englishActivity(tool.label):'Waiting for the next tool or progress message; expand to inspect the last tool'}>{tool.status==='running'?englishActivity(tool.label):'Waiting…'}</span>{tool.status==='running'&&<Loader2 size={12} className="animate-spin"/>}</>}>
      <div className="session-chat-live-tool-details">
        <pre className="session-chat-tool-input">{tool.input_preview||englishActivity(tool.label)}</pre>
        {tool.result_preview!==undefined&&<pre className="session-chat-tool-result">{tool.result_preview}</pre>}
      </div>
    </ConversationCard>:<div className="session-chat-progress-execution"><Loader2 size={12} className={connected?'animate-spin':undefined}/><span>{connected?'Waiting for update…':'Reconnecting…'}</span></div>}
  </div>;
}
