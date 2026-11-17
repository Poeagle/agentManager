import {lazy,Suspense,useCallback,useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {ArrowLeft,ArrowUpRight,Bell,BellOff,CheckCheck,CheckCircle2,ChevronRight,Loader2,MessageCircleQuestion,ShieldCheck,TriangleAlert,X} from 'lucide-react';
import {api,type Project} from '../lib/api';
import {agentNativeId} from '../lib/agents';
import {notificationApi,notificationFocus,notificationIsVisible,notificationLabels,type Notification,type NotificationFilter,type NotificationPage} from '../lib/notifications';
import {useStreamStore} from '../lib/websocket';
import {hasPermission,usePermissions} from '../lib/permissions';
import './NotificationCenter.css';

const SessionConversation=lazy(()=>import('./SessionConversation').then(module=>({default:module.SessionConversation})));
const icons={question:MessageCircleQuestion,approval:ShieldCheck,error:TriangleAlert,result:CheckCircle2};
const EMPTY:Notification[]=[];
function time(value:string){return new Date(value).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});}

function NotificationDetail({notification,userId,onOpen,onRead}:{notification:Notification;userId:string;onOpen:(n:Notification,raw?:boolean)=>void;onRead:(ids:number[])=>void}) {
  const session=useQuery({queryKey:['session-record',notification.session_id],queryFn:()=>api.sessions.get(notification.session_id),retry:false});
  const [focus]=useState(()=>notificationFocus(notification));
  const viewed=useRef(false);
  const ready=useCallback(()=>{if(!viewed.current){viewed.current=true;onRead([notification.id]);}},[onRead,notification.id]);
  const current=session.data?.session;
  useEffect(()=>{if(current&&agentNativeId(current)!==notification.native_id)ready();},[current,notification.native_id,ready]);
  if(session.isPending)return <div className="notification-empty" role="status"><Loader2 size={18} className="animate-spin"/>正在打开会话…</div>;
  if(session.isError||!current)return <div className="notification-empty" role="alert">{session.error?.message||'会话暂不可用'}<button onClick={()=>void session.refetch()}>重试</button></div>;
  if(agentNativeId(current)!==notification.native_id)return <div className="notification-historical"><p>此通知来自该标签页之前的对话，当前标签已切换到新的对话。</p><pre>{notification.body}</pre><button onClick={()=>onOpen(notification)}>打开当前标签页</button></div>;
  return <Suspense fallback={<div className="notification-empty" role="status">正在加载对话…</div>}><SessionConversation
    session={current} userId={userId} draftScope="notifications" active onRaw={()=>onOpen(notification,true)}
    focusTarget={focus} onFocusTargetVisible={ready}
    onResume={()=>onOpen(notification)}
  /></Suspense>;
}

/** Freeze list positions while an item is being read/answered. New entries are
 * revealed explicitly; updates to existing entries still arrive immediately. */
