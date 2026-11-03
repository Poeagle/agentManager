import {estimatedServerNow} from './display-clock';
import {useCallback,useEffect,useRef,useState} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {api,type ConversationControlsData} from './api';
export interface NativeCompaction {id:string;status:'running'|'completed'|'failed'|'interrupted';started_at:string|null;completed_at:string|null;duration_ms:number|null}
export interface CompactionPresentation extends Omit<NativeCompaction,'status'> {status:NativeCompaction['status']|'pending'|'unknown';before:number|null;after:number|null;error?:string}
const percent=(usage:ConversationControlsData['usage'])=>usage?.window&&usage.last.total_tokens!=null?Math.min(100,Math.round(100*usage.last.total_tokens/usage.window)):null;
const COMPLETION_MS=3000;
export function useConversationCompaction(sessionId:string,nativeId:string|null|undefined){
 const client=useQueryClient(),[state,setState]=useState<CompactionPresentation|null>(null),current=useRef(state);current.current=state;
 const dismissed=useRef(new Set<string>());
 const key=['conversation-controls',sessionId];
 useEffect(()=>{setState(null);current.current=null;dismissed.current.clear();},[sessionId,nativeId]);
 const start=useCallback(async()=>{
  if(current.current&&['pending','running'].includes(current.current.status))return;
  const now=new Date(estimatedServerNow()).toISOString();const pending:CompactionPresentation={id:`pending:${now}`,status:'pending',started_at:now,completed_at:null,duration_ms:null,before:percent(client.getQueryData<ConversationControlsData>(key)?.usage??null),after:null};current.current=pending;setState(pending);
  try{await api.sessions.compactConversation(sessionId);}catch(error){setState(previous=>previous?{...previous,status:'failed',error:error instanceof Error?error.message:'压缩请求失败，请重试'}:previous);throw error;}
 },[client,sessionId]);
 const observe=useCallback((native:NativeCompaction|null,busy=false,resumed=false)=>{
  setState(previous=>{
   if(!native){if(previous?.status==='running'&&!busy)return {...previous,status:'unknown'};if(previous?.status==='completed'&&busy)dismissed.current.add(previous.id);return previous&&!['pending','running'].includes(previous.status)&&busy?null:previous;}
   // A delayed baseline from before this request cannot finish the new request.
   if(previous?.status==='pending'&&native.status!=='running'&&(!native.completed_at||Date.parse(native.completed_at)<Date.parse(previous.started_at!)))return previous;
   if(native.status==='completed'&&(resumed||dismissed.current.has(native.id)||native.completed_at&&estimatedServerNow()-Date.parse(native.completed_at)>=COMPLETION_MS)){
    dismissed.current.add(native.id);return previous?.status==='pending'?previous:null;
   }
   if(!previous&&native.status!=='running'&&(!native.completed_at||estimatedServerNow()-Date.parse(native.completed_at)>COMPLETION_MS))return null;
   const same=previous?.id===native.id||previous?.status==='pending'||previous?.status==='unknown';
   return {...native,before:same?previous!.before:native.status==='running'?percent(client.getQueryData<ConversationControlsData>(['conversation-controls',sessionId])?.usage??null):null,after:same?previous!.after:null};
  });
 },[client,sessionId]);
 const usage=useCallback((value:NonNullable<ConversationControlsData['usage']>,observedAt:string)=>{
  client.setQueryData<ConversationControlsData>(['conversation-controls',sessionId],previous=>previous?{...previous,usage:value,usage_observed_at:observedAt}:previous);
  setState(previous=>previous&&(['pending','running'].includes(previous.status)||previous.status==='completed'&&previous.after===null)?{...previous,after:percent(value)}:previous);
 },[client,sessionId]);
 const disconnected=useCallback(()=>setState(previous=>previous&&['pending','running'].includes(previous.status)?{...previous,status:'unknown'}:previous),[]);
 useEffect(()=>{if(state?.status!=='completed')return;const id=state.id,remaining=state.completed_at?Math.max(0,Math.min(COMPLETION_MS,Date.parse(state.completed_at)+COMPLETION_MS-estimatedServerNow())):COMPLETION_MS;const timer=setTimeout(()=>{dismissed.current.add(id);while(dismissed.current.size>64)dismissed.current.delete(dismissed.current.values().next().value!);setState(previous=>previous?.id===id&&previous.status==='completed'?null:previous);},remaining);return()=>clearTimeout(timer);},[state?.id,state?.status,state?.completed_at]);
 return {state,start,observe,usage,disconnected,running:!!state&&['pending','running'].includes(state.status)};
}
