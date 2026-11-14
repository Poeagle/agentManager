import {ConversationImagePreviewRoot,useConversationImagePreview,useConversationFilePreview,useConversationImageHover} from './ConversationImagePreview';
import {useRef} from 'react';
import {Paperclip,FolderOpen} from 'lucide-react';
import {api} from '../lib/api';
import type {ConversationAttachment} from '../lib/conversation-attachments';


export function ConversationAttachmentPicker({disabled,onFiles,label='对话'}:{label?:string;disabled:boolean;onFiles:(files:File[])=>void}) {
  const input=useRef<HTMLInputElement>(null),directory=useRef<HTMLInputElement>(null);
  return <><input ref={input} type="file" multiple hidden aria-label={`选择${label}附件`} disabled={disabled} onChange={event=>{onFiles(Array.from(event.target.files||[]));event.target.value='';}}/><input ref={directory} type="file" multiple hidden {...{webkitdirectory:''}} aria-label={`选择${label}目录`} disabled={disabled} onChange={event=>{onFiles(Array.from(event.target.files||[]));event.target.value='';}}/><button type="button" className="session-chat-attach" aria-label="上传图片或文件" title="上传图片或文件，也可粘贴截图、拖入目录" disabled={disabled} onClick={()=>input.current?.click()}><Paperclip size={17}/></button><button type="button" className="session-chat-attach" aria-label="上传目录" title="选择目录，平台自动打包为 ZIP" disabled={disabled} onClick={()=>directory.current?.click()}><FolderOpen size={17}/></button></>;
}

export function ConversationMessageAttachments({items,projectId,onOpenFile,projectPath,text}:{text?:string;items:ConversationAttachment[];projectId:string|null;projectPath?:string;onOpenFile?:(path:string)=>void}) {
  return <ConversationImagePreviewRoot><MessageAttachments text={text} items={items} projectId={projectId} projectPath={projectPath} onOpenFile={onOpenFile}/></ConversationImagePreviewRoot>;
}
function MessageAttachments({items,projectId,projectPath,text}:{text?:string;items:ConversationAttachment[];projectId:string|null;projectPath?:string;onOpenFile?:(path:string)=>void}) {
  const preview=useConversationImagePreview(),previewFile=useConversationFilePreview(),hover=useConversationImageHover();
  if(!items.length)return text||null;
  const body=text??'';const ordered=items.map((item,index)=>({item,index,offset:Math.min(body.length,Math.max(0,item.offset??body.length))})).sort((a,b)=>a.offset-b.offset||a.index-b.index);
  return <span className="session-chat-message-attachments">{ordered.map(({item,index,offset},position)=>{const prefix=body.slice(position?ordered[position-1].offset:0,offset);return <span key={`${item.path}-${index}`}>{prefix}<button type="button" key={`${item.path}-${index}`} className="session-chat-message-attachment" title={item.kind==='image'?undefined:item.name} aria-label={`打开附件 ${item.name}`} onMouseEnter={event=>{if(item.kind==='image')hover?.show({src:api.files.previewUrl(item.path,projectId||undefined),name:item.name},event.currentTarget);}} onMouseLeave={()=>hover?.hide()} onFocus={event=>{if(item.kind==='image')hover?.show({src:api.files.previewUrl(item.path,projectId||undefined),name:item.name},event.currentTarget);}} onBlur={()=>hover?.hide()} onClick={()=>item.kind==='image'?preview?.({src:api.files.previewUrl(item.path,projectId||undefined),name:item.name}):previewFile?.({path:item.path,rootPath:projectPath||item.path.slice(0,item.path.lastIndexOf('/'))||'/',projectId,name:item.name,fileOnly:true})}>
    {item.kind==='image'?'图片':'文件'} {items.slice(0,index+1).filter(other=>other.kind===item.kind).length}
  </button></span>;})}{body.slice(ordered.at(-1)?.offset??0)}</span>;
}
