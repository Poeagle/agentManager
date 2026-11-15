import {AlertCircle,CheckCircle2,ChevronDown,LoaderCircle,Search,SquareTerminal} from 'lucide-react';
import type {ConversationMessage} from '../lib/api';
import {ConversationCard} from './ConversationCard';

export function ConversationToolCall({block,compact=false}:{block:Extract<NonNullable<ConversationMessage['content_blocks']>[number],{type:'tool_use'}>;compact?:boolean}){
  const args=typeof block.input==='string'?block.input:JSON.stringify(block.input,null,2);
  const status=block.status==='running'?'运行中':block.status==='failed'?'失败':'完成';
  const indicator=block.status==='running'?<LoaderCircle size={13} className="animate-spin"/>:block.status==='failed'?<AlertCircle size={13}/>:<CheckCircle2 size={13}/>;
  const ToolIcon=block.name==='Bash'?SquareTerminal:block.name==='Glob'||block.name==='Grep'?Search:SquareTerminal;
  return <ConversationCard className="session-chat-tool" open={!compact&&block.status==='running'} status={block.status} summary={<><ToolIcon size={13}/><strong>{block.name}</strong><span>{status}</span>{indicator}<ChevronDown size={13} className="session-chat-tool-chevron"/></>}>
    {!!args&&args!=='{}'&&<pre className="session-chat-tool-input">{args}</pre>}
    {block.result!==undefined&&<pre className="session-chat-tool-result">{block.result||'(无输出)'}</pre>}
  </ConversationCard>;
}
