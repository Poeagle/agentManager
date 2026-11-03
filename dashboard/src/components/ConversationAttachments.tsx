import {ConversationImagePreviewRoot,useConversationImagePreview,useConversationFilePreview,useConversationImageHover} from './ConversationImagePreview';
import {useEffect,useRef,useState} from 'react';
import {Paperclip,FolderOpen} from 'lucide-react';
import {api} from '../lib/api';
import {readFileAsDataUrl} from '../lib/file-data-url';
import {conversationClientId} from '../lib/conversation-timeline';
import type {ConversationAttachment} from '../lib/conversation-attachments';
import {packDirectory,readDroppedDirectory,type DirectoryFile,type DroppedEntry} from '../lib/directory-upload';

export interface DraftAttachment {id:string;name:string;kind:'image'|'file';size:number;path?:string;thumbnail?:string;status:'packing'|'uploading'|'ready'|'error';error?:string;offset?:number;progress?:number}
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
    const directories=new Map<string,File[]>(),plain:File[]=[];
    for(const file of files){if(file.webkitRelativePath){const name=file.webkitRelativePath.split('/')[0];const group=directories.get(name);if(group)group.push(file);else directories.set(name,[file]);}else plain.push(file);}
    for(const [name,files] of directories)enqueueDirectory(name,async()=>files.map(file=>({path:file.webkitRelativePath,file})));
    for(const file of plain) {
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
  function enqueueDirectory(name:string,read:(signal:AbortSignal)=>Promise<DirectoryFile[]>){
    setError('');if(current.current.length>=8){setError('每条消息最多支持 8 个附件');return;}
    const id=conversationClientId(),controller=new AbortController();controllers.current.set(id,controller);
    publish([...current.current,{id,name:name+'.zip',kind:'file',size:0,status:'packing',progress:0}]);
    queue.current=queue.current.catch(()=>{}).then(async()=>{
      if(controller.signal.aborted)return;
      try{
        const entries=await read(controller.signal);controller.signal.throwIfAborted();
        const file=await packDirectory(name,entries,controller.signal,progress=>{if(!controller.signal.aborted&&alive.current)patch(id,{progress});});
        if(file.size>35*1024*1024||current.current.filter(item=>item.id!==id).reduce((sum,item)=>sum+item.size,0)+file.size>50*1024*1024)throw Error('单个 ZIP 最多 35 MB，附件合计最多 50 MB');
        patch(id,{status:'uploading',size:file.size});
        const data=await readFileAsDataUrl(file,controller.signal),uploaded=await api.sessions.pasteFile(sessionId,data,file.name,controller.signal);
        if(!controller.signal.aborted&&alive.current)patch(id,{status:'ready',path:uploaded.path});
      }catch(error){if(!controller.signal.aborted&&alive.current)patch(id,{status:'error',error:error instanceof Error?error.message:'目录打包或上传失败'});}
      finally{controllers.current.delete(id);}
    });
  }
  function enqueueTransfer(transfer:DataTransfer){
    const entries=Array.from(transfer.items||[]).filter(item=>item.kind==='file').map(item=>({item,entry:item.webkitGetAsEntry?.() as DroppedEntry|null}));
    if(!entries.some(({entry})=>entry?.isDirectory)){enqueue(Array.from(transfer.files));return;}
    for(const {item,entry} of entries){if(entry?.isDirectory)enqueueDirectory(entry.name,signal=>readDroppedDirectory(entry,signal));else{const file=item.getAsFile();if(file)enqueue([file]);}}
  }
  // Keep sent previews alive until acknowledgement so a failed send can put
  // the original attachments back without uploading them again.
  function take(ids:string[]) {const selected=current.current.filter(item=>ids.includes(item.id));publish(current.current.filter(item=>!ids.includes(item.id)));return selected;}
  function restore(saved:DraftAttachment[]) {publish([...saved.filter(item=>!current.current.some(value=>value.id===item.id)),...current.current]);}
  function release(saved:DraftAttachment[]) {for(const item of saved)if(item.thumbnail&&!current.current.some(value=>value.id===item.id)){URL.revokeObjectURL(item.thumbnail);urls.current.delete(item.thumbnail);}}
  return {items,error,enqueue,enqueueTransfer,remove,take,restore,release,hasDraft:()=>current.current.length>0,clear:(ids:string[])=>{for(const id of ids)remove(id);},uploading:items.some(item=>item.status==='uploading'||item.status==='packing'),failed:items.some(item=>item.status==='error'),values:()=>current.current.filter(item=>item.status==='ready' && item.path).map(item=>({kind:item.kind,name:item.name,path:item.path!})) as ConversationAttachment[]};
}

