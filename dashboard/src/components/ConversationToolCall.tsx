import {AlertCircle,CheckCircle2,ChevronDown,LoaderCircle,Terminal} from 'lucide-react';
import type {ConversationMessage} from '../lib/api';
import {ConversationCard} from './ConversationCard';

export function ConversationToolCall({block,compact=false}:{block:Extract<NonNullable<ConversationMessage['content_blocks']>[number],{type:'tool_use'}>;compact?:boolean}){
  const args=typeof block.input==='string'?block.input:JSON.stringify(block.input,null,2);
  const status=block.status==='running'?'运行中':block.status==='failed'?'失败':'完成';
  const indicator=block.status==='running'?<LoaderCircle size={13} className="animate-spin"/>:block.status==='failed'?<AlertCircle size={13}/>:<CheckCircle2 size={13}/>;
  return <ConversationCard className={`session-chat-tool${compact?' session-chat-tool-compact':''}`} open={!compact&&block.status==='running'} status={block.status} summary={compact
    ? <><span className="session-chat-tool-icon"><Terminal size={13}/></span><span className="session-chat-tool-heading"><strong>{block.name}</strong><small>{block.status==='running'?'正在调用工具':block.status==='failed'?'工具调用失败':'工具调用完成'}</small></span><span className="session-chat-tool-status">{indicator}<span>{status}</span></span><ChevronDown size={13} className="session-chat-tool-chevron"/></>
    : <><Terminal size={13}/><strong>{block.name}</strong><span>{status}</span>{indicator}<ChevronDown size={13} className="session-chat-tool-chevron"/></>}>
    {!!args&&args!=='{}'&&<pre className="session-chat-tool-input">{args}</pre>}
    {block.result!==undefined&&<pre className="session-chat-tool-result">{block.result||'(无输出)'}</pre>}
  </ConversationCard>;
}
