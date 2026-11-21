import {Layers3} from 'lucide-react';
import type {BriefContext} from '../lib/conversation-brief-context';
import {ConversationDialogCard} from './ConversationDialogCard';
import {ConversationMarkdown} from './ConversationMarkdown';

export function ConversationBriefContext({context,messageId,active,projectId,projectPath,onNavigate}: {
  context: BriefContext; messageId: string; active: boolean; projectId: string | null;
  projectPath?: string; onNavigate: () => void;
}) {
  const partial = context.truncated || context.older_omitted || context.omitted_turns > 0;
  return <article className="conversation-auto-context conversation-brief-context" data-context-kind="brief_compaction">
    <ConversationDialogCard active={active} title="简要压缩详情" summary={<>
      <Layers3 size={14} aria-hidden="true"/><strong>简要压缩</strong>
      <span>{context.turns.length} 轮</span>{partial&&<span className="conversation-brief-partial">部分记录已截取</span>}
      <span className="conversation-question-expand">查看详情</span>
    </>}>
      <div className="conversation-brief-details">
        <p>根据旧对话记录整理的输入、结论和少量过程。历史附件仅保留引用，没有重新发送附件内容。</p>
        {partial&&<p role="status" className="conversation-brief-partial">历史较长，部分文字或较早记录已截取；完整记录仍可在原会话中查看。</p>}
        <ol>
          {context.turns.map((turn,index)=><li key={index}>
            <h3>第 {index+1} 轮{turn.scheduled_task ? ` · 定时任务：${turn.scheduled_task}` : ''}</h3>
            <div className="conversation-brief-section"><strong>用户输入</strong><ConversationMarkdown content={turn.input || '（附件）'} messageId={`${messageId}-brief-${index}-input`} projectId={projectId} projectPath={projectPath} onNavigate={onNavigate}/></div>
            {!!turn.attachments?.length&&<div className="conversation-brief-section"><strong>附件引用</strong><ul>{turn.attachments.map((item,i)=><li key={i}>{item.name} <code>{item.path}</code></li>)}</ul></div>}
            {turn.progress&&<div className="conversation-brief-section"><strong>过程</strong><ConversationMarkdown content={turn.progress} messageId={`${messageId}-brief-${index}-progress`} projectId={projectId} projectPath={projectPath} onNavigate={onNavigate}/></div>}
            {turn.conclusion&&<div className="conversation-brief-section"><strong>结论</strong><ConversationMarkdown content={turn.conclusion} messageId={`${messageId}-brief-${index}-conclusion`} projectId={projectId} projectPath={projectPath} onNavigate={onNavigate}/></div>}
          </li>)}
        </ol>
      </div>
    </ConversationDialogCard>
  </article>;
}
