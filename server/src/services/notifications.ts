import {getDb} from '../db/index.js';
import {findUserById,userCanUseSessionTool} from '../auth.js';
import {userHasPermission} from './rbac.js';
import {broadcastEphemeral} from './event-store.js';
import {sessionPresenter} from './session-labels.js';
import {nativeConversationId} from './session-identity.js';
import {agentForSession} from './agents/index.js';
import type {AgentSession} from './agents/types.js';

export type NotificationKind='question'|'approval'|'result'|'error';
export type NotificationState='pending'|'recovering'|'submitted'|'resolved'|'info';
export interface Notification {
  id:number;user_id:string;session_id:string;native_id:string;source_id:string;
  message_id:string|null;turn_id:string|null;kind:NotificationKind;state:NotificationState;
  title:string;body:string;read_at:string|null;created_at:string;updated_at:string;
}
export type NotificationSession=AgentSession&{id:string;project_id:string|null;created_by_user_id:string|null;mode:string;status:string};


export function notificationSession(id:string):NotificationSession|undefined {
  return getDb().prepare('SELECT * FROM sessions WHERE id=?').get(id) as NotificationSession|undefined;
}
/** Notifications are personal, even for administrators, and recheck current access. */
export function canReadNotifications(session:NotificationSession,userId:string):boolean {
  const user=findUserById(userId);
  return !!(user&&!user.disabled&&session.created_by_user_id===userId&&userHasPermission(userId,'agent_api')
    &&userCanUseSessionTool(userId,session.id,agentForSession(session).descriptor.id,session.mode==='terminal'?'terminal':'session'));
}
export function notificationChanged(userId:string,id?:number) {
  broadcastEphemeral({type:'notification.changed',data:{user_id:userId,...id?{id}:{}}});
}
export function notificationPreferences(userId:string):{muted_project_ids:string[]} {
  const row=getDb().prepare("SELECT value FROM user_ui_state WHERE user_id=? AND key='notification-preferences'").get(userId) as {value:string}|undefined;
  try {const value=JSON.parse(row?.value||'{}');return {muted_project_ids:Array.isArray(value.muted_project_ids)?value.muted_project_ids.filter((id:unknown)=>typeof id==='string').slice(0,1000):[]};}
  catch{return {muted_project_ids:[]};}
}
export function saveNotificationPreferences(userId:string,muted:string[]) {
  getDb().prepare(`INSERT INTO user_ui_state(user_id,key,value) VALUES(?,'notification-preferences',?)
    ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value,updated_at=datetime('now')`).run(userId,JSON.stringify({muted_project_ids:[...new Set(muted)]}));
  notificationChanged(userId);
}

export function putNotification(session:NotificationSession,input:Pick<Notification,'source_id'|'kind'|'state'|'title'|'body'>&Partial<Pick<Notification,'message_id'|'turn_id'>>) {
  const userId=session.created_by_user_id,native=nativeConversationId(session);
  if(!userId||!native||!canReadNotifications(session,userId))return;
  const now=new Date().toISOString();
  const result=getDb().prepare(`INSERT INTO notifications(user_id,session_id,native_id,source_id,kind,state,title,body,message_id,turn_id,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,session_id,native_id,kind,source_id) DO UPDATE SET
    state=excluded.state,title=excluded.title,body=excluded.body,message_id=COALESCE(excluded.message_id,notifications.message_id),updated_at=excluded.updated_at,
    read_at=CASE WHEN excluded.state='pending' AND notifications.state!='pending' THEN NULL ELSE notifications.read_at END
    WHERE notifications.state!=excluded.state OR notifications.title!=excluded.title OR notifications.body!=excluded.body
      OR (excluded.message_id IS NOT NULL AND notifications.message_id IS NOT excluded.message_id)`)
    .run(userId,session.id,native,input.source_id,input.kind,input.state,input.title.slice(0,240),input.body.slice(0,12000),input.message_id||null,input.turn_id||null,now,now);
  if(result.changes)notificationChanged(userId);
}
export function updateNotificationState(session:NotificationSession,kind:NotificationKind,sourceId:string,state:NotificationState) {
  const result=getDb().prepare(`UPDATE notifications SET read_at=CASE WHEN ?='pending' AND state!='pending' THEN NULL ELSE read_at END,state=?,updated_at=? WHERE session_id=? AND native_id=? AND kind=? AND source_id=? AND state!=?`)
    .run(state,state,new Date().toISOString(),session.id,nativeConversationId(session),kind,sourceId,state);
  if(result.changes&&session.created_by_user_id)notificationChanged(session.created_by_user_id);
}

