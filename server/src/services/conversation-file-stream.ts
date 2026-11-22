import {conversationHistoryCursor} from '../shared/conversation-history-cursor.js';
import {agentForSession,agentContext} from './agents/index.js';
import {watchNativeFile} from './agents/file-watch.js';
import {nativeConversationFile,type PromptContextSession} from './prompt-context.js';
import {readConversation,type ConversationMessage} from './conversation-reader.js';
import type {AgentRuntime,AgentStatistics as ConversationStatistics,AgentProgressStatistics} from './agents/types.js';
import type {ConversationUsageFrame} from './conversation-usage.js';
import type {SessionMetadata,SessionCacheDrop} from './agents/session-facts.js';
import {readChangedSessionStatistics, readRecentSessionCacheDrops, readSessionProgress, subscribeSessionFacts} from './session-statistics.js';
export interface ConversationStatisticsFrame {type:'statistics';native_id:string;statistics:ConversationStatistics[]}
export interface ConversationHistoryFrame {type:'history';messages:ConversationMessage[];runtime:AgentRuntime;reset?:boolean}
export interface ConversationProgressStatisticsFrame {type:'progress_statistics';native_id:string;progress:AgentProgressStatistics|null}
export interface ConversationMetadataFrame {type:'session_metadata';native_id:string;metadata:SessionMetadata;cache_drops:SessionCacheDrop[]}
type Frame=ConversationHistoryFrame|ConversationUsageFrame|ConversationStatisticsFrame|ConversationProgressStatisticsFrame|ConversationMetadataFrame;
const streams=new Map<string,{listeners:Set<(frame:Frame)=>void>;latest:Map<string,Frame>;stop:()=>void}>();
/** Share file parsing among viewers of the same binding. Personal projection
 * and attachment/input decoration remain in each authenticated API connection. */
export function observeConversationFile(binding:PromptContextSession,emit:(frame:Frame)=>void){
 const adapter=agentForSession(binding),context=agentContext(binding),key=JSON.stringify([adapter.descriptor.id,context.nativeId,binding.project_path,(binding as {id?:string}).id]);
 const existing=streams.get(key);if(existing){existing.listeners.add(emit);for(const frame of existing.latest.values())emit(frame);return ()=>release(existing);}
 const listeners=new Set([emit]),latest=new Map<string,Frame>();
 let closed=false,timer:ReturnType<typeof setTimeout>|undefined,reading=false,again=false,cursor:string|undefined,lastRuntime='',lastUsage='',lastProgress='',lastMetadata='',metadataRevision=0;
 const sentStatistics=new Map<number,string>();
 function send(frame:Frame){latest.set(frame.type,frame);for(const listener of listeners)listener(frame);}
 function changed(){if(closed)return;again=true;if(!reading&&!timer)timer=setTimeout(()=>void refresh(),50);}
 async function refresh(){timer=undefined;if(closed)return;reading=true;again=false;
  const previousCursor=cursor;
  try{const page=await readConversation(binding,cursor?{after:cursor,limit:20}:{limit:8}),runtime=await adapter.runtime.read(context);if(closed)return;
   const {observed_at,...facts}=runtime,fingerprint=JSON.stringify(facts);
   if(page.reset||page.messages.length||lastRuntime!==fingerprint){send({type:'history',messages:page.messages,runtime,...(page.reset?{reset:true}:{})});lastRuntime=fingerprint;}
   cursor=conversationHistoryCursor(page.messages)||(page.reset?undefined:cursor);
   if(context.nativeId){
    const metadata=page.metadata;
    const changed=metadata ? readChangedSessionStatistics(context, page.reset?0:metadataRevision) : page.statistics||[];
    if(page.reset)sentStatistics.clear();
    const changedStatistics=changed.filter(item=>sentStatistics.get(item.sequence)!==JSON.stringify(item));
    if(changedStatistics.length){for(const item of changedStatistics)sentStatistics.set(item.sequence,JSON.stringify(item));while(sentStatistics.size>80)sentStatistics.delete(sentStatistics.keys().next().value!);send({type:'statistics',native_id:context.nativeId,statistics:changedStatistics});}
    if(metadata){
     const fingerprint=JSON.stringify(metadata);
     if(fingerprint!==lastMetadata){
      send({type:'session_metadata',native_id:context.nativeId,metadata,cache_drops:readRecentSessionCacheDrops(context)});
      lastMetadata=fingerprint;metadataRevision=metadata.revision;
     }
    }
    if(metadata||adapter.statistics.readProgress){
     const file=metadata?null:await nativeConversationFile(binding);
     const progress=metadata?readSessionProgress(context):file?await adapter.statistics.readProgress!(context,file.path):null;
     const fingerprint=JSON.stringify(progress);if(lastProgress!==fingerprint){send({type:'progress_statistics',native_id:context.nativeId,progress});lastProgress=fingerprint;}
    }
    const telemetry=await adapter.telemetry.read(context);if(closed)return;const usage=JSON.stringify(telemetry.usage);
    if(telemetry.usage&&telemetry.observed_at&&lastUsage!==usage){send({type:'usage',native_id:context.nativeId,usage:telemetry.usage,observed_at:telemetry.observed_at});lastUsage=usage;}
   }
   if(page.messages.length===20&&cursor!==previousCursor)again=true;
  }catch{/* Recovered observers or subsequent native events retry. */}
  finally{reading=false;if(again)changed();}
 }
 const file=adapter.history.file?watchNativeFile(async()=>(await nativeConversationFile(binding))?.path||null,changed):undefined;
 const unsubscribe=adapter.runtime.subscribe(context,()=>{file?.poke();changed();});
 const stopFacts=subscribeSessionFacts(context,changed);
 const entry={listeners,latest,stop:()=>{closed=true;clearTimeout(timer);file?.stop();unsubscribe();stopFacts();}};streams.set(key,entry);changed();
 function release(current:typeof entry){current.listeners.delete(emit);if(!current.listeners.size){current.stop();if(streams.get(key)===current)streams.delete(key);}}
 return ()=>release(entry);
}