export function ConversationAttachmentPicker({disabled,onFiles}:{disabled:boolean;onFiles:(files:File[])=>void}) {
  const input=useRef<HTMLInputElement>(null),directory=useRef<HTMLInputElement>(null);
  return <><input ref={input} type="file" multiple hidden aria-label="选择对话附件" disabled={disabled} onChange={event=>{onFiles(Array.from(event.target.files||[]));event.target.value='';}}/><input ref={directory} type="file" multiple hidden {...{webkitdirectory:''}} aria-label="选择对话目录" disabled={disabled} onChange={event=>{onFiles(Array.from(event.target.files||[]));event.target.value='';}}/><button type="button" className="session-chat-attach" aria-label="上传图片或文件" title="上传图片或文件，也可粘贴截图、拖入目录" disabled={disabled} onClick={()=>input.current?.click()}><Paperclip size={17}/></button><button type="button" className="session-chat-attach" aria-label="上传目录" title="选择目录，平台自动打包为 ZIP" disabled={disabled} onClick={()=>directory.current?.click()}><FolderOpen size={17}/></button></>;
}

export function ConversationMessageAttachments({items,projectId,onOpenFile,projectPath,text}:{text?:string;items:ConversationAttachment[];projectId:string|null;projectPath?:string;onOpenFile?:(path:string)=>void}) {
  return <ConversationImagePreviewRoot><MessageAttachments text={text} items={items} projectId={projectId} projectPath={projectPath} onOpenFile={onOpenFile}/></ConversationImagePreviewRoot>;
}
function MessageAttachments({items,projectId,projectPath,text}:{text?:string;items:ConversationAttachment[];projectId:string|null;projectPath?:string;onOpenFile?:(path:string)=>void}) {
  const preview=useConversationImagePreview(),previewFile=useConversationFilePreview(),hover=useConversationImageHover();
  if(!items.length)return text||null;
  const body=text??'';let cursor=0;const ordered=items.map((item,index)=>({item,index,offset:Math.min(body.length,Math.max(0,item.offset??body.length))})).sort((a,b)=>a.offset-b.offset||a.index-b.index);
  return <span className="session-chat-message-attachments">{ordered.map(({item,index,offset})=>{const prefix=body.slice(cursor,offset);cursor=offset;return <span key={`${item.path}-${index}`}>{prefix}<button type="button" key={`${item.path}-${index}`} className="session-chat-message-attachment" title={item.kind==='image'?undefined:item.name} aria-label={`打开附件 ${item.name}`} onMouseEnter={event=>{if(item.kind==='image')hover?.show({src:api.files.previewUrl(item.path,projectId||undefined),name:item.name},event.currentTarget);}} onMouseLeave={()=>hover?.hide()} onFocus={event=>{if(item.kind==='image')hover?.show({src:api.files.previewUrl(item.path,projectId||undefined),name:item.name},event.currentTarget);}} onBlur={()=>hover?.hide()} onClick={()=>item.kind==='image'?preview?.({src:api.files.previewUrl(item.path,projectId||undefined),name:item.name}):previewFile?.({path:item.path,rootPath:projectPath||item.path.slice(0,item.path.lastIndexOf('/'))||'/',projectId,name:item.name})}>
    {item.kind==='image'?'图片':'文件'} {items.slice(0,index+1).filter(other=>other.kind===item.kind).length}
  </button></span>;})}{body.slice(cursor)}</span>;
}
