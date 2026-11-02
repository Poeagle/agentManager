export const tokenFields=['input_tokens','cached_input_tokens','output_tokens','reasoning_output_tokens','total_tokens'] as const;
const finite=(value:unknown):number|null=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
export function publicTokenCounters(value:any,camel=false) {
  return Object.fromEntries(tokenFields.map(key=>[key,finite(value?.[camel?key.replace(/_([a-z])/g,(_,letter:string)=>letter.toUpperCase()):key])])) as Record<typeof tokenFields[number],number|null>;
}
export interface ConversationUsage {
  total:ReturnType<typeof publicTokenCounters>;last:ReturnType<typeof publicTokenCounters>;window:number|null;
}
export interface ConversationUsageFrame {type:'usage';native_id:string;usage:ConversationUsage;observed_at:string}

/** Whitelist counters only: never forward prompts, provider details or account
 * quota/balance information through the per-session event stream. */
export function nativeUsageFrame(threadId:string,value:any):ConversationUsageFrame|null {
  if(!value||typeof value!=='object')return null;
  const usage={total:publicTokenCounters(value.total,true),last:publicTokenCounters(value.last,true),window:finite(value.modelContextWindow)};
  if(!Object.values(usage.last).some(value=>value!==null))return null;
  return {type:'usage',native_id:threadId,usage,observed_at:new Date().toISOString()};
}
