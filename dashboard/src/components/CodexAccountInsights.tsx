import {useMemo,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {ChevronRight,Folder,RefreshCw,Ticket,Activity,CalendarDays,Cpu} from 'lucide-react';
import {Dialog} from './Dialog';
import {fetchJSON} from '../lib/api';
import './CodexAccountInsights.css';
type Metrics={tokens:Record<string,number|null>;estimated_credits?:number|null;credit_coverage?:{covered:number;total:number}|null};
type ModelUsage=Metrics&{model:string|null};
type Row=Metrics&{date:string;cwd:string;project_name?:string;models?:ModelUsage[]};
type Usage={checked_at:string|null;partial:boolean;error:string|null;rows:Row[];timezone:string;credit_rate_date?:string;progress?:{files_total:number;files_complete:number;bytes_total:number;bytes_read:number}|null};
type Resets={account:{email:string|null;plan:string|null};windows?:Array<{usedPercent:number;windowDurationMins:number|null;resetsAt:number|null}>;resets:{availableCount:number;credits:Array<{expiresAt:number|null;grantedAt:number|null;status:string|null}>|null}|null};
const numeric=(n:number|null|undefined)=>n==null?'—':n.toLocaleString(undefined,{maximumFractionDigits:2});
const time=(value:number|null)=>value===null?'未提供':new Date(value*1000).toLocaleString();
const sum=(rows:Metrics[],field:string):number|null=>rows.some(r=>r.tokens[field]==null)?null:rows.reduce((s,r)=>s+r.tokens[field]!,0);
const credits=(rows:Metrics[])=>{const known=rows.filter(r=>r.estimated_credits!=null);return known.length?known.reduce((s,r)=>s+r.estimated_credits!,0):null;};
const partialCredits=(rows:Metrics[])=>rows.some(r=>r.estimated_credits==null||r.credit_coverage&&r.credit_coverage.covered<r.credit_coverage.total);
const projectKey=(row:Row)=>JSON.stringify([row.date,row.cwd]);
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
    <div className="ci-toolbar"><input aria-label="搜索项目或目录" placeholder="搜索项目名称或工作目录" value={search} onChange={e=>{setSearch(e.target.value);setPage(0);}}/><label>日期 <input type="date" aria-label="开始日期" value={from} onChange={e=>{setFrom(e.target.value);setPage(0);}}/>—<input type="date" aria-label="结束日期" value={to} onChange={e=>{setTo(e.target.value);setPage(0);}}/></label><button className="ci-button" onClick={()=>setExpansion(Object.fromEntries(shown.flatMap(([day,projects])=>[[day,true],...projects.map(row=>[projectKey(row),true])])))}>展开本页</button><button className="ci-button" onClick={()=>setExpansion(Object.fromEntries(days.flatMap(([day,projects])=>[[day,false],...projects.map(row=>[projectKey(row),false])])))}>收起全部</button></div>
    <div className="ci-observation"><span className={`ci-dot${data?.partial?' pending':''}`}/>{data?.partial?'历史分批采集中 / 数据未完整':'缓存已更新'}<span>上次采集 {data?.checked_at?new Date(data.checked_at).toLocaleString():'尚未完成'} · 每 5 分钟增量 · UTC</span></div>
    {data?.progress&&<div className="ci-collection-progress"><progress aria-label="历史采集进度" max={Math.max(1,data.progress.bytes_total)} value={data.progress.bytes_read}/><span>已处理 {numeric(data.progress.files_complete)} / {numeric(data.progress.files_total)} 个会话文件 · 已读取 {numeric(data.progress.bytes_read/1048576)} / {numeric(data.progress.bytes_total/1048576)} MB{data.progress.files_complete<data.progress.files_total?'，项目列表仍在补全':''}</span></div>}
    {data?.error&&<p className="ci-notice" role="status">{data.error}</p>}{usage.isError&&<p className="ci-notice" role="alert">缓存读取失败，请刷新重试。</p>}
    <div className="ci-table-scroll"><table className="ci-table ci-usage-table"><colgroup><col style={{width:'26%'}}/>{[0,1,2,3,4,5,6,7].map(k=><col key={k} style={{width:k===3?'8%':'9.43%'}}/>)}</colgroup><thead><tr><th>日期 / 项目 / 模型</th><th>输入 Token</th><th>缓存输入</th><th>非缓存输入</th><th title="缓存输入 Token ÷ 输入 Token；汇总层按 Token 加权计算">缓存命中率</th><th>输出 Token</th><th>总 Token</th><th>当日占比</th><th>预计 Credits</th></tr></thead><tbody>
     {!days.length&&<tr><td colSpan={9} className="ci-empty">{usage.isPending?'正在读取缓存…':'所选范围暂无用量记录'}</td></tr>}
     {shown.map(([day,projects],index)=>{const open=expansion[day]??(currentPage===0&&index===0),total=sum(projects,'total_tokens');return <Day key={day} day={day} rows={projects} total={total} expanded={open} expansion={expansion} setExpansion={setExpansion} toggle={()=>setExpansion(p=>({...p,[day]:!open}))}/>;})}
    </tbody></table></div>
    <div className="ci-pagination"><span>{days.length} 个日期 · {rows.length} 个项目用量记录</span><button className="ci-button" disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}>上一页</button><span>{currentPage+1} / {pages}</span><button className="ci-button" disabled={currentPage+1>=pages} onClick={()=>setPage(currentPage+1)}>下一页</button></div>
    <p className="ci-footnote">缓存命中率 = 缓存输入 / 输入 Token；各汇总层按 Token 加权，输入为零或字段缺失时不计算。缓存输入包含于输入；占比以筛选后当日 Token 为分母。Credits 按 {data?.credit_rate_date||'当前'} 官方费率折算，非实际扣费；未记录速度时按 Standard 估算，带 * 为部分覆盖。<a href="https://learn.chatgpt.com/docs/pricing" target="_blank" rel="noreferrer">费率依据</a></p>
   </section>}
  </div>
 </Dialog>;
}
function CreditCell({rows}:{rows:Metrics[]}){const value=credits(rows);return <td title={partialCredits(rows)?'部分模型或 Token 字段缺失，仅计入可估算记录':'按当前官方费率折算，非账单'}>{value===null?'暂不可估':numeric(value)}{value!==null&&partialCredits(rows)?' *':''}</td>;}
function MetricCells({rows,total}:{rows:Metrics[];total:number|null}){
 const input=sum(rows,'input_tokens'),cached=sum(rows,'cached_input_tokens'),tokens=sum(rows,'total_tokens'),valid=input!==null&&cached!==null&&cached<=input;
 return <><td>{numeric(input)}</td><td>{numeric(cached)}</td><td>{valid?numeric(input-cached):'—'}</td><td>{valid&&input>0?`${(cached/input*100).toFixed(1)}%`:'—'}</td><td>{numeric(sum(rows,'output_tokens'))}</td><td>{numeric(tokens)}</td><td>{total&&tokens!==null?`${(tokens/total*100).toFixed(1)}%`:'—'}</td><CreditCell rows={rows}/></>;
}
function Day({day,rows,total,expanded,toggle,expansion,setExpansion}:{day:string;rows:Row[];total:number|null;expanded:boolean;toggle:()=>void;expansion:Record<string,boolean>;setExpansion:React.Dispatch<React.SetStateAction<Record<string,boolean>>>}){
 return <><tr className="ci-day"><td><button className="ci-tree-toggle" aria-label={`${expanded?'收起':'展开'} ${day}`} aria-expanded={expanded} onClick={toggle}><ChevronRight size={15} style={{transform:expanded?'rotate(90deg)':undefined}}/>{day}<span className="ci-count">{rows.length} 个项目</span></button></td><MetricCells rows={rows} total={total}/></tr>{expanded&&rows.map(row=>{const key=projectKey(row),open=!!expansion[key];return <Project key={key} row={row} total={total} expanded={open} toggle={()=>setExpansion(p=>({...p,[key]:!open}))}/>;})}</>;
}
function Project({row,total,expanded,toggle}:{row:Row;total:number|null;expanded:boolean;toggle:()=>void}){
 const label=row.project_name||row.cwd.split('/').filter(Boolean).pop()||'未归属';
 return <><tr className="ci-project"><td><div className="ci-project-name">{row.models?.length?<button className="ci-model-toggle" aria-label={`${expanded?'收起':'展开'} ${label} 模型`} aria-expanded={expanded} onClick={toggle}><ChevronRight size={13} style={{transform:expanded?'rotate(90deg)':undefined}}/></button>:null}<Folder size={14}/><strong>{label}</strong><span className="ci-count">{row.models?.length??0} 个模型</span></div><span className="ci-directory" title={row.cwd}>{row.cwd||'原始记录未提供工作目录'}</span></td><MetricCells rows={[row]} total={total}/></tr>{expanded&&row.models?.map(model=><tr key={model.model??'unknown'} className="ci-model"><td><div><Cpu size={13}/><span>{model.model||'模型未记录'}</span></div></td><MetricCells rows={[model]} total={total}/></tr>)}</>;
}
