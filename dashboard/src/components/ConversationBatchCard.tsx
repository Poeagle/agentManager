import {formatDisplayTimestamp} from '../lib/display-clock';
import {useState} from 'react';
import {Layers,ChevronRight} from 'lucide-react';
import {Dialog} from './Dialog';
import {ConversationMessageAttachments} from './ConversationAttachments';
import type {ConversationMessage} from '../lib/api';
export function ConversationBatchCard({parts,sentAt,projectId,projectPath,onOpenFile}:{sentAt?:string|null;parts:NonNullable<ConversationMessage['batch']>;projectId:string|null;projectPath?:string;onOpenFile?:(path:string)=>void}){
 const [open,setOpen]=useState(false);
 return <><button type="button" className="conversation-batch-card" onClick={()=>setOpen(true)} aria-haspopup="dialog"><Layers size={16}/><span><strong>批量消息 <small>{parts.length} 条</small></strong><span>{parts.map(p=>p.text||p.attachments.map(a=>a.name).join('、')).join(' · ')}</span></span><ChevronRight size={14}/></button>
 {open&&<Dialog title={`批量消息 · ${parts.length} 条`} size="lg" onClose={()=>setOpen(false)}><div className="conversation-batch-details">{parts.map((part,index)=><section key={index} aria-label={`第 ${index+1} 条消息`}><header><span>消息 {index+1}</span><time dateTime={sentAt||undefined} title="发送时间">发送于 {formatDisplayTimestamp(sentAt)}</time></header><ConversationMessageAttachments text={part.text} items={part.attachments} projectId={projectId} projectPath={projectPath} onOpenFile={onOpenFile}/></section>)}</div></Dialog>}</>;
}
