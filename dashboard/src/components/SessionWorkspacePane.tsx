import {useEffect,useRef,useState,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import type {Session} from '../lib/api';
import {SessionConversation} from './SessionConversation';
import {Dialog} from './Dialog';
import {useQueryClient} from '@tanstack/react-query';
import type {ConversationControlsData} from '../lib/api';
import {RotateCw} from 'lucide-react';
import {hasPermission,usePermissions} from '../lib/permissions';

export function SessionWorkspacePane({session,userId,active,renderTerminal,onResume,onReload,onClose,resuming,resumeFailed,controlsHost,projectPath,onOpenFile}: {
  session:Session;userId:string;active:boolean;
  renderTerminal:(visible:boolean,suspend:boolean,onReady:()=>void)=>ReactNode;
  onResume?:()=>void;onReload?:()=>Promise<void>;onClose?:()=>void;resuming?:boolean;resumeFailed?:boolean;
  controlsHost?:HTMLElement|null;
  projectPath?:string;onOpenFile?:(path:string)=>void;
}) {
  const queryClient=useQueryClient();
  function terminalReady(){setReady(true);const key=['conversation-controls',session.id],cached=queryClient.getQueryData<ConversationControlsData>(key);if(cached?.loaded&&!cached.can_edit)void queryClient.invalidateQueries({queryKey:key});}
  const canChat=session.mode!=='terminal'||!!session.codex_session_id||!!session.claude_session_id;
  const key=`agentmanager-session-view:${userId}:${session.id}`;
  const [view,setView]=useState<'chat'|'terminal'>(()=>{
    try {const saved=localStorage.getItem(key);if(saved==='chat'||saved==='terminal') return saved;}catch{/* Private mode. */}
    return canChat?'chat':'terminal';
  });
  const [ready,setReady]=useState(false);
  const [openedRaw,setOpenedRaw]=useState(view==='terminal');
  const [switchError,setSwitchError]=useState('');
  const [reloadOpen,setReloadOpen]=useState(false),[reloading,setReloading]=useState(false),[reloadError,setReloadError]=useState('');
  const reloadLock=useRef(false),cancel=useRef<HTMLButtonElement>(null),permissions=usePermissions();
  function openReload(){let rawDraft=false;window.dispatchEvent(new CustomEvent('agentmanager:check-terminal-draft',{detail:{sessionId:session.id,respond:(value:boolean)=>{rawDraft ||= value;}}}));if(rawDraft){setSwitchError('原始终端还有未发送的内容，请先发送或清空后重载。');return;}setSwitchError('');setReloadError('');setReloadOpen(true);}
  async function reload(){if(reloadLock.current||!onReload)return;reloadLock.current=true;setReloading(true);setReloadError('');try{await onReload();setReloadOpen(false);}catch(error){setReloadError(error instanceof Error?error.message:'重载失败，请重试');}finally{reloadLock.current=false;setReloading(false);}}
  useEffect(()=>{if(!active&&!reloading)setReloadOpen(false);},[active,reloading]);
  useEffect(()=>{if(resuming||session.status==='pending'||session.status==='launching') setReady(false);},[resuming,session.status]);
  const raw=view==='terminal'||!canChat;
  const ended=['completed','failed','cancelled'].includes(session.status);
  function choose(next:'chat'|'terminal') {
    if(next==='chat' && raw && !ended) {
      let hasDraft=false;
      window.dispatchEvent(new CustomEvent('agentmanager:check-terminal-draft',{detail:{sessionId:session.id,respond:(value:boolean)=>{hasDraft ||= value;}}}));
      if(hasDraft) {setSwitchError('原始终端还有未发送的内容，请先发送或清空后切换。');return;}
    }
    setSwitchError('');setView(next);if(next==='terminal') setOpenedRaw(true);try{localStorage.setItem(key,next);}catch{/* Storage unavailable. */}
  }
  const controls=<div className="session-pane-switch" role="group" aria-label="会话显示方式"><button disabled={!canChat} title={canChat?'显示你的消息、Agent 进展和回答':'当前为 Shell，绑定 Agent 后可查看对话'} aria-pressed={!raw} onClick={()=>choose('chat')}>对话</button><button aria-pressed={raw} onClick={()=>choose('terminal')}>原始终端</button>{onReload&&session.cli_type==='codex'&&session.codex_session_id&&hasPermission(permissions.data,'agent_api','write')&&<button type="button" className="session-pane-reload" disabled={reloading||resuming} title="保留历史，重新启动此标签页的 Codex 客户端" onClick={openReload}><RotateCw size={12} className={reloading?'animate-spin':''}/>重载标签页</button>}</div>;
  return <div className="session-pane">
    {reloadOpen&&<Dialog title="重载标签页" onClose={()=>setReloadOpen(false)} busy={reloading} initialFocus={cancel}>
      <p className="text-sm leading-relaxed">重载会中断此会话当前正在执行的任务，并使用服务器已安装的 Codex 重新打开同一段对话。历史消息、对话输入框中未发送的文字和附件会保留。</p>
      <p className="mt-2 text-xs leading-relaxed" style={{color:'var(--text-muted)'}}>会话创建版本是历史记录，重载后仍会保留；实际运行版本可在“详情”中查看。</p>
      {reloadError&&<p role="alert" className="session-chat-error">{reloadError}</p>}
      <footer className="mt-4 flex justify-end gap-2 text-xs"><button ref={cancel} type="button" disabled={reloading} onClick={()=>setReloadOpen(false)} className="rounded border px-3 py-2" style={{borderColor:'var(--border)'}}>取消</button><button type="button" disabled={reloading} onClick={()=>void reload()} className="rounded px-3 py-2 text-white" style={{background:'var(--accent)'}}>{reloading?'正在重载…':'重载并保留对话'}</button></footer>
    </Dialog>}
    {controlsHost ? active && createPortal(controls,controlsHost) : controlsHost===undefined && <div className="session-pane-inline-controls">{controls}</div>}
    {switchError && <p role="alert" className="session-pane-warning">{switchError}</p>}
    <div className="session-pane-content">
      <div className="absolute inset-0" style={{visibility:active&&raw?'visible':'hidden',pointerEvents:active&&raw?'auto':'none'}} aria-hidden={!raw}>
        {(!ended||openedRaw||raw) && renderTerminal(active&&raw,!raw&&ready,terminalReady)}
      </div>
      {canChat && <div className="absolute inset-0" style={{display:raw?'none':'block'}}><SessionConversation session={session} userId={userId} projectPath={projectPath} onOpenFile={onOpenFile} active={active&&!raw} onRaw={()=>choose('terminal')} onResume={onResume} onClose={onClose} resuming={resuming} resumeFailed={resumeFailed}/></div>}
    </div>
  </div>;
}
