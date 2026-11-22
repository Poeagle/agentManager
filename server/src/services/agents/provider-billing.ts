import {readAgentManagement,updateAgentManagement,type StoredProvider} from './management-store.js';
import {saveProviderBillingSnapshot,type ProviderBillingSnapshot} from './provider-pricing.js';

const supportedOrigins=new Set(['https://sub.wanzhao.top','https://xindu.xyz']);
const MAX_RESPONSE_BYTES=32768;

export type ProviderBillingFailure='unsupported'|'missing_key'|'unauthorized'|'invalid_response'|'timeout'|'network'|'too_large';
export type ProviderBillingResult={status:'available';snapshot:ProviderBillingSnapshot}|{status:'unavailable';error:ProviderBillingFailure};

function object(value:unknown):Record<string,unknown>{return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};}
function positive(value:unknown):number|null{return typeof value==='number'&&Number.isFinite(value)&&value>0?value:null;}
function clock(value:unknown):string|null{return typeof value==='string'&&/^\d{2}:\d{2}$/.test(value)&&Number(value.slice(0,2))<24&&Number(value.slice(3))<60?value:null;}

export function sub2ApiOrigin(baseUrl:string):string|null{
 try{const url=new URL(baseUrl);return url.username||url.password||url.search||url.hash?null:supportedOrigins.has(url.origin)?url.origin:null;}catch{return null;}
}

export function parseProviderBilling(value:unknown,now=Date.now()):ProviderBillingSnapshot|null{
 const data=object(value),scope=data.billing_scope;
 const resolved=positive(data.resolved_rate_multiplier),effective=positive(data.effective_rate_multiplier);
 const peakEnabled=data.peak_rate_enabled===true;
 const peakMultiplier=positive(data.peak_rate_multiplier);
 const peakStart=clock(data.peak_start),peakEnd=clock(data.peak_end);
 const timeZone=data.timezone;
 const observed=typeof data.observed_at==='string'?Date.parse(data.observed_at):now;
 if(scope!=='token'||resolved===null||effective===null||!Number.isFinite(observed))return null;
 if(peakEnabled&&(!peakMultiplier||!peakStart||!peakEnd||typeof timeZone!=='string'||!timeZone.trim()))return null;
 return {source:'sub2api',observedAt:observed,resolvedRate:resolved,effectiveRate:effective,peakEnabled,
  ...(peakEnabled?{peakMultiplier:peakMultiplier!,peakStart:peakStart!,peakEnd:peakEnd!,timeZone:String(timeZone)}:{})};
}

export async function readProviderBilling(baseUrl:string,key:string,options:{fetch?:typeof fetch;timeoutMs?:number;maxBytes?:number;now?:number}={}):Promise<ProviderBillingResult>{
 const origin=sub2ApiOrigin(baseUrl);
 if(!origin)return {status:'unavailable',error:'unsupported'};
 if(!key)return {status:'unavailable',error:'missing_key'};
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),options.timeoutMs??5000);
 try{
  const response=await (options.fetch??fetch)(new URL('/v1/sub2api/billing',origin),{headers:{Authorization:`Bearer ${key}`,Accept:'application/json'},redirect:'error',signal:controller.signal});
  if(response.status===401||response.status===403)return {status:'unavailable',error:'unauthorized'};
  if(response.status===404)return {status:'unavailable',error:'unsupported'};
  if(!response.ok)return {status:'unavailable',error:'network'};
  const reader=response.body?.getReader();if(!reader)return {status:'unavailable',error:'invalid_response'};
  const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>(options.maxBytes??MAX_RESPONSE_BYTES)){await reader.cancel();return {status:'unavailable',error:'too_large'};}chunks.push(item.value);}}finally{reader.releaseLock();}
  let data:unknown;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return {status:'unavailable',error:'invalid_response'};}
  const snapshot=parseProviderBilling(data,options.now);return snapshot?{status:'available',snapshot}:{status:'unavailable',error:'invalid_response'};
 }catch{return {status:'unavailable',error:controller.signal.aborted?'timeout':'network'};}finally{clearTimeout(timer);}
}

export async function refreshStoredProviderBilling(agentId:string,keyFor:(provider:StoredProvider)=>string,options:{fetch?:typeof fetch;now?:number;providerId?:string}={}):Promise<void>{
 const providers=readAgentManagement(agentId).providers.filter(provider=>provider.enabled&&(!options.providerId||provider.id===options.providerId));
 for(const provider of providers){
  const baseUrl=provider.fields.baseUrl;if(typeof baseUrl!=='string')continue;
  const result=await readProviderBilling(baseUrl,keyFor(provider),{fetch:options.fetch,now:options.now});
  if(result.status!=='available')continue;
  updateAgentManagement(agentId,current=>({...current,providers:current.providers.map(latest=>{
   if(latest.id!==provider.id||latest.fields.baseUrl!==baseUrl)return latest;
   const fields={...latest.fields};saveProviderBillingSnapshot(fields,latest.fields,result.snapshot);
   return {...latest,fields};
  })}));
 }
}