function NotificationList({page,latest,filter,project,selected,onSelect,onOpen}:{page:NotificationPage;latest:Notification[];filter:NotificationFilter;project:string;selected:number|undefined;onSelect:(n:Notification)=>void;onOpen:(n:Notification)=>void}) {
  const [rows,setRows]=useState(page.notifications),[more,setMore]=useState(page.has_more),[loading,setLoading]=useState(false),[error,setError]=useState('');
  useEffect(()=>{
    const byId=new Map([...latest,...page.notifications].map(row=>[row.id,row]));
    setRows(previous=>!page.notifications.length&&!page.has_more?[]:previous.length?previous.map(row=>byId.get(row.id)||row):page.notifications);
  },[page,latest]);
  const ids=new Set(rows.map(row=>row.id)),fresh=page.notifications.filter(row=>!ids.has(row.id));
  const visible=rows.filter(row=>filter==='pending'?row.state==='pending':filter==='unread'?!row.read_at:true);
  function reveal(){setRows(previous=>[...fresh,...previous].sort((a,b)=>b.id-a.id));setMore(page.has_more||more);}
  async function older(){
    if(loading)return;setLoading(true);setError('');
    try{const next=await notificationApi.list({filter,...project?{project_id:project}:{},before:rows.at(-1)?.id});setRows(previous=>[...previous,...next.notifications.filter(row=>!previous.some(old=>old.id===row.id))]);setMore(next.has_more);}
    catch(failure){setError(failure instanceof Error?failure.message:'读取失败');}finally{setLoading(false);}
  }
  return <div className="notification-list-scroll">
    {!!fresh.length&&<button className="notification-new" onClick={reveal}>{fresh.length} 条新通知，点击显示</button>}
    {!visible.length&&<div className="notification-empty"><Bell size={24}/>{filter==='pending'?'目前没有待处理事项':filter==='unread'?'没有未读通知':'暂无通知'}{more&&<small>可以继续加载更早的通知。</small>}</div>}
    {visible.map(row=>{const Icon=icons[row.kind];return <article key={row.id} className="notification-row" data-kind={row.kind} data-selected={selected===row.id} data-unread={!row.read_at}>
      <button className="notification-row-main" onClick={()=>onSelect(row)} aria-label={`${row.project_name} · ${row.display_name} · ${row.title}`} aria-pressed={selected===row.id}>
        <span className="notification-row-source"><span className="notification-unread-dot"/><span>{row.project_name||'工作会话'} · {row.display_name}</span><time dateTime={row.created_at} title={new Date(row.created_at).toLocaleString()}>{time(row.created_at)}</time></span>
        <span className="notification-row-title"><Icon size={15}/><strong>{row.title}</strong><span>{notificationLabels[row.state]}</span>{row.muted&&<BellOff size={12} aria-label="项目已静音"/>}</span>
        <span className="notification-row-preview">{row.body}</span>
      </button>
      <div className="notification-row-actions"><button onClick={()=>onSelect(row)}>{row.state==='pending'?'直接处理':'查看消息'}<ChevronRight size={12}/></button><button onClick={()=>onOpen(row)}>打开标签页<ArrowUpRight size={12}/></button></div>
    </article>;})}
    {error&&<p role="alert" className="notification-error">{error}</p>}
    {more&&<button className="notification-load" disabled={loading} onClick={()=>void older()}>{loading?'正在读取…':'加载更早的通知'}</button>}
  </div>;
}