export function listNotifications(userId:string,query:{filter?:string;project_id?:string;before?:number}={}) {
  // Counts inspect metadata only; large bodies are read for this page alone.
  const rows=getDb().prepare(`SELECT id,user_id,session_id,native_id,source_id,message_id,turn_id,kind,state,title,
    '' AS body,read_at,created_at,updated_at FROM notifications WHERE user_id=? ORDER BY id DESC`).all(userId) as Notification[];
  const sessions=new Map<string,NotificationSession|undefined>(),present=sessionPresenter(userId);
  const access=new Map<string,boolean>(),labels=new Map<string,ReturnType<typeof present>>();
  const preferences=notificationPreferences(userId),muted=new Set(preferences.muted_project_ids);
  let unread=0,pending=0,throughId=0;
  const byProject:Record<string,number>={},bySession:Record<string,number>={};
  const visible=rows.flatMap(row=>{
    if(!sessions.has(row.session_id))sessions.set(row.session_id,notificationSession(row.session_id));
    const session=sessions.get(row.session_id);
    if(!session)return [];
    if(!access.has(session.id))access.set(session.id,canReadNotifications(session,userId));
    if(!access.get(session.id))return [];
    if(!labels.has(session.id))labels.set(session.id,present(session));
    const current=nativeConversationId(session)===row.native_id;
    const state=current?row.state:row.state==='info'?'info':'resolved';
    const isMuted=!!session.project_id&&muted.has(session.project_id);
    throughId=Math.max(throughId,row.id);
    if(!isMuted&&!row.read_at){unread++;if(session.project_id)byProject[session.project_id]=(byProject[session.project_id]||0)+1;bySession[session.id]=(bySession[session.id]||0)+1;}
    if(!isMuted&&state==='pending')pending++;
    return [{...row,state,project_id:session.project_id,...labels.get(session.id)!,muted:isMuted,current_binding:current}];
  });
  const filtered=visible.filter(row=>(!query.project_id||row.project_id===query.project_id)
    &&(!query.before||row.id<query.before)
    &&(query.filter==='pending'?row.state==='pending':query.filter==='unread'?!row.read_at:true));
  const page=filtered.slice(0,50);
  const bodies=new Map(page.length?(getDb().prepare(`SELECT id,body FROM notifications WHERE id IN (${page.map(()=>'?').join(',')})`).all(...page.map(row=>row.id)) as Pick<Notification,'id'|'body'>[]).map(row=>[row.id,row.body]):[]);
  return {notifications:page.map(row=>({...row,body:bodies.get(row.id)||''})),has_more:filtered.length>50,unread,pending,through_id:throughId,
    unread_by_project:byProject,unread_by_session:bySession,preferences};
}
export function markNotificationsRead(userId:string,ids:number[],throughId?:number,projectId?:string) {
  const rows=getDb().prepare('SELECT * FROM notifications WHERE user_id=? AND read_at IS NULL').all(userId) as Notification[];
  const selected=new Set(ids),now=new Date().toISOString(),stmt=getDb().prepare('UPDATE notifications SET read_at=? WHERE id=? AND user_id=?');
  getDb().transaction(()=>{for(const row of rows){
    if(!selected.has(row.id)&&!(throughId&&row.id<=throughId))continue;
    const session=notificationSession(row.session_id);
    if(session&&(!projectId||session.project_id===projectId)&&canReadNotifications(session,userId))stmt.run(now,row.id,userId);
  }})();
  notificationChanged(userId);
}

/** Retain outstanding work; bound settled history without a background timer. */
export function pruneNotifications() {
  getDb().exec(`DELETE FROM notifications WHERE state IN ('info','resolved') AND
    (created_at<strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days') OR id IN (
      SELECT id FROM (SELECT id,row_number() OVER(PARTITION BY user_id ORDER BY id DESC) AS rank
      FROM notifications WHERE state IN ('info','resolved')) WHERE rank>1000));`);
}
