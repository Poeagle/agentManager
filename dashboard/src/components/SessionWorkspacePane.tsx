import {useEffect,useState,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import type {Session} from '../lib/api';
import {SessionConversation} from './SessionConversation';

export function SessionWorkspacePane({session,userId,active,renderTerminal,onResume,onClose,resuming,resumeFailed,controlsHost,projectPath,onOpenFile}: {
  session:Session;userId:string;active:boolean;
  renderTerminal:(visible:boolean,suspend:boolean,onReady:()=>void)=>ReactNode;
  onResume?:()=>void;onClose?:()=>void;resuming?:boolean;resumeFailed?:boolean;
  controlsHost?:HTMLElement|null;
  projectPath?:string;onOpenFile?:(path:string)=>void;
}) {
  const canChat=session.mode!=='terminal'||!!session.codex_session_id||!!session.claude_session_id;
  const key=`agentmanager-session-view:${userId}:${session.id}`;
  const [view,setView]=useState<'chat'|'terminal'>(()=>{
    try {const saved=localStorage.getItem(key);if(saved==='chat'||saved==='terminal') return saved;}catch{/* Private mode. */}
    return canChat?'chat':'terminal';
  });
  const [ready,setReady]=useState(false);
  const [openedRaw,setOpenedRaw]=useState(view==='terminal');
  const [switchError,setSwitchError]=useState('');
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
  const controls=<div className="session-pane-switch" role="group" aria-label="会话显示方式"><button disabled={!canChat} title={canChat?'显示你的消息、Agent 进展和回答':'当前为 Shell，绑定 Agent 后可查看对话'} aria-pressed={!raw} onClick={()=>choose('chat')}>对话</button><button aria-pressed={raw} onClick={()=>choose('terminal')}>原始终端</button></div>;
  return <div className="session-pane">
    {controlsHost ? active && createPortal(controls,controlsHost) : controlsHost===undefined && <div className="session-pane-inline-controls">{controls}</div>}
    {switchError && <p role="alert" className="session-pane-warning">{switchError}</p>}
    <div className="session-pane-content">
      <div className="absolute inset-0" style={{visibility:active&&raw?'visible':'hidden',pointerEvents:active&&raw?'auto':'none'}} aria-hidden={!raw}>
        {(!ended||openedRaw||raw) && renderTerminal(active&&raw,!raw&&ready,()=>setReady(true))}
      </div>
      {canChat && <div className="absolute inset-0" style={{display:raw?'none':'block'}}><SessionConversation session={session} userId={userId} projectPath={projectPath} onOpenFile={onOpenFile} active={active&&!raw} onRaw={()=>choose('terminal')} onResume={onResume} onClose={onClose} resuming={resuming} resumeFailed={resumeFailed}/></div>}
    </div>
  </div>;
}
