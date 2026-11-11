import {useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {Dialog} from './Dialog';
import {fetchJSON} from '../lib/api';
type Row={date:string;cwd:string;tokens:Record<string,number|null>};
type Usage={checked_at:string|null;partial:boolean;error:string|null;rows:Row[];timezone:string};
type Resets={account:{email:string|null;plan:string|null};windows?:Array<{usedPercent:number;windowDurationMins:number|null;resetsAt:number|null}>;resets:{availableCount:number;credits:Array<{expiresAt:number|null;grantedAt:number|null;status:string|null}>|null}|null};
const number=(n:number|null)=>n===null?'未知':n.toLocaleString();
export function CodexAccountInsights({id,name,onClose}:{id:string;name:string;onClose:()=>void}){
 const [expanded,setExpanded]=useState(new Set<string>());
 const base='/codex/environments/'+encodeURIComponent(id);
 const usage=useQuery({queryKey:['codex-insights',id],queryFn:()=>fetchJSON<{usage:Usage}>(base+'/insights'),retry:false,refetchInterval:300000});
 const resets=useQuery({queryKey:['codex-reset-credits',id],queryFn:()=>fetchJSON<Resets>(base+'/reset-credits'),retry:false,staleTime:300000});
 const data=usage.data?.usage,days=new Map<string,Row[]>();
 for(const row of data?.rows||[]){const rows=days.get(row.date)||[];rows.push(row);days.set(row.date,rows);}
 const total=(rows:Row[],field:string)=>rows.some(r=>r.tokens[field]===null)?null:rows.reduce((sum,r)=>sum+(r.tokens[field]||0),0);
 return <Dialog title={`${name} 账号详情`} size="lg" onClose={onClose}>
  <div className="space-y-4 text-sm">
   <p>{resets.data?.account.email||name}{resets.data?.account.plan?` · ${resets.data.account.plan}`:''}</p>
   {resets.data?.windows?.map((window,index)=><p key={index}>{window.windowDurationMins===10080?'周额度':window.windowDurationMins?`${window.windowDurationMins/60} 小时额度`:'额度'} · 已用 {window.usedPercent}% · 重置：{window.resetsAt?new Date(window.resetsAt*1000).toLocaleString():'未知'}</p>)}
   <section aria-label="重置卡"><h4>重置卡：{resets.isPending?'读取中…':resets.data?.resets?`${resets.data.resets.availableCount} 张`:'未知'}</h4>
    {resets.isError&&<p role="alert">重置卡读取失败，当前版本可能尚未支持。</p>}
    {resets.data?.resets?.credits?.map((card,index)=><p key={index}>卡片 {index+1} · {card.status||'状态未知'} · 到期：{card.expiresAt===null?'未知':new Date(card.expiresAt*1000).toLocaleString()}</p>)}
    {resets.data?.resets&&resets.data.resets.credits===null&&<p>服务仅返回数量，未提供到期明细。</p>}
    {resets.data?.resets?.credits&&resets.data.resets.credits.length<resets.data.resets.availableCount&&<p>服务未返回全部卡片明细。</p>}
   </section>
   <section aria-label="每日项目用量"><div className="flex items-center justify-between"><h4>每日项目用量（UTC）</h4><button type="button" disabled={usage.isFetching} onClick={()=>void usage.refetch()}>刷新缓存视图</button></div>
    <p>最后采集：{data?.checked_at?new Date(data.checked_at).toLocaleString():'尚未完成首次采集'} · 后台每 5 分钟采集</p>
    {data?.partial&&<p role="status">历史仍在增量采集中，或有记录无法完整读取；当前显示已采集部分。</p>}
    {data?.error&&<p role="status">{data.error}</p>}
    {usage.isError&&<p role="alert">用量缓存读取失败。</p>}
    {usage.isPending?<p role="status">读取缓存中…</p>:!days.size?<p>暂无已采集用量。</p>:<div className="overflow-x-auto"><table className="w-full text-left"><thead><tr><th>日期 / 项目工作目录</th><th>输入</th><th>缓存输入</th><th>输出</th><th>总 Token</th><th>占比</th><th>预计 Credits</th></tr></thead><tbody>
     {[...days].map(([day,rows])=>{const sum=total(rows,'total_tokens');return <Day key={day} day={day} rows={rows} total={sum} expanded={expanded.has(day)} toggle={()=>setExpanded(previous=>{const next=new Set(previous);next.has(day)?next.delete(day):next.add(day);return next;})} sum={total}/>;})}
    </tbody></table></div>}
    <p className="mt-3 text-xs" style={{color:'var(--text-secondary)'}}>占比为该项目占当日已采集 Token 的比例。工作目录按原始会话记录归属。预计 Credits 暂显示未知：缺少可核对的模型费率或计费信息时不推算实际扣费。</p>
   </section>
  </div>
 </Dialog>;
}
function Day({day,rows,total,expanded,toggle,sum}:{day:string;rows:Row[];total:number|null;expanded:boolean;toggle:()=>void;sum:(rows:Row[],field:string)=>number|null}){
 return <><tr><td><button type="button" aria-expanded={expanded} onClick={toggle}>{expanded?'▾':'▸'} {day}</button></td>{['input_tokens','cached_input_tokens','output_tokens','total_tokens'].map(field=><td key={field}>{number(sum(rows,field))}</td>)}<td>—</td><td>未知</td></tr>{expanded&&rows.map(row=><tr key={row.cwd}><td className="py-2 pl-5 break-all">{row.cwd||'未归属工作目录'}</td>{['input_tokens','cached_input_tokens','output_tokens','total_tokens'].map(field=><td key={field}>{number(row.tokens[field])}</td>)}<td>{total&&row.tokens.total_tokens!==null?`${(row.tokens.total_tokens/total*100).toFixed(1)}%`:'—'}</td><td>未知</td></tr>)}</>;
}
