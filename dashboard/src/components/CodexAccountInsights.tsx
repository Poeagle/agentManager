import {useMemo,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {ChevronRight,Folder,RefreshCw,Ticket,Activity,CalendarDays} from 'lucide-react';
import {Dialog} from './Dialog';
import {fetchJSON} from '../lib/api';
import './CodexAccountInsights.css';
type Row={date:string;cwd:string;project_name?:string;tokens:Record<string,number|null>;estimated_credits?:number|null;credit_coverage?:{covered:number;total:number}|null};
type Usage={checked_at:string|null;partial:boolean;error:string|null;rows:Row[];timezone:string;credit_rate_date?:string};
type Resets={account:{email:string|null;plan:string|null};windows?:Array<{usedPercent:number;windowDurationMins:number|null;resetsAt:number|null}>;resets:{availableCount:number;credits:Array<{expiresAt:number|null;grantedAt:number|null;status:string|null}>|null}|null};
const numeric=(n:number|null|undefined)=>n==null?'—':n.toLocaleString(undefined,{maximumFractionDigits:2});
const time=(value:number|null)=>value===null?'未提供':new Date(value*1000).toLocaleString();
const sum=(rows:Row[],field:string):number|null=>rows.some(r=>r.tokens[field]==null)?null:rows.reduce((s,r)=>s+r.tokens[field]!,0);
const credits=(rows:Row[])=>{const known=rows.filter(r=>r.estimated_credits!=null);return known.length?known.reduce((s,r)=>s+r.estimated_credits!,0):null;};
const partialCredits=(rows:Row[])=>rows.some(r=>r.estimated_credits==null||r.credit_coverage&&r.credit_coverage.covered<r.credit_coverage.total);
const metrics=['input_tokens','cached_input_tokens','output_tokens','total_tokens'];
export function CodexAccountInsights({id,name,onClose}:{id:string;name:string;onClose:()=>void}){
 const [expansion,setExpansion]=useState<Record<string,boolean>>({});
 const [search,setSearch]=useState(''),[from,setFrom]=useState(''),[to,setTo]=useState(''),[page,setPage]=useState(0),[tab,setTab]=useState<'usage'|'cards'>('usage');
 const base='/codex/environments/'+encodeURIComponent(id);
 const usage=useQuery({queryKey:['codex-insights',id],queryFn:()=>fetchJSON<{usage:Usage}>(base+'/insights'),retry:false,refetchInterval:300000});
 const resets=useQuery({queryKey:['codex-reset-credits',id],queryFn:()=>fetchJSON<Resets>(base+'/reset-credits'),retry:false,staleTime:300000});
 const data=usage.data?.usage;
 const rows=useMemo(()=>(data?.rows||[]).filter(r=>(!from||r.date>=from)&&(!to||r.date<=to)&&(!search||`${r.cwd} ${r.project_name||''}`.toLowerCase().includes(search.toLowerCase()))),[data,from,to,search]);
 const days=useMemo(()=>{const result=new Map<string,Row[]>();for(const row of rows){const group=result.get(row.date)||[];group.push(row);result.set(row.date,group);}return [...result].sort(([a],[b])=>b.localeCompare(a));},[rows]);
 const pages=Math.max(1,Math.ceil(days.length/10)),currentPage=Math.min(page,pages-1),shown=days.slice(currentPage*10,currentPage*10+10);
 const cards=resets.data?.resets;
 const refresh=()=>{void usage.refetch();void resets.refetch();};
 return <Dialog title={`${name} 账号详情`} size="image" width={1240} onClose={onClose}>
  <div className="codex-insights">
   <div className="ci-identity"><span>{resets.data?.account.email||name}</span><span className="ci-tag">{resets.data?.account.plan||'套餐未提供'}</span><button className="ci-button" onClick={refresh} disabled={usage.isFetching||resets.isFetching}><RefreshCw size={14}/>刷新</button></div>
   <div className="ci-overview">
    <section><span className="ci-label"><Activity size={15}/>账号额度</span>{resets.data?.windows?.length?resets.data.windows.map((w,i)=><div className="ci-quota" key={i}><span>{w.windowDurationMins===10080?'周额度':w.windowDurationMins?`${w.windowDurationMins/60} 小时`:'额度'}</span><strong>剩余 {numeric(Math.max(0,100-w.usedPercent))}%</strong><progress aria-label="账号额度剩余" value={Math.max(0,100-w.usedPercent)} max={100}/><small>重置 {time(w.resetsAt)}</small></div>):<p>{resets.isPending?'正在读取…':'额度暂不可用'}</p>}</section>
    <section><span className="ci-label"><Ticket size={15}/>重置卡</span><strong className="ci-value">{cards?cards.availableCount:'—'}<small> 张可用</small></strong><button className="ci-link" onClick={()=>setTab('cards')}>查看卡片与到期时间 <ChevronRight size={13}/></button></section>
    <section><span className="ci-label"><CalendarDays size={15}/>所选范围用量</span><strong className="ci-value">{numeric(sum(rows,'total_tokens'))}<small> Token</small></strong><span className="ci-muted">{days.length} 天 · {new Set(rows.map(r=>r.cwd)).size} 个工作目录</span></section>
   </div>
   <nav className="ci-tabs" aria-label="账号详情栏目"><button aria-selected={tab==='usage'} onClick={()=>setTab('usage')}>每日项目用量</button><button aria-selected={tab==='cards'} onClick={()=>setTab('cards')}>重置卡{cards?` (${cards.availableCount})`:''}</button></nav>
   {tab==='cards'?<section aria-label="重置卡" className="ci-section">
    <h4>重置卡：{resets.isPending?'读取中…':cards?`${cards.availableCount} 张`:'未提供'}</h4>
    {resets.isError&&<p className="ci-notice" role="alert">重置卡读取失败，请刷新重试。</p>}
    {cards?.credits===null&&<p className="ci-muted">服务仅返回数量，未提供到期明细。</p>}
    {cards?.credits&&<div className="ci-table-scroll"><table className="ci-table"><thead><tr><th>卡片</th><th>状态</th><th>发放时间</th><th>到期时间</th></tr></thead><tbody>{cards.credits.map((c,i)=><tr key={i}><td>重置卡 {i+1}</td><td><span className="ci-tag">{c.status==='available'?'可用':c.status||'未提供'}</span></td><td>{time(c.grantedAt)}</td><td>{time(c.expiresAt)}</td></tr>)}</tbody></table></div>}
    {cards?.credits&&cards.credits.length<cards.availableCount&&<p className="ci-muted">服务未返回全部卡片明细。</p>}
   </section>:<section aria-label="每日项目用量" className="ci-section">
    <div className="ci-toolbar"><input aria-label="搜索项目或目录" placeholder="搜索项目名称或工作目录" value={search} onChange={e=>{setSearch(e.target.value);setPage(0);}}/><label>日期 <input type="date" aria-label="开始日期" value={from} onChange={e=>{setFrom(e.target.value);setPage(0);}}/>—<input type="date" aria-label="结束日期" value={to} onChange={e=>{setTo(e.target.value);setPage(0);}}/></label><button className="ci-button" onClick={()=>setExpansion(Object.fromEntries(shown.map(([day])=>[day,true])))}>展开本页</button><button className="ci-button" onClick={()=>setExpansion(Object.fromEntries(days.map(([day])=>[day,false])))}>收起全部</button></div>
    <div className="ci-observation"><span className={`ci-dot${data?.partial?' pending':''}`}/>{data?.partial?'历史分批采集中 / 数据未完整':'缓存已更新'}<span>上次采集 {data?.checked_at?new Date(data.checked_at).toLocaleString():'尚未完成'} · 每 5 分钟增量 · UTC</span></div>
    {data?.error&&<p className="ci-notice" role="status">{data.error}</p>}{usage.isError&&<p className="ci-notice" role="alert">缓存读取失败，请刷新重试。</p>}
    <div className="ci-table-scroll"><table className="ci-table ci-usage-table"><colgroup><col style={{width:'32%'}}/>{metrics.map(k=><col key={k} style={{width:'12%'}}/>)}<col style={{width:'9%'}}/><col style={{width:'11%'}}/></colgroup><thead><tr><th>日期 / 项目与工作目录</th><th>输入 Token</th><th>缓存输入</th><th>输出 Token</th><th>总 Token</th><th>当日占比</th><th>预计 Credits</th></tr></thead><tbody>
     {!days.length&&<tr><td colSpan={7} className="ci-empty">{usage.isPending?'正在读取缓存…':'所选范围暂无用量记录'}</td></tr>}
     {shown.map(([day,projects],index)=>{const open=expansion[day]??(currentPage===0&&index===0),total=sum(projects,'total_tokens');return <Day key={day} day={day} rows={projects} total={total} expanded={open} toggle={()=>setExpansion(p=>({...p,[day]:!open}))}/>;})}
    </tbody></table></div>
    <div className="ci-pagination"><span>{days.length} 个日期 · {rows.length} 个项目用量记录</span><button className="ci-button" disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}>上一页</button><span>{currentPage+1} / {pages}</span><button className="ci-button" disabled={currentPage+1>=pages} onClick={()=>setPage(currentPage+1)}>下一页</button></div>
    <p className="ci-footnote">缓存输入包含于输入 Token；占比以筛选后当日 Token 为分母。Credits 按 {data?.credit_rate_date||'当前'} 官方费率折算，非实际扣费；未记录速度时按 Standard 估算，带 * 为仅覆盖部分记录。<a href="https://learn.chatgpt.com/docs/pricing" target="_blank" rel="noreferrer">费率依据</a></p>
   </section>}
  </div>
 </Dialog>;
}
function CreditCell({rows}:{rows:Row[]}){const value=credits(rows);return <td title={partialCredits(rows)?'部分模型或 Token 字段缺失，仅计入可估算记录':'按当前官方费率折算，非账单'}>{value===null?'暂不可估':numeric(value)}{value!==null&&partialCredits(rows)?' *':''}</td>;}
function Day({day,rows,total,expanded,toggle}:{day:string;rows:Row[];total:number|null;expanded:boolean;toggle:()=>void}){
 return <><tr className="ci-day"><td><button className="ci-tree-toggle" aria-label={`${expanded?'收起':'展开'} ${day}`} aria-expanded={expanded} onClick={toggle}><ChevronRight size={15} style={{transform:expanded?'rotate(90deg)':undefined}}/>{day}<span className="ci-count">{rows.length} 个项目</span></button></td>{metrics.map(k=><td key={k}>{numeric(sum(rows,k))}</td>)}<td>{total?'100%':'—'}</td><CreditCell rows={rows}/></tr>{expanded&&rows.map(row=><tr className="ci-project" key={row.cwd}><td><div className="ci-project-name"><Folder size={14}/><strong>{row.project_name||row.cwd.split('/').filter(Boolean).pop()||'未归属'}</strong></div><span className="ci-directory" title={row.cwd}>{row.cwd||'原始记录未提供工作目录'}</span></td>{metrics.map(k=><td key={k}>{numeric(row.tokens[k])}</td>)}<td><span>{total&&row.tokens.total_tokens!=null?`${(row.tokens.total_tokens/total*100).toFixed(1)}%`:'—'}</span><progress aria-label={`${row.project_name||row.cwd} 当日占比`} max={100} value={total&&row.tokens.total_tokens!=null?row.tokens.total_tokens/total*100:0}/></td><CreditCell rows={[row]}/></tr>)}</>;
}
