import {useRef,useState} from 'react';
import {Power,Trash2} from 'lucide-react';
import {Dialog} from './Dialog';

interface CloseTabModalProps {
  label:string;type:'session'|'terminal'|'agent'|'project';sessionCount?:number;
  onStop:()=>Promise<void>;onDelete?:()=>Promise<void>;onCancel:()=>void;
}
export function CloseTabModal({label,type,sessionCount,onStop,onDelete,onCancel}:CloseTabModalProps) {
  const cancel=useRef<HTMLButtonElement>(null),lock=useRef(false);
  const [busy,setBusy]=useState<'stop'|'delete'|null>(null),[error,setError]=useState('');
  async function act(action:'stop'|'delete') {
    if(lock.current)return;lock.current=true;setBusy(action);setError('');
    try {await (action==='delete'?onDelete!():onStop());}
    catch(failure){setError(failure instanceof Error?failure.message:'操作失败，请重试');}
    finally{lock.current=false;setBusy(null);}
  }
  return <Dialog title={`关闭“${label}”`} onClose={onCancel} busy={!!busy} initialFocus={cancel}>
    <p className="text-sm leading-relaxed">{type==='project'?`此项目有 ${sessionCount??0} 个会话正在运行。停止并关闭会结束这些会话的运行，保留会话历史。`:'停止并关闭：结束当前运行，保留会话记录，之后可查看或恢复。'}</p>
    {onDelete&&<p className="mt-2 text-sm leading-relaxed" style={{color:'var(--text-secondary)'}}>删除会话：先停止运行，再永久删除会话记录和已保存的输出，无法撤销。</p>}
    {error&&<p role="alert" className="mt-3 text-sm" style={{color:'var(--error)'}}>{error}</p>}
    <footer className="mt-5 flex flex-wrap justify-end gap-2 text-xs">
      <button ref={cancel} type="button" disabled={!!busy} onClick={onCancel} className="rounded-md border px-3 py-2 disabled:opacity-50" style={{borderColor:'var(--border)'}}>取消</button>
      <button type="button" disabled={!!busy} onClick={()=>void act('stop')} className="flex items-center gap-1.5 rounded-md border px-3 py-2 disabled:opacity-50" style={{borderColor:'var(--border)',background:'var(--bg-secondary)'}}><Power size={13}/>{busy==='stop'?'正在停止…':'停止并关闭'}</button>
      {onDelete&&<button type="button" disabled={!!busy} onClick={()=>void act('delete')} className="flex items-center gap-1.5 rounded-md px-3 py-2 text-white disabled:opacity-50" style={{background:'var(--error,#ef4444)'}}><Trash2 size={13}/>{busy==='delete'?'正在删除…':'删除会话'}</button>}
    </footer>
  </Dialog>;
}
