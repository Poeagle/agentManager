import {ConversationImagePreviewRoot,useConversationImagePreview,useConversationFilePreview} from './ConversationImagePreview';
import {useEffect,useRef,useState} from 'react';
import {File,Image,Loader2,Paperclip,X} from 'lucide-react';
import {api} from '../lib/api';
import {readFileAsDataUrl} from '../lib/file-data-url';
import {conversationClientId} from '../lib/conversation-timeline';
import type {ConversationAttachment} from '../lib/conversation-attachments';

interface DraftAttachment {id:string;name:string;kind:'image'|'file';size:number;path?:string;thumbnail?:string;status:'uploading'|'ready'|'error';error?:string}
export function useConversationAttachments(sessionId:string) {
  const [items,setItems]=useState<DraftAttachment[]>([]),[error,setError]=useState('');
  const current=useRef(items),alive=useRef(true),queue=useRef(Promise.resolve());
  const controllers=useRef(new Map<string,AbortController>()),urls=useRef(new Set<string>());
  useEffect(()=>{
    alive.current=true;const active=controllers.current,previews=urls.current;
    return()=>{alive.current=false;for(const controller of active.values())controller.abort();active.clear();for(const url of previews)URL.revokeObjectURL(url);previews.clear();};
  },[sessionId]);
  function publish(next:DraftAttachment[]) {current.current=next;if(alive.current)setItems(next);}
  function patch(id:string,change:Partial<DraftAttachment>) {publish(current.current.map(item=>item.id===id?{...item,...change}:item));}
  function remove(id:string) {
    controllers.current.get(id)?.abort();controllers.current.delete(id);
    const item=current.current.find(item=>item.id===id);if(item?.thumbnail){URL.revokeObjectURL(item.thumbnail);urls.current.delete(item.thumbnail);}
    publish(current.current.filter(item=>item.id!==id));
  }
  function enqueue(files:File[]) {
    setError('');
    for(const file of files) {
      const image=/^image\/(png|jpeg|gif|webp)$/i.test(file.type),name=file.name || (image?'截图.png':'文件');
      const total=current.current.reduce((sum,item)=>sum+item.size,0),images=current.current.filter(item=>item.kind==='image').reduce((sum,item)=>sum+item.size,0);
      if(current.current.length>=8){setError('每条消息最多支持 8 个附件');break;}
      if(file.size>(image?10:35)*1024*1024 || total+file.size>50*1024*1024 || image && images+file.size>10*1024*1024){setError('图片总大小最多 10 MB，单个文件最多 35 MB，附件合计最多 50 MB');continue;}
      const id=conversationClientId(),controller=new AbortController();controllers.current.set(id,controller);
      const thumbnail=image && typeof URL.createObjectURL==='function'?URL.createObjectURL(file):undefined;if(thumbnail)urls.current.add(thumbnail);
      publish([...current.current,{id,name,kind:image?'image':'file',size:file.size,thumbnail,status:'uploading'}]);
      queue.current=queue.current.catch(()=>{}).then(async()=>{
        if(controller.signal.aborted)return;
        try {
          const data=await readFileAsDataUrl(file,controller.signal);
          const uploaded=image?await api.sessions.pasteImage(sessionId,data,controller.signal):await api.sessions.pasteFile(sessionId,data,name,controller.signal);
          if(!controller.signal.aborted && alive.current)patch(id,{status:'ready',path:uploaded.path});
        }catch(failure){if(!controller.signal.aborted && alive.current)patch(id,{status:'error',error:failure instanceof Error?failure.message:'上传失败'});}
        finally {controllers.current.delete(id);}
      });
    }
  }
  return {items,error,enqueue,remove,clear:(ids:string[])=>{for(const id of ids)remove(id);},uploading:items.some(item=>item.status==='uploading'),failed:items.some(item=>item.status==='error'),values:()=>current.current.filter(item=>item.status==='ready' && item.path).map(item=>({kind:item.kind,name:item.name,path:item.path!})) as ConversationAttachment[]};
}

export function ConversationAttachmentPicker({items,error,disabled,onFiles,onRemove}:{items:DraftAttachment[];error:string;disabled:boolean;onFiles:(files:File[])=>void;onRemove:(id:string)=>void}) {
  const input=useRef<HTMLInputElement>(null);
  return <>
    <input ref={input} type="file" multiple hidden aria-label="选择对话附件" disabled={disabled} onChange={event=>{onFiles(Array.from(event.target.files||[]));event.target.value='';}}/>
    <button type="button" className="session-chat-attach" aria-label="上传图片或文件" title="上传图片或文件，也可粘贴截图、拖入文件" disabled={disabled} onClick={()=>input.current?.click()}><Paperclip size={17}/></button>
    {(items.length>0 || error) && <div className="session-chat-attachment-tray" aria-label="待发送附件">
      {items.map(item=><div key={item.id} className="session-chat-draft-attachment" data-status={item.status}>
        {item.thumbnail?<img src={item.thumbnail} alt={item.name}/>:item.kind==='image'?<Image size={17}/>:<File size={17}/>}
        <span><strong>{item.name}</strong>{item.status==='uploading'?<small><Loader2 size={12} className="animate-spin"/>正在上传…</small>:item.error?<small role="alert">{item.error}</small>:null}</span>
        <button type="button" aria-label={`移除附件 ${item.name}`} disabled={disabled} onClick={()=>onRemove(item.id)}><X size={13}/></button>
      </div>)}
      {error && <p role="alert" className="session-chat-error">{error}</p>}
    </div>}
  </>;
}

export function ConversationMessageAttachments({items,projectId,onOpenFile,projectPath}:{items:ConversationAttachment[];projectId:string|null;projectPath?:string;onOpenFile?:(path:string)=>void}) {
  return <ConversationImagePreviewRoot><MessageAttachments items={items} projectId={projectId} projectPath={projectPath} onOpenFile={onOpenFile}/></ConversationImagePreviewRoot>;
}
function MessageAttachments({items,projectId,projectPath}:{items:ConversationAttachment[];projectId:string|null;projectPath?:string;onOpenFile?:(path:string)=>void}) {
  const preview=useConversationImagePreview(),previewFile=useConversationFilePreview();
  if(!items.length)return null;
  return <div className="session-chat-message-attachments">{items.map((item,index)=><button type="button" key={`${item.path}-${index}`} className="session-chat-message-attachment" title={item.name} aria-label={`打开附件 ${item.name}`} onClick={()=>item.kind==='image'?preview?.({src:api.files.previewUrl(item.path,projectId||undefined),name:item.name}):previewFile?.({path:item.path,rootPath:projectPath||item.path.slice(0,item.path.lastIndexOf('/'))||'/',projectId,name:item.name})}>
    {item.kind==='image'?<img src={api.files.previewUrl(item.path,projectId||undefined)} alt={item.name} loading="lazy"/>:<File size={18}/>}
    <span>{item.name}</span>
  </button>)}</div>;
}
