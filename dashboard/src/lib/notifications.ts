import {fetchJSON} from './api';

export interface Notification {
  id:number;session_id:string;native_id:string;source_id:string;message_id:string|null;turn_id:string|null;
  kind:'question'|'approval'|'result'|'error';state:'pending'|'recovering'|'submitted'|'resolved'|'info';
  title:string;body:string;read_at:string|null;created_at:string;updated_at:string;
  project_id:string|null;project_name:string;display_name:string;muted:boolean;current_binding:boolean;
}
export interface NotificationPage {
  notifications:Notification[];has_more:boolean;unread:number;pending:number;through_id:number;
  unread_by_project:Record<string,number>;unread_by_session:Record<string,number>;
  preferences:{muted_project_ids:string[]};
  monitoring_limited?:number;
}
export type NotificationFilter='pending'|'unread'|'all';
export const notificationApi={
  list:(query:{filter?:NotificationFilter;project_id?:string;before?:number}={})=>fetchJSON<NotificationPage>(`/notifications?${new URLSearchParams(Object.entries(query).map(([key,value])=>[key,String(value)]))}`),
  readVisible:(input:{session_id:string;native_id:string;message_ids:string[];question_ids:string[]})=>fetchJSON<{ok:boolean}>('/notifications/read-visible',{method:'POST',body:JSON.stringify(input)}),
  read:(input:{ids?:number[];through_id?:number;project_id?:string})=>fetchJSON<{ok:boolean}>('/notifications/read',{method:'POST',body:JSON.stringify(input)}),
  dismiss:(input:{ids?:number[];through_id?:number;project_id?:string})=>fetchJSON<{ok:boolean}>('/notifications/dismiss',{method:'POST',body:JSON.stringify(input)}),
  preferences:(muted_project_ids:string[])=>fetchJSON<{ok:boolean}>('/notifications/preferences',{method:'PUT',body:JSON.stringify({muted_project_ids})}),
};
export interface ConversationFocus {messageId?:string|null;sourceId?:string;nativeId:string;requestId:number;view?:'chat'|'terminal'}
export function notificationFocus(notification:Notification):ConversationFocus {
  return {messageId:notification.message_id,sourceId:notification.source_id,nativeId:notification.native_id,requestId:Date.now()};
}
export const notificationLabels={pending:'待处理',recovering:'自动恢复中',submitted:'已提交 · 等待结果',resolved:'已处理',info:'新结果'};

type Visible={sessionId:string;nativeId:string;messageIds:Set<string>;questionIds:Set<string>};
const views=new Map<object,Visible>();
export function setVisibleConversation(owner:object,value:Visible|null) {
  if(value)views.set(owner,value);else views.delete(owner);
  window.dispatchEvent(new Event('agentmanager:conversation-visibility'));
}
export function notificationIsVisible(notification:Notification) {
  if(document.visibilityState!=='visible'||!document.hasFocus())return false;
  return [...views.values()].some(view=>view.sessionId===notification.session_id&&view.nativeId===notification.native_id&&(
    !!notification.message_id&&view.messageIds.has(notification.message_id)||view.questionIds.has(notification.source_id.replace(/^question:/,''))));
}

export function notificationTime(value:string):string {
  const date=new Date(value),pad=(n:number)=>String(n).padStart(2,'0');
  return `${date.getFullYear()}.${pad(date.getMonth()+1)}.${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
