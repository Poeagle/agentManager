import type {ConversationAttachment} from './conversation-attachments';
export interface BatchEntry {id:string;text:string;attachments:ConversationAttachment[]}
export interface ComposerState {mode:'immediate'|'batch';draft:string;entries:BatchEntry[];pending:{id:string;entryIds:string[];nativeId:string|null}|null}
export const emptyComposer=():ComposerState=>({mode:'immediate',draft:'',entries:[],pending:null});
export const composerKey=(userId:string|undefined,sessionId:string)=>`agentmanager-composer:${JSON.stringify([userId||'anonymous',sessionId])}`;
export function loadComposer(key:string):ComposerState {
 const raw=localStorage.getItem(key);if(!raw)return emptyComposer();
 const value=JSON.parse(raw) as ComposerState;
 if(!value||!['immediate','batch'].includes(value.mode)||typeof value.draft!=='string'||!Array.isArray(value.entries)||value.entries.some(e=>typeof e.id!=='string'||typeof e.text!=='string'||!Array.isArray(e.attachments)))throw Error('保存的草稿无法读取，请保留浏览器数据');
 if(value.pending!==null&&(!value.pending||typeof value.pending.id!=='string'||!Array.isArray(value.pending.entryIds)||value.pending.entryIds.some(id=>typeof id!=='string')))throw Error('保存的发送状态无法读取');
 return value;
}
export function saveComposer(key:string,value:ComposerState){localStorage.setItem(key,JSON.stringify(value));}
export function combinedBatch(entries:BatchEntry[]) {
 let text='';const attachments:ConversationAttachment[]=[];
 for(const entry of entries){if(text)text+='\n\n';const start=text.length;text+=entry.text;attachments.push(...entry.attachments.map(a=>({...a,offset:start+(a.offset??entry.text.length)})));}
 return {text,attachments};
}
