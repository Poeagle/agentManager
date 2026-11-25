import {lazy,Suspense,useCallback,useEffect,useId,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {useQuery,useInfiniteQuery,useQueryClient} from '@tanstack/react-query';
import {ArrowLeft,ArrowUpRight,Bell,BellOff,ChevronDown,Folder,Loader2} from 'lucide-react';
import {api,type Project} from '../lib/api';
import {agentNativeId} from '../lib/agents';
import {notificationApi,notificationFocus,notificationIsVisible,notificationTime,type Notification,type NotificationFilter} from '../lib/notifications';
import {useStreamStore} from '../lib/websocket';
import {hasPermission,usePermissions} from '../lib/permissions';
import {Dialog} from './Dialog';
import './NotificationCenter.css';

const SessionConversation=lazy(()=>import('./SessionConversation').then(module=>({default:module.SessionConversation})));
const reminderStatus:Record<Notification['kind'],string>={result:'完成',error:'报错',question:'等待输入',approval:'等待授权'};

function NotificationDetail({notification,userId,onOpen,onRead}:{notification:Notification;userId:string;onOpen:(n:Notification,raw?:boolean)=>void;onRead:(ids:number[])=>void}) {
  const session=useQuery({queryKey:['session-record',notification.session_id],queryFn:()=>api.sessions.get(notification.session_id),retry:false});
  const [focus]=useState(()=>notificationFocus(notification));
  const viewed=useRef(false),targetReached=useRef(false);
  const ready=useCallback(()=>{targetReached.current=true;if(document.visibilityState!=='visible'||!document.hasFocus())return;if(!viewed.current){viewed.current=true;onRead([notification.id]);}},[onRead,notification.id]);
  useEffect(()=>{const recheck=()=>{if(targetReached.current)ready();};window.addEventListener('focus',recheck);document.addEventListener('visibilitychange',recheck);return()=>{window.removeEventListener('focus',recheck);document.removeEventListener('visibilitychange',recheck);};},[ready]);
  const current=session.data?.session;
  useEffect(()=>{if(current&&agentNativeId(current)!==notification.native_id)ready();},[current,notification.native_id,ready]);
  if(session.isPending)return <div className="notification-empty" role="status"><Loader2 size={18} className="animate-spin"/>正在打开会话…</div>;
  if(session.isError||!current)return <div className="notification-empty" role="alert">{session.error?.message||'会话暂不可用'}<button onClick={()=>void session.refetch()}>重试</button></div>;
  if(agentNativeId(current)!==notification.native_id)return <div className="notification-historical"><p>此通知来自该标签页之前的对话，当前标签已切换到新的对话。</p><pre>{notification.body}</pre><button onClick={()=>onOpen(notification)}>打开当前标签页</button></div>;
  return <Suspense fallback={<div className="notification-empty" role="status">正在加载对话…</div>}><SessionConversation
    session={current} userId={userId} draftScope="notifications" presentation="notification" active onRaw={()=>onOpen(notification,true)}
    focusTarget={focus} onFocusTargetVisible={ready}
    onResume={()=>onOpen(notification)}
  /></Suspense>;
}

/** Query pages remain authoritative, including removals. New rows appear on
 * the next stream invalidation while the selected conversation stays mounted. */
function NotificationList({userId,filter,project,selected,onSelect}:{userId:string;filter:NotificationFilter;project:string;selected:number|undefined;onSelect:(n:Notification)=>void}) {
  const groupId=useId(),[collapsed,setCollapsed]=useState<Set<string|null>>(()=>new Set());
  const query=useInfiniteQuery({queryKey:['notifications',userId,'list',filter,project],initialPageParam:undefined as number|undefined,
    queryFn:({pageParam})=>notificationApi.list({filter,...project?{project_id:project}:{},...pageParam?{before:pageParam}:{}}),
    getNextPageParam:page=>page.has_more?page.notifications.at(-1)?.id:undefined});
  const seen=new Set<number>();
  const rows=(query.data?.pages.flatMap(page=>page.notifications)||[]).filter(row=>{
    if(seen.has(row.id)||row.state==='resolved'||row.state==='submitted')return false;
    seen.add(row.id);return true;
  });
  const groups=new Map<string|null,{name:string;rows:Notification[]}>();
  for(const row of rows){
    let group=groups.get(row.project_id);
    if(!group){group={name:row.project_name||'工作会话',rows:[]};groups.set(row.project_id,group);}
    group.rows.push(row);
  }
  return <div className="notification-list-scroll">
    {query.isPending&&<div className="notification-empty" role="status"><Loader2 size={16} className="animate-spin"/>正在读取通知…</div>}
    {!query.isPending&&!query.isError&&!rows.length&&<div className="notification-empty"><Bell size={24}/>{filter==='pending'?'目前没有待处理事项':filter==='unread'?'没有未读通知':'暂无通知'}</div>}
    {[...groups].map(([projectId,group],index)=><section key={JSON.stringify(projectId)} className="notification-project" role="group" aria-label={group.name}>
      <h4><button className="notification-project-toggle" aria-expanded={!collapsed.has(projectId)} aria-controls={`${groupId}-${index}`} onClick={()=>setCollapsed(previous=>{const next=new Set(previous);if(next.has(projectId))next.delete(projectId);else next.add(projectId);return next;})}>
        <ChevronDown size={12} className="notification-project-chevron"/><Folder size={14}/><span title={group.name}>{group.name}</span>
      </button></h4>
      <div id={`${groupId}-${index}`} hidden={collapsed.has(projectId)} className="notification-project-tabs">
    {group.rows.map(row=><article key={row.id} className="notification-row" data-kind={row.kind} data-selected={selected===row.id} data-unread={!row.read_at}>
      <button className="notification-row-main" onClick={()=>onSelect(row)} aria-label={`${row.project_name} · ${row.display_name}`} aria-pressed={selected===row.id}>
        <span className="notification-row-source"><strong title={row.display_name}>{row.display_name}</strong><time dateTime={row.created_at}>{notificationTime(row.created_at)}</time></span>
      </button>
    </article>)}
      </div>
    </section>)}
    {query.error&&<p role="alert" className="notification-error">{query.error.message}<button onClick={()=>void query.refetch()}>重试</button></p>}
    {query.hasNextPage&&<button className="notification-load" disabled={query.isFetchingNextPage} onClick={()=>void query.fetchNextPage()}>{query.isFetchingNextPage?'正在读取…':'加载更早的通知'}</button>}
  </div>;
}

export function NotificationCenter({userId,projects,onOpen,onDetailChange}:{userId:string;projects:Array<Pick<Project,'id'|'name'|'owner_id'>>;onOpen:(n:Notification,raw?:boolean)=>void;onDetailChange:(open:boolean)=>void}) {
  const client=useQueryClient(),permissions=usePermissions(),canRead=hasPermission(permissions.data,'agent_api');
  const [open,setOpen]=useState(false),[filter,setFilter]=useState<NotificationFilter>('pending'),[projectSelection,setProject]=useState('');
  const ownProjects=projects.filter(project=>project.owner_id===userId);
  const project=ownProjects.some(project=>project.id===projectSelection)?projectSelection:'';
  const [selected,setSelected]=useState<Notification|null>(null),[reminderIds,setReminderIds]=useState<number[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const button=useRef<HTMLButtonElement>(null),reading=useRef(new Set<number>()),failedReads=useRef(new Set<number>());
  const summary=useQuery({queryKey:['notifications',userId],queryFn:()=>notificationApi.list(),enabled:canRead});
  const connected=useStreamStore(state=>state.connected);
  useEffect(()=>{if(connected)void client.invalidateQueries({queryKey:['notifications',userId]});},[connected,client,userId]);
  const refresh=useCallback(()=>client.invalidateQueries({queryKey:['notifications',userId]}),[client,userId]);
  const read=useCallback((ids:number[])=>{
    const fresh=ids.filter(id=>!reading.current.has(id));if(!fresh.length)return;
    for(const id of fresh)reading.current.add(id);
    void notificationApi.read({ids:fresh}).then(()=>{for(const id of fresh)failedReads.current.delete(id);return refresh();}).catch(failure=>{for(const id of fresh)failedReads.current.add(id);setError(failure instanceof Error?failure.message:'通知状态更新失败');}).finally(()=>{for(const id of fresh)reading.current.delete(id);});
  },[refresh]);
  useEffect(()=>{
    const rows=summary.data?.notifications;if(!rows)return;
    window.dispatchEvent(new Event('agentmanager:notifications-changed'));
    const visible=rows.filter(row=>!row.read_at&&notificationIsVisible(row));
    if(visible.length)read(visible.map(row=>row.id));
    const visibleIds=new Set(visible.map(row=>row.id));
    const unread=rows.filter(row=>!row.parent_session_id&&!row.read_at&&!row.muted&&(row.state==='info'||row.state==='pending')&&!visibleIds.has(row.id));
    setReminderIds(previous=>{
      const incoming=new Set(unread.map(row=>row.id).reverse());
      const retained=previous.filter(id=>incoming.delete(id));
      return [...retained,...incoming];
    });
  },[summary.data,read]);
  useEffect(()=>{
    const changed=()=>{const visible=(summary.data?.notifications||[]).filter(row=>!row.read_at&&notificationIsVisible(row));if(visible.length)read(visible.map(row=>row.id));};
    window.addEventListener('agentmanager:conversation-visibility',changed);window.addEventListener('focus',changed);document.addEventListener('visibilitychange',changed);
    return()=>{window.removeEventListener('agentmanager:conversation-visibility',changed);window.removeEventListener('focus',changed);document.removeEventListener('visibilitychange',changed);};
  },[summary.data,read]);
  useEffect(()=>{onDetailChange(open);return()=>onDetailChange(false);},[open,onDetailChange]);
  const select=(n:Notification)=>{if(n.kind==='result'&&!n.read_at)read([n.id]);setFilter(n.state==='pending'?'pending':'all');setSelected(n);setOpen(true);};
  const jump=(n:Notification,raw=false)=>{if(n.kind==='result'&&!n.read_at)read([n.id]);setOpen(false);if(raw)onOpen(n,true);else onOpen(n);};
  async function mute(){if(!project||!summary.data)return;setBusy(true);setError('');const muted=summary.data.preferences.muted_project_ids;try{await notificationApi.preferences(muted.includes(project)?muted.filter(id=>id!==project):[...muted,project]);await refresh();}catch(failure){setError(failure instanceof Error?failure.message:'保存失败');}finally{setBusy(false);}}
  if(!canRead)return null;
  const unread=summary.data?.unread||0,pending=summary.data?.pending||0;
  const current=selected&&(summary.data?.notifications.find(row=>row.id===selected.id)||selected);
  const notificationsById=new Map(summary.data?.notifications.map(row=>[row.id,row]));
  const reminders=reminderIds.flatMap(id=>{const row=notificationsById.get(id);return row?[row]:[];});
  return <>
    <button ref={button} type="button" className="notification-bell workspace-header-button" aria-label={`消息通知${unread?`，${unread} 条未读`:''}`} aria-expanded={open} aria-controls="notification-center" onClick={()=>{if(!open){setSelected(null);setFilter(pending?'pending':'unread');}setOpen(value=>!value);}} title={`消息通知 · ${pending} 项待处理`}><Bell size={14}/>{!!unread&&<span className="notification-badge">{unread>99?'99+':unread}</span>}{summary.isError&&<span className="notification-offline" title="通知读取失败"/>}</button>
    {!!reminders.length&&!open&&createPortal(<aside className="notification-toast-stack" aria-label="新消息通知" aria-live="polite" aria-relevant="additions">
      {reminders.map(reminder=>{
        const label=`${reminder.project_name||'工作会话'}｜${reminder.display_name}`;
        const status=reminderStatus[reminder.kind];
        return <button key={reminder.id} type="button" className="notification-toast" data-kind={reminder.kind}
          aria-description={status} title={`${label}（${status}）`} onClick={()=>reminder.project_id?jump(reminder):select(reminder)}>
          <span className="notification-toast-dot" aria-hidden="true"/>
          <span className="notification-toast-label">{label}</span>
        </button>;
      })}
    </aside>,document.body)}
    {open&&<Dialog title="消息通知" size="image" width={current?1120:640} maxWidth="calc(100vw - 24px)" className="notification-dialog" actions={<>
        <div className="notification-toolbar"><div role="group" aria-label="通知分类">{([['pending','待处理'],['unread','未读'],['all','全部']] as const).map(([value,label])=><button key={value} aria-pressed={filter===value} onClick={()=>setFilter(value)}>{label}</button>)}</div><select aria-label="筛选通知项目" value={project} onChange={event=>setProject(event.target.value)}><option value="">全部项目</option>{ownProjects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select>{project&&<button disabled={busy} title={summary.data?.preferences.muted_project_ids.includes(project)?'恢复项目提醒':'静音项目提醒，通知仍保留'} aria-label={summary.data?.preferences.muted_project_ids.includes(project)?'恢复项目提醒':'静音项目提醒'} onClick={()=>void mute()}><BellOff size={15}/></button>}</div>
        <span className="notification-counts">待处理 {pending} · 未读 {unread}</span>
      </>} onClose={()=>setOpen(false)}>
      <div id="notification-center" className="notification-window" data-detail={!!current}>
      {(error||summary.error)&&<div className="notification-error" role="alert">{error||summary.error?.message}<button onClick={()=>{setError('');if(failedReads.current.size)read([...failedReads.current]);void refresh();}}>重试</button></div>}
      {!connected&&<p className="notification-connection" role="status">实时通知连接已断开，正在重新连接…</p>}
      {!!summary.data?.monitoring_limited&&<p className="notification-connection" role="status">实时关注已达上限，另有 {summary.data.monitoring_limited} 个会话暂未接入提醒。</p>}
      <div className="notification-body"><section className="notification-list" aria-label="通知列表" data-hidden={!!current}><NotificationList key={`${filter}:${project}`} userId={userId} filter={filter} project={project} selected={current?.id} onSelect={select}/></section>
      {current&&<section className="notification-detail" aria-label="通知处理"><header><button aria-label="返回通知列表" onClick={()=>setSelected(null)}><ArrowLeft size={16}/></button><div><strong>{current.project_name} · {current.display_name}</strong><small>回复将发送到此会话</small></div><button onClick={()=>jump(current)}>打开标签页<ArrowUpRight size={14}/></button></header><div className="notification-detail-chat"><NotificationDetail key={`${current.id}:${current.native_id}`} notification={current} userId={userId} onOpen={jump} onRead={read}/></div></section>}
      </div>
      </div>
    </Dialog>}
  </>;
}
