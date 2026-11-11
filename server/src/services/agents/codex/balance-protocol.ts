/** Provider-specific wallet protocols. An origin is supported only when it is
 * explicitly registered; Responses API compatibility says nothing about billing. */
export type BalanceProtocol = 'sub2api' | 'deepseek';
export type BalanceFailure = 'missing_key' | 'unauthorized' | 'unsupported' | 'invalid_response' | 'timeout' | 'network' | 'too_large';
export type WalletResult = {status:'available';amount:number;currency:string;mode:string|null;todayActualCost:number|null;todayRequests:number|null;totalActualCost:number|null} | {status:'unavailable'|'unsupported';error:BalanceFailure};

const protocols:Record<string,BalanceProtocol>={
 'https://sub.wanzhao.top':'sub2api',
 'https://xindu.xyz':'sub2api',
 'https://api.deepseek.com':'deepseek',
};
export function balanceProtocol(baseUrl:string):BalanceProtocol|null {
 try{return protocols[new URL(baseUrl).origin]??null;}catch{return null;}
}
const number=(value:unknown):number|null=>{
 if(typeof value==='string'&&value.trim()!=='')value=Number(value);
 return typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
};
const record=(value:unknown):Record<string,any>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:{};
export function parseWallet(protocol:BalanceProtocol,value:unknown):WalletResult {
 const data=record(value);
 if(protocol==='deepseek'){
  const first=record(Array.isArray(data.balance_infos)?data.balance_infos[0]:null),amount=number(first.total_balance);
  if(amount===null||typeof first.currency!=='string'||!first.currency.trim())return {status:'unavailable',error:'invalid_response'};
  return {status:'available',amount,currency:first.currency,mode:null,todayActualCost:null,todayRequests:null,totalActualCost:null};
 }
 const amount=number(data.balance)??number(data.remaining)??number(record(data.quota).remaining);
 if(amount===null)return {status:'unavailable',error:'invalid_response'};
 const usage=record(data.usage),today=record(usage.today),total=record(usage.total);
 return {status:'available',amount,currency:typeof data.unit==='string'&&data.unit.trim()?data.unit:'USD',mode:typeof data.mode==='string'?data.mode:null,todayActualCost:number(today.actual_cost),todayRequests:number(today.requests),totalActualCost:number(total.actual_cost)};
}

export async function readWallet(baseUrl:string,key:string,options:{fetch?:typeof fetch;timeoutMs?:number;maxBytes?:number}={}):Promise<WalletResult>{
 if(!key)return {status:'unavailable',error:'missing_key'};
 const protocol=balanceProtocol(baseUrl);
 if(!protocol)return {status:'unsupported',error:'unsupported'};
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),options.timeoutMs??8000);
 try{
  const url=new URL(protocol==='sub2api'?'/v1/usage':'/user/balance',new URL(baseUrl).origin);
  const response=await (options.fetch??fetch)(url,{headers:{Authorization:`Bearer ${key}`,Accept:'application/json'},redirect:'error',signal:controller.signal});
  if(response.status===401||response.status===403)return {status:'unavailable',error:'unauthorized'};
  if(response.status===404)return {status:'unsupported',error:'unsupported'};
  if(!response.ok)return {status:'unavailable',error:'network'};
  const reader=response.body?.getReader();if(!reader)return {status:'unavailable',error:'invalid_response'};
  const chunks:Uint8Array[]=[];let size=0;const max=options.maxBytes??262144;
  try{while(true){const result=await reader.read();if(result.done)break;size+=result.value.byteLength;if(size>max){await reader.cancel();return {status:'unavailable',error:'too_large'};}chunks.push(result.value);}}finally{reader.releaseLock();}
  try{return parseWallet(protocol,JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{return {status:'unavailable',error:'invalid_response'};}
 }catch{return {status:'unavailable',error:controller.signal.aborted?'timeout':'network'};}finally{clearTimeout(timer);}
}
