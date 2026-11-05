import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {ConversationComposerEditor} from './ConversationComposerEditor';
import {ConversationAttachmentPicker,useConversationAttachments,type DraftAttachment} from './ConversationAttachments';
import type {ConversationAttachment} from '../lib/conversation-attachments';

export interface QuestionAttachmentContext {sessionId:string;projectId:string|null;projectPath?:string;enabled:boolean}
export interface QuestionAttachmentState {items:DraftAttachment[];values:ConversationAttachment[];uploading:boolean;failed:boolean}
export type QuestionAttachmentMap=Record<string,ConversationAttachment[]>;

/** Question fields share the ordinary composer's upload, preview, cancellation
 * and retry behavior. The form owns only answer grouping and validation. */
export function ConversationQuestionEditor({id,label,value,initial,disabled,context,onChange,onAttachments,onSubmit,validateFiles}:{
 id:string;label:string;value:string;initial?:DraftAttachment[];disabled:boolean;context:QuestionAttachmentContext;
 onChange:(value:string,items:DraftAttachment[])=>void;onAttachments:(id:string,state:QuestionAttachmentState|null)=>void;onSubmit:()=>void;validateFiles:(files:File[])=>string;
}) {
 const attachments=useConversationAttachments(context.sessionId,initial),[error,setError]=useState('');
 const positions=useRef<(()=>Map<string,number>)|null>(null);
 function locatedItems(){const offsets=positions.current?.();return attachments.items.map(item=>({...item,offset:offsets?.get(item.id)??item.offset}));}
 useLayoutEffect(()=>{onAttachments(id,{items:locatedItems(),values:attachments.values(),uploading:attachments.uploading,failed:attachments.failed});},[id,attachments.items,onAttachments]);
 useEffect(()=>()=>onAttachments(id,null),[id,onAttachments]);
 const available=context.enabled&&!disabled;
 function enqueue(files:File[]){if(!available){setError('当前 Agent 不支持附件');return;}const error=validateFiles(files);setError(error);if(!error)attachments.enqueue(files);}
 return <div className="conversation-question-editor"
  onDragOver={event=>{if(Array.from(event.dataTransfer.types).includes('Files')){event.preventDefault();event.dataTransfer.dropEffect=available?'copy':'none';}}}
  onDrop={event=>{if(!Array.from(event.dataTransfer.types).includes('Files'))return;event.preventDefault();event.stopPropagation();if(!available)return;if(Array.from(event.dataTransfer.items||[]).some(item=>item.webkitGetAsEntry?.()?.isDirectory))attachments.enqueueTransfer(event.dataTransfer);else enqueue(Array.from(event.dataTransfer.files));}}>
  <ConversationComposerEditor snapshotRef={positions} label={label} value={value} items={attachments.items} disabled={disabled} placeholder={context.enabled?'输入回答，可粘贴图片或文件':'输入回答'} projectId={context.projectId} projectPath={context.projectPath} onChange={text=>onChange(text,locatedItems())} onRemove={attachments.remove} onRetry={attachments.retry} onFiles={enqueue} onSubmit={onSubmit}/>
  {(error||attachments.error)&&<p role="alert" className="session-chat-error">{error||attachments.error}</p>}
  <div className="conversation-question-editor-tools"><ConversationAttachmentPicker label="回答" disabled={!available} onFiles={enqueue}/><span>{attachments.uploading?'附件处理中…':attachments.failed?'附件上传失败，请重试或移除':attachments.items.length?`${attachments.items.length} 个附件`:'可粘贴、拖入或选择附件'}</span></div>
 </div>;
}
