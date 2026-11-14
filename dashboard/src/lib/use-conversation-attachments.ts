import {useEffect,useRef,useState} from 'react';
import {api} from './api';
import {readFileAsDataUrl} from './file-data-url';
import {conversationClientId} from './conversation-timeline';
import {scheduleConversationUpload} from './conversation-upload-queue';
import type {ConversationAttachment,DraftAttachment} from './conversation-attachments';
import {packDirectory,readDroppedDirectory,type DirectoryFile,type DroppedEntry} from './directory-upload';

export function useConversationAttachments(sessionId:string,initial:DraftAttachment[]=[]) {
  const [items,setItems]=useState<DraftAttachment[]>(initial),[error,setError]=useState('');
  const current=useRef(items),alive=useRef(true);
  const controllers=useRef(new Map<string,AbortController>()),urls=useRef(new Set<string>());
  const retries=useRef(new Map<string,()=>void>());
  useEffect(()=>{
    alive.current=true;const active=controllers.current,previews=urls.current,tasks=retries.current;
    return()=>{alive.current=false;for(const controller of active.values())controller.abort();active.clear();tasks.clear();for(const url of previews)URL.revokeObjectURL(url);previews.clear();};
  },[sessionId]);
  function publish(next:DraftAttachment[]) {current.current=next;if(alive.current)setItems(next);}
  function patch(id:string,change:Partial<DraftAttachment>) {publish(current.current.map(item=>item.id===id?{...item,...change}:item));}
  function remove(id:string) {
    controllers.current.get(id)?.abort();controllers.current.delete(id);
    retries.current.delete(id);
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
      if(file.size>(image?10:100)*1024*1024 || total+file.size>100*1024*1024 || image && images+file.size>10*1024*1024){setError('图片总大小最多 10 MB，单个文件最多 100 MB，附件合计最多 100 MB');continue;}
      const id=conversationClientId(),controller=new AbortController();controllers.current.set(id,controller);
      retries.current.set(id,()=>enqueue([file]));
      const thumbnail=image && typeof URL.createObjectURL==='function'?URL.createObjectURL(file):undefined;if(thumbnail)urls.current.add(thumbnail);
      publish([...current.current,{id,name,kind:image?'image':'file',size:file.size,thumbnail,status:'queued'}]);
      void scheduleConversationUpload(sessionId,async()=>{
        if(controller.signal.aborted)return;
        try {
          patch(id,{status:'uploading'});
          const data=await readFileAsDataUrl(file,controller.signal);
          const uploaded=image?await api.sessions.pasteImage(sessionId,data,controller.signal):await api.sessions.pasteFile(sessionId,data,name,controller.signal);
          if(!controller.signal.aborted && alive.current){patch(id,{status:'ready',path:uploaded.path});retries.current.delete(id);}
        }catch(failure){if(!controller.signal.aborted && alive.current)patch(id,{status:'error',error:failure instanceof Error?failure.message:'上传失败'});}
        finally {controllers.current.delete(id);}
      });
    }
  }
  function enqueueDirectory(name:string,read:(signal:AbortSignal)=>Promise<DirectoryFile[]>){
    setError('');if(current.current.length>=8){setError('每条消息最多支持 8 个附件');return;}
    const id=conversationClientId(),controller=new AbortController();controllers.current.set(id,controller);
    retries.current.set(id,()=>enqueueDirectory(name,read));
    publish([...current.current,{id,name:name+'.zip',kind:'file',size:0,status:'queued',progress:0}]);
    void scheduleConversationUpload(sessionId,async()=>{
      if(controller.signal.aborted)return;
      try{
        patch(id,{status:'packing',progress:0});
        const entries=await read(controller.signal);controller.signal.throwIfAborted();
        const file=await packDirectory(name,entries,controller.signal,progress=>{if(!controller.signal.aborted&&alive.current)patch(id,{progress});});
        if(file.size>100*1024*1024||current.current.filter(item=>item.id!==id).reduce((sum,item)=>sum+item.size,0)+file.size>100*1024*1024)throw Error('单个 ZIP 最多 100 MB，附件合计最多 100 MB');
        patch(id,{status:'uploading',size:file.size});
        const data=await readFileAsDataUrl(file,controller.signal),uploaded=await api.sessions.pasteFile(sessionId,data,file.name,controller.signal);
        if(!controller.signal.aborted&&alive.current){patch(id,{status:'ready',path:uploaded.path});retries.current.delete(id);}
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
  function retry(id:string,offset?:number){const index=current.current.findIndex(item=>item.id===id&&item.status==='error'),task=retries.current.get(id);if(index<0||!task)return;const previous=current.current[index],known=new Set(current.current.map(item=>item.id));remove(id);task();const replacement=current.current.find(item=>!known.has(item.id));if(replacement){const next=current.current.filter(item=>item.id!==replacement.id);next.splice(index,0,{...replacement,offset:offset??previous.offset});publish(next);}}
  return {items,error,enqueue,enqueueTransfer,remove,retry,take,restore,release,hasDraft:()=>current.current.length>0,clear:(ids:string[])=>{for(const id of ids)remove(id);},uploading:items.some(item=>['queued','uploading','packing'].includes(item.status)),failed:items.some(item=>item.status==='error'),values:()=>current.current.filter(item=>item.status==='ready' && item.path).map(item=>({kind:item.kind,name:item.name,path:item.path!})) as ConversationAttachment[]};
}
