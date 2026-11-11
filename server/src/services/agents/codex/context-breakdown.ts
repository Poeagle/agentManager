import type {AgentContext,AgentContextBreakdown} from '../types.js';
import {currentCodexEngine} from './engine-context.js';
import {getCodexEnvironment,environmentConnection} from './environments.js';
import {localHome} from './account-files.js';
import {accountCommandInput,localCommandInput} from './account-transport.js';
import {withCodexConnection} from './stream.js';
import {findCodexRollout} from '../../prompt-context.js';
import {CONTEXT_SCAN} from './context-scanner.js';
import {publicTokenCounters} from '../../conversation-usage.js';

const cached=new Map<string,{until:number;data:AgentContextBreakdown}>();
const pending=new Map<string,Promise<AgentContextBreakdown>>();
const warningNames:Record<string,string>={tail_only:'日志过大，仅分析最近 64 MiB；较早上下文可能未计入',oversized:'超大记录未纳入分类',incomplete:'文件末尾记录尚未写完',record_limit:'达到单次记录上限',compaction_partial:'压缩记录未提供完整替换历史',malformed:'部分原始记录无法解析'};
export async function readCodexContextBreakdown(context:AgentContext):Promise<AgentContextBreakdown>{
 if(!context.nativeId)throw Error('会话尚未绑定原生记录');
 const engine=currentCodexEngine(),key=JSON.stringify([engine.socket,engine.environmentId,context.nativeId]);
 const previous=cached.get(key);if(!context.force&&previous&&previous.until>Date.now())return previous.data;
 if(pending.has(key))return pending.get(key)!;
 if(pending.size>=4)throw Object.assign(Error('上下文分析繁忙，请稍后重试'),{statusCode:429});
 const work=(async()=>{
  const environment=engine.environmentId?getCodexEnvironment(engine.environmentId):getCodexEnvironment('native');
  const home=engine.accountHome||(environment.kind==='account'?environment.connection?.codexHome:localHome(environment));
  let path:string|null=null;
  try{const response=await withCodexConnection(request=>request('thread/read',{threadId:context.nativeId}));if(typeof response.thread?.path==='string')path=response.thread.path;}catch{/* A detached local rollout can still be read. */}
  if(!path&&environment.kind!=='account')path=await findCodexRollout(context.nativeId!);
  if(!path)throw Error('当前会话的原始 JSONL 暂不可用');
  const input=JSON.stringify({home,path}),options={timeoutMs:30000,maxOutputBytes:512*1024};
  const result=JSON.parse(await (environment.kind==='account'?accountCommandInput(environmentConnection(environment),CONTEXT_SCAN,input,options):localCommandInput(CONTEXT_SCAN,input,options)));
  if(!Array.isArray(result.categories)||result.categories.length>12)throw Error('上下文统计返回无效');
  const finite=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
  const categories=result.categories.map((c:any)=>({id:String(c.id).slice(0,40),name:String(c.name).slice(0,80),tokens:finite(c.tokens),count:finite(c.count)??0,detail:(Array.isArray(c.detail)?c.detail:[]).slice(0,101).map((d:any)=>({name:String(d.name).slice(0,120),tokens:finite(d.tokens)??0,count:finite(d.count)??0}))}));
  const usage=result.usage?{last:publicTokenCounters(result.usage.last),total:publicTokenCounters(null),window:finite(result.usage.window)}:null;
  const data:AgentContextBreakdown={source:'jsonl',exact:false,method:'characters_div_3',checked_at:new Date().toISOString(),observed_at:typeof result.observed_at==='string'?result.observed_at.slice(0,40):null,model:typeof result.model==='string'?result.model.slice(0,120):null,usage,partial:!!result.partial,warnings:(Array.isArray(result.warnings)?result.warnings:[]).flatMap((name:string)=>warningNames[name]?[warningNames[name]]:[]),files_read:finite(result.files_read)??0,records_read:finite(result.records_read)??0,bytes_read:finite(result.bytes_read)??0,compactions:finite(result.compactions)??0,categories};
  cached.set(key,{until:Date.now()+30000,data});while(cached.size>32)cached.delete(cached.keys().next().value!);return data;
 })();pending.set(key,work);try{return await work;}finally{pending.delete(key);}
}
