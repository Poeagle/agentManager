import {AlertCircle,CheckCircle2,ChevronDown,LoaderCircle,Terminal} from 'lucide-react';
import type {ConversationMessage} from '../lib/api';

export function ConversationToolCall({block}:{block:Extract<NonNullable<ConversationMessage['content_blocks']>[number],{type:'tool_use'}>}){
  const args=typeof block.input==='string'?block.input:JSON.stringify(block.input,null,2);
  const status=block.status==='running'?'运行中':block.status==='failed'?'失败':'完成';
  return <details className="session-chat-tool" open={block.status==='running'} data-status={block.status}>
    <summary><Terminal size={13}/><strong>{block.name}</strong><span>{status}</span>{block.status==='running'?<LoaderCircle size={13} className="animate-spin"/>:block.status==='failed'?<AlertCircle size={13}/>:<CheckCircle2 size={13}/>}<ChevronDown size={13} className="session-chat-tool-chevron"/></summary>
    {!!args&&args!=='{}'&&<pre className="session-chat-tool-input">{args}</pre>}
    {block.result!==undefined&&<pre className="session-chat-tool-result">{block.result||'(无输出)'}</pre>}
  </details>;
}
