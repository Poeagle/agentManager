import {useCallback,useEffect,useRef,useState} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {api,type ConversationControlsData} from './api';
export interface NativeCompaction {id:string;status:'running'|'completed'|'failed'|'interrupted';started_at:string|null;completed_at:string|null;duration_ms:number|null}
export interface CompactionPresentation extends Omit<NativeCompaction,'status'> {status:NativeCompaction['status']|'pending'|'unknown';before:number|null;after:number|null;error?:string}
const percent=(usage:ConversationControlsData['usage'])=>usage?.window&&usage.last.total_tokens!=null?Math.min(100,Math.round(100*usage.last.total_tokens/usage.window)):null;
export function useConversationCompaction(sessionId:string,nativeId:string|null|undefined){
 const client=useQueryClient(),[state,setState]=useState<CompactionPresentation|null>(null),current=useRef(state);current.current=state;
 const key=['conversation-controls',sessionId];
 useEffect(()=>{setState(null);current.current=null;},[sessionId,nativeId]);
 const start=useCallback(async()=>{
  if(current.current&&['pending','running'].includes(current.current.status))return;
  const now=new Date().toISOString();const pending:CompactionPresentation={id:`pending:${now}`,status:'pending',started_at:now,completed_at:null,duration_ms:null,before:percent(client.getQueryData<ConversationControlsData>(key)?.usage??null),after:null};current.current=pending;setState(pending);
  try{await api.sessions.compactConversation(sessionId);}catch(error){setState(previous=>previous?{...previous,status:'failed',error:error instanceof Error?error.message:'压缩请求失败，请重试'}:previous);throw error;}
 },[client,sessionId]);
 const observe=useCallback((native:NativeCompaction|null,busy=false)=>{
  setState(previous=>{
   if(!native){if(previous?.status==='running'&&!busy)return {...previous,status:'unknown'};return previous&&!['pending','running'].includes(previous.status)&&busy?null:previous;}
   // A delayed baseline from before this request cannot finish the new request.
   if(previous?.status==='pending'&&native.status!=='running'&&(!native.completed_at||Date.parse(native.completed_at)<Date.parse(previous.started_at!)))return previous;
   if(!previous&&native.status!=='running'&&(!native.completed_at||Date.now()-Date.parse(native.completed_at)>10000))return null;
   const same=previous?.id===native.id||previous?.status==='pending'||previous?.status==='unknown';
   return {...native,before:same?previous!.before:percent(client.getQueryData<ConversationControlsData>(['conversation-controls',sessionId])?.usage??null),after:same?previous!.after:null};
  });
 },[client,sessionId]);
 const usage=useCallback((value:NonNullable<ConversationControlsData['usage']>,observedAt:string)=>{
  client.setQueryData<ConversationControlsData>(['conversation-controls',sessionId],previous=>previous?{...previous,usage:value,usage_observed_at:observedAt}:previous);
  setState(previous=>previous?{...previous,after:percent(value)}:previous);
 },[client,sessionId]);
 const disconnected=useCallback(()=>setState(previous=>previous&&['pending','running'].includes(previous.status)?{...previous,status:'unknown'}:previous),[]);
 useEffect(()=>{if(state?.status!=='completed')return;const timer=setTimeout(()=>setState(previous=>previous?.status==='completed'?null:previous),8000);return()=>clearTimeout(timer);},[state?.id,state?.status]);
 return {state,start,observe,usage,disconnected,running:!!state&&['pending','running'].includes(state.status)};
}