export function NotificationCenter({userId,projects,onOpen,onDetailChange}:{userId:string;projects:Array<Pick<Project,'id'|'name'|'owner_id'>>;onOpen:(n:Notification,raw?:boolean)=>void;onDetailChange:(open:boolean)=>void}) {
  const client=useQueryClient(),permissions=usePermissions(),canRead=hasPermission(permissions.data,'agent_api');
  const [open,setOpen]=useState(false),[filter,setFilter]=useState<NotificationFilter>('pending'),[projectSelection,setProject]=useState('');
  const ownProjects=projects.filter(project=>project.owner_id===userId);
  const project=ownProjects.some(project=>project.id===projectSelection)?projectSelection:'';
  const [selected,setSelected]=useState<Notification|null>(null),[toast,setToast]=useState<Notification|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const button=useRef<HTMLButtonElement>(null),drawer=useRef<HTMLElement>(null),known=useRef<Map<number,string>|null>(null),reading=useRef(new Set<number>()),lastSeenId=useRef(0);
  const summary=useQuery({queryKey:['notifications',userId],queryFn:()=>notificationApi.list(),enabled:canRead});
  const list=useQuery({queryKey:['notifications',userId,'list',filter,project],queryFn:()=>notificationApi.list({filter,...project?{project_id:project}:{}}),enabled:open&&canRead});
  const connected=useStreamStore(state=>state.connected);
  useEffect(()=>{if(connected)void client.invalidateQueries({queryKey:['notifications',userId]});},[connected,client,userId]);
  const refresh=useCallback(()=>client.invalidateQueries({queryKey:['notifications',userId]}),[client,userId]);
  const read=useCallback((ids:number[])=>{
    const fresh=ids.filter(id=>!reading.current.has(id));if(!fresh.length)return;
    for(const id of fresh)reading.current.add(id);
    void notificationApi.read({ids:fresh}).then(()=>refresh()).catch(failure=>setError(failure instanceof Error?failure.message:'标记已读失败')).finally(()=>{for(const id of fresh)reading.current.delete(id);});
  },[refresh]);
  useEffect(()=>{
    const rows=summary.data?.notifications;if(!rows)return;
    const visible=rows.filter(row=>!row.read_at&&notificationIsVisible(row));
    if(visible.length)read(visible.map(row=>row.id));
    const previous=known.current;
    const newestSeen=lastSeenId.current;lastSeenId.current=Math.max(newestSeen,...rows.map(row=>row.id));
    known.current=new Map(rows.map(row=>[row.id,row.state]));
    if(!previous)return;
    const incoming=rows.find(row=>!row.read_at&&!row.muted&&row.state!=='resolved'&&row.state!=='recovering'&&!notificationIsVisible(row)
      &&(row.id>newestSeen||previous.has(row.id)&&row.state==='pending'&&previous.get(row.id)!=='pending'));
    if(incoming)setToast(incoming);
  },[summary.data,read]);
  useEffect(()=>{
    const changed=()=>{const visible=(summary.data?.notifications||[]).filter(row=>!row.read_at&&notificationIsVisible(row));if(visible.length)read(visible.map(row=>row.id));};
    window.addEventListener('agentmanager:conversation-visibility',changed);window.addEventListener('focus',changed);document.addEventListener('visibilitychange',changed);
    return()=>{window.removeEventListener('agentmanager:conversation-visibility',changed);window.removeEventListener('focus',changed);document.removeEventListener('visibilitychange',changed);};
  },[summary.data,read]);
  useEffect(()=>{if(!toast)return;const timer=setTimeout(()=>setToast(null),10000);return()=>clearTimeout(timer);},[toast]);
  useEffect(()=>{onDetailChange(open&&!!selected);return()=>onDetailChange(false);},[open,selected,onDetailChange]);
  useEffect(()=>{
    if(!open)return;drawer.current?.focus({preventScroll:true});
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!event.defaultPrevented&&drawer.current?.contains(event.target as Node)){event.preventDefault();setOpen(false);button.current?.focus();}};
    document.addEventListener('keydown',key);return()=>document.removeEventListener('keydown',key);
  },[open]);
  const select=(n:Notification)=>{setFilter(n.state==='pending'?'pending':'all');setSelected(n);setOpen(true);setToast(null);};
  const jump=(n:Notification,raw=false)=>{setOpen(false);setToast(null);if(raw)onOpen(n,true);else onOpen(n);};
  async function allRead(){if(!summary.data?.through_id)return;setBusy(true);setError('');try{await notificationApi.read({through_id:summary.data.through_id,...project?{project_id:project}:{}});await refresh();}catch(failure){setError(failure instanceof Error?failure.message:'标记失败');}finally{setBusy(false);}}
  async function mute(){if(!project||!summary.data)return;setBusy(true);setError('');const muted=summary.data.preferences.muted_project_ids;try{await notificationApi.preferences(muted.includes(project)?muted.filter(id=>id!==project):[...muted,project]);await refresh();}catch(failure){setError(failure instanceof Error?failure.message:'保存失败');}finally{setBusy(false);}}
  if(!canRead)return null;
  const unread=summary.data?.unread||0,pending=summary.data?.pending||0;
  const current=selected&&(summary.data?.notifications.find(row=>row.id===selected.id)||selected);
  return <>
    <button ref={button} type="button" className="notification-bell workspace-header-button" aria-label={`消息通知${unread?`，${unread} 条未读`:''}`} aria-expanded={open} aria-controls="notification-center" onClick={()=>{if(!open){setSelected(null);setFilter(pending?'pending':'unread');}setOpen(value=>!value);}} title={`消息通知 · ${pending} 项待处理`}><Bell size={17}/>{!!unread&&<span className="notification-badge">{unread>99?'99+':unread}</span>}{summary.isError&&<span className="notification-offline" title="通知读取失败"/>}</button>
    {toast&&createPortal(<aside className="notification-toast" aria-label="新消息通知" aria-live="polite"><button className="notification-toast-close" aria-label="关闭提醒" onClick={()=>setToast(null)}><X size={14}/></button><strong>{toast.project_name} · {toast.display_name}</strong><p>{toast.title}</p><div className="notification-toast-preview">{toast.body}</div><footer><button onClick={()=>select(toast)}>查看并处理</button><button onClick={()=>jump(toast)}>打开标签页<ArrowUpRight size={12}/></button></footer></aside>,document.body)}
    {open&&createPortal(<aside id="notification-center" ref={drawer} role="dialog" aria-modal="false" aria-label="消息通知" tabIndex={-1} className="notification-drawer" data-detail={!!current}>
      <header className="notification-header"><Bell size={18}/><strong>消息通知</strong><span>待处理 {pending} · 未读 {unread}</span><button aria-label="关闭消息通知" onClick={()=>{setOpen(false);button.current?.focus();}}><X size={18}/></button></header>
      <div className="notification-toolbar"><div role="group" aria-label="通知分类">{([['pending','待处理'],['unread','未读'],['all','全部']] as const).map(([value,label])=><button key={value} aria-pressed={filter===value} onClick={()=>setFilter(value)}>{label}</button>)}</div><select aria-label="筛选通知项目" value={project} onChange={event=>setProject(event.target.value)}><option value="">全部项目</option>{ownProjects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select><button disabled={busy||!unread} title="全部标为已读，保留待处理事项" aria-label="全部标为已读" onClick={()=>void allRead()}><CheckCheck size={16}/></button>{project&&<button disabled={busy} title={summary.data?.preferences.muted_project_ids.includes(project)?'恢复项目提醒':'静音项目提醒，通知仍保留'} aria-label={summary.data?.preferences.muted_project_ids.includes(project)?'恢复项目提醒':'静音项目提醒'} onClick={()=>void mute()}><BellOff size={15}/></button>}</div>
      {(error||summary.error||list.error)&&<div className="notification-error" role="alert">{error||summary.error?.message||list.error?.message}<button onClick={()=>{setError('');void refresh();}}>重试</button></div>}
      {!connected&&<p className="notification-connection" role="status">实时通知连接已断开，正在重新连接…</p>}
      {!!summary.data?.monitoring_limited&&<p className="notification-connection" role="status">实时关注已达上限，另有 {summary.data.monitoring_limited} 个会话暂未接入提醒。</p>}
      <div className="notification-body"><div className="notification-list" data-hidden={!!current}>{list.data?<NotificationList key={`${filter}:${project}`} page={list.data} latest={summary.data?.notifications||EMPTY} filter={filter} project={project} selected={current?.id} onSelect={select} onOpen={jump}/>:<div className="notification-empty" role="status">{list.isPending?'正在读取通知…':'通知暂不可用'}</div>}</div>
      {current&&<section className="notification-detail" aria-label="通知处理"><header><button aria-label="返回通知列表" onClick={()=>setSelected(null)}><ArrowLeft size={16}/></button><div><strong>{current.project_name} · {current.display_name}</strong><small>回复将发送到此会话 · {notificationLabels[current.state]}</small></div><button onClick={()=>jump(current)}>打开标签页<ArrowUpRight size={14}/></button></header><div className="notification-detail-chat"><NotificationDetail key={`${current.id}:${current.native_id}`} notification={current} userId={userId} onOpen={jump} onRead={read}/></div></section>}
      </div>
    </aside>,document.body)}
  </>;
}
