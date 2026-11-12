import {useEffect,useRef,useState} from 'react';
import {api} from '../lib/api';
import {Dialog} from './Dialog';
import {copyConversationText} from './ConversationMarkdown';
import type {DraftAttachment} from './ConversationAttachments';

/** Optimize the active chat draft; preview and explicit apply never submit it. */
export function ConversationPromptEnhancer({sessionId,active,canEdit,value,onApply,attachments=[]}:{sessionId:string;active:boolean;canEdit:boolean;value:string;onApply:(text:string)=>void;attachments?:DraftAttachment[]}) {
  const current=useRef({value,onApply,attachments});current.current={value,onApply,attachments};
  const signature=(items:DraftAttachment[])=>JSON.stringify(items.map(({id,path,name,status})=>[id,path,name,status]));
  const [preview,setPreview]=useState<{original:string;result:string;loading:boolean;error:string;rounds?:number;copied?:boolean;attachmentSignature?:string;attachmentNames?:string[];warnings?:string[]}|null>(null);
  const controller=useRef<AbortController|null>(null);
  function close(){controller.current?.abort();controller.current=null;setPreview(null);}
  useEffect(()=>{
    if(!active){close();return;}
    function enhance(event:Event){
      if((event as CustomEvent).detail?.sessionId!==sessionId)return;
      controller.current?.abort();const original=current.current.value, items=current.current.attachments;
      const attachmentSignature=signature(items),attachmentNames=items.map(item=>item.name);
      if(items.some(item=>item.status!=='ready'||!item.path)){setPreview({original,result:'',loading:false,error:'请等待所有附件上传完成后再优化。',attachmentSignature,attachmentNames});return;}
      if(!canEdit||(!original.trim()&&!items.length)){setPreview({original,result:'',loading:false,error:canEdit?'请先在对话输入框填写要优化的文字。':'当前会话暂不可编辑。'});return;}
      const request=new AbortController();controller.current=request;setPreview({original,result:'',loading:true,error:'',attachmentSignature,attachmentNames});
      void api.promptEnhancer.enhance({session_id:sessionId,prompt:original.trim()?original:'请查看附件。',attachments:items.map(item=>({kind:item.kind,name:item.name,path:item.path!}))},request.signal).then(result=>{
        if(request.signal.aborted)return;
        setPreview({original,result:result.prompt,loading:false,error:result.prompt.trim()?'':'优化模型返回了空内容，原输入已保留。',rounds:result.context?.included_rounds,warnings:result.warnings,attachmentSignature,attachmentNames});
      }).catch(error=>{if(!request.signal.aborted)setPreview({original,result:'',loading:false,error:error instanceof Error?error.message:'提示词优化失败',attachmentSignature,attachmentNames});});
    }
    window.addEventListener('agentmanager:enhance-native-prompt',enhance);
    return()=>{window.removeEventListener('agentmanager:enhance-native-prompt',enhance);controller.current?.abort();};
  },[active,sessionId,canEdit]);
  if(!preview||!active)return null;
  const changed=value!==preview.original||signature(attachments)!==(preview.attachmentSignature??signature([]));
  return <Dialog title="优化当前输入" size="lg" onClose={close}>
    <div className="grid gap-4 md:grid-cols-2 text-sm">
      <div><p className="mb-2 font-medium">原始输入</p><pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words">{preview.original||'尚未输入文字'}</pre></div>
      <label className="flex flex-col gap-2">优化结果<textarea aria-label="优化结果" className="min-h-48 rounded border p-2" style={{background:'var(--bg-primary)',borderColor:'var(--border)'}} disabled={preview.loading} value={preview.result} onChange={event=>setPreview({...preview,result:event.target.value,copied:false})}/></label>
    </div>
    {!!preview.attachmentNames?.length&&<p className="mt-3 text-xs">附件将保留在输入框：{preview.attachmentNames.join('、')}</p>}
    {preview.warnings?.map(warning=><p key={warning} role="status" className="mt-2 text-xs">{warning}</p>)}
    {preview.loading&&<p role="status" className="mt-3 text-sm">正在优化…</p>}
    {preview.rounds!==undefined&&<p className="mt-2 text-xs">已参考最近 {preview.rounds} 轮对话</p>}
    {preview.error&&<p role="alert" className="session-chat-error mt-3">{preview.error}</p>}
    {changed&&<p role="status" className="mt-3 text-sm">输入已变化，请关闭后重新优化，当前草稿已保留。</p>}
    <footer className="mt-4 flex justify-end gap-3 text-sm">
      <button type="button" onClick={close}>取消</button>
      <button type="button" disabled={!preview.result.trim()||preview.loading} onClick={()=>void copyConversationText(preview.result).then(()=>setPreview(current=>current===preview?{...preview,copied:true}:current)).catch(()=>setPreview(current=>current===preview?{...preview,error:'复制失败，请手动选择结果复制。'}:current))}>{preview.copied?'已复制':'复制优化结果'}</button>
      <button type="button" className="rounded px-3 py-2 text-white disabled:opacity-40" style={{background:'var(--accent)'}} disabled={!canEdit||changed||!preview.result.trim()||preview.loading} onClick={()=>{current.current.onApply(preview.result);close();}}>应用到输入框</button>
    </footer>
  </Dialog>;
}
