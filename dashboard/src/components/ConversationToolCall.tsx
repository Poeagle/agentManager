import {AlertCircle,CheckCircle2,ChevronDown,ChevronRight,LoaderCircle,Search,SquareTerminal,X} from 'lucide-react';
import type {ConversationMessage} from '../lib/api';
import {ConversationCard} from './ConversationCard';

export function claudianToolName(name:string){
  if(name==='Bash')return 'Bash';
  if(name==='Read')return 'Read';
  if(name==='Write')return 'Write';
  if(name==='Edit')return 'Edit';
  if(name==='Glob'||name==='Grep'||name==='LS')return name;
  if(name==='WebSearch')return 'WebSearch';
  if(name==='WebFetch')return 'WebFetch';
  return name;
}

export function claudianToolSummary(name:string,input:unknown){
  if(!input||typeof input!=='object'||Array.isArray(input))return '';
  const value=input as Record<string,unknown>;
  const text=typeof value.file_path==='string'?value.file_path
    :typeof value.notebook_path==='string'?value.notebook_path
    :typeof value.command==='string'?value.command
    :typeof value.pattern==='string'?value.pattern
    :typeof value.query==='string'?value.query
    :typeof value.url==='string'?value.url
    :typeof value.path==='string'?value.path:'';
  if(!text)return '';
  if(['Read','Write','Edit'].includes(name))return text.replace(/\\/g,'/').split('/').pop()||text;
  return text.length>60?`${text.slice(0,60)}...`:text;
}

export function ConversationToolCall({block,compact=false}:{block:Extract<NonNullable<ConversationMessage['content_blocks']>[number],{type:'tool_use'}>;compact?:boolean}){
  const args=typeof block.input==='string'?block.input:JSON.stringify(block.input,null,2);
  const status=block.status==='running'?'运行中':block.status==='failed'?'失败':'完成';
  const indicator=block.status==='running'?<LoaderCircle size={13} className="animate-spin"/>:block.status==='failed'?<AlertCircle size={13}/>:<CheckCircle2 size={13}/>;
  const ToolIcon=block.name==='Bash'?SquareTerminal:block.name==='Glob'||block.name==='Grep'?Search:SquareTerminal;
  return <ConversationCard className={`session-chat-tool${compact?' session-chat-tool-compact':''}`} open={!compact&&block.status==='running'} status={block.status} summary={compact
    ? <><span className="session-chat-tool-leading"><span className="session-chat-tool-icon"><ToolIcon size={14}/></span><ChevronRight size={14} className="session-chat-tool-expand"/></span><span className="session-chat-tool-title">{claudianToolName(block.name)}</span><span className="session-chat-tool-dot" aria-hidden="true"/><span className="session-chat-tool-summary">{claudianToolSummary(block.name,block.input)}</span>{block.status==='failed'&&<span className={`session-chat-tool-status status-${block.status}`} aria-label={`Status: ${block.status}`}><X size={14}/></span>}</>
    : <><SquareTerminal size={13}/><strong>{block.name}</strong><span>{status}</span>{indicator}<ChevronDown size={13} className="session-chat-tool-chevron"/></>}>
    {!!args&&args!=='{}'&&<pre className="session-chat-tool-input">{args}</pre>}
    {block.result!==undefined&&<pre className="session-chat-tool-result">{block.result||'(无输出)'}</pre>}
  </ConversationCard>;
}
