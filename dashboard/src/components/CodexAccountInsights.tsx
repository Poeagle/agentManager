import {useMemo,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {ChevronRight,Folder,RefreshCw,Cpu} from 'lucide-react';
import {Dialog} from './Dialog';
import {fetchJSON} from '../lib/api';
import './CodexAccountInsights.css';
import {TableFrame,TableStateRow,TableHeaders} from './table/DataTable';
import {dimensionLabels,type Metrics,type UsageRow as Row,type Dimension,type UsageGroup} from './codex-usage-groups';
import {useUsageTable} from './use-usage-table';
type Usage={timezone_pending?:string|null;unassigned?:{tokens:Record<string,number|null>;requests:number;estimated_credits:number|null}|null;initialized?:boolean;checked_at:string|null;partial:boolean;error:string|null;rows:Row[];timezone:string;credit_rate_date?:string;progress?:{history_files?:number;files_selected?:number;mode?:string;day?:string;files_total:number;files_complete:number;bytes_total:number;bytes_read:number}|null};
type Resets={checked_at?:string|null;error?:string|null;stale?:boolean;pending?:boolean;account:{email:string|null;plan:string|null};windows?:Array<{usedPercent:number;windowDurationMins:number|null;resetsAt:number|null}>;resets:{availableCount:number;credits:Array<{expiresAt:number|null;grantedAt:number|null;status:string|null}>|null}|null};
const numeric=(n:number|null|undefined)=>n==null?'—':n.toLocaleString(undefined,{maximumFractionDigits:2});
const time=(value:number|null)=>value===null?'未提供':new Date(value*1000).toLocaleString();
const sum=(rows:Metrics[],field:string):number|null=>!rows.length||rows.some(r=>r.tokens[field]==null)?null:rows.reduce((s,r)=>s+r.tokens[field]!,0);
const credits=(rows:Metrics[])=>{const known=rows.filter(r=>r.estimated_credits!=null);return known.length?known.reduce((s,r)=>s+r.estimated_credits!,0):null;};
const partialCredits=(rows:Metrics[])=>rows.some(r=>r.estimated_credits==null||r.credit_coverage&&r.credit_coverage.covered<r.credit_coverage.total);
const treeKeys=(nodes:UsageGroup[]):string[]=>nodes.flatMap(n=>[n.key,...treeKeys(n.children)]);
// Reserve numeric columns from the longest formatted value, including descendants.
// Text columns have independent bounds; narrow screens scroll the whole table.
function usageColumnWidths(nodes:UsageGroup[]){
 // Include room for the English heading, sort arrow, filter control and cell padding.
 const widths=[150,150,160,135,150,145,145,110];
 function visit(items:UsageGroup[]){for(const node of items){const t=node.metrics.tokens;
  [t.input_tokens,t.cached_input_tokens,t.input_tokens!=null&&t.cached_input_tokens!=null?t.input_tokens-t.cached_input_tokens:null,null,t.output_tokens,t.total_tokens,node.metrics.estimated_credits,null].forEach((value,i)=>{if(value!=null)widths[i]=Math.max(widths[i],numeric(value).length*7+20);});visit(node.children);
 }}visit(nodes);return widths;
}
export function CodexAccountInsights({id,name,onClose,groupId,apiOverview}:{id:string;name:string;onClose:()=>void;groupId?:string;apiOverview?:React.ReactNode}){
 const apiMode=!!groupId;
 const [expansion,setExpansion]=useState<Record<string,boolean>>({});
 const [dimension,setDimension]=useState<Dimension>('day');
 const [search,setSearch]=useState(''),[from,setFrom]=useState(''),[to,setTo]=useState(''),[page,setPage]=useState(0),[tab,setTab]=useState<'usage'|'cards'>('usage');
 const base='/codex/environments/'+encodeURIComponent(id);
 const hourly=dimension==='hour';
 const usage=useQuery({queryKey:groupId?['codex-group-insights',groupId,hourly]:['codex-insights',id,hourly],queryFn:()=>fetchJSON<{usage:Usage}>((groupId?'/codex/balance-groups/'+encodeURIComponent(groupId)+'/insights':base+'/insights')+(hourly?'?granularity=hour':'')),retry:false,refetchInterval:300000});
 const resets=useQuery({queryKey:['codex-reset-credits',id],queryFn:()=>fetchJSON<Resets>(base+'/reset-credits'),retry:false,refetchInterval:300000,staleTime:300000,enabled:!apiMode});
 const data=usage.data?.usage;
 const timezone=data?.timezone||Intl.DateTimeFormat().resolvedOptions().timeZone;
 const collectionTime=(value:string)=>new Intl.DateTimeFormat('zh-CN',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(value));
 const zoneLabel=data?.timezone_pending?`原缓存 ${timezone} · 本地日期重建中`:`本地时间（${timezone}）`;
 const filteredRows=useMemo(()=>(data?.rows||[]).filter(r=>(!from||r.date>=from)&&(!to||r.date<=to)&&(!search||`${r.cwd} ${r.project_name||''}`.toLowerCase().includes(search.toLowerCase()))),[data,from,to,search]);
 const {rows,groups,table}=useUsageTable(filteredRows,dimension);
 const days=useMemo(()=>{const result=new Map<string,Row[]>();for(const row of rows){const group=result.get(row.date)||[];group.push(row);result.set(row.date,group);}return [...result].sort(([a],[b])=>b.localeCompare(a));},[rows]);
 const pages=Math.max(1,Math.ceil(groups.length/10)),currentPage=Math.min(page,pages-1),shown=groups.slice(currentPage*10,currentPage*10+10);
 const input=sum(rows,'input_tokens'),cached=sum(rows,'cached_input_tokens'),uncached=input!==null&&cached!==null&&cached<=input?input-cached:null;
 const rangeTotal=credits(rows),byPeriod=['hour','day','week','month'].includes(dimension);
 const columnWidths=useMemo(()=>usageColumnWidths(groups),[groups]);
 const periodName=dimension==='hour'?'小时':dimension==='day'?'日期':dimension==='week'?'周期':'月份';
 const cards=resets.data?.resets;
 const refresh=()=>{void usage.refetch();if(!apiMode)void resets.refetch();};
 return <Dialog appearance="manager" title={`${name} ${apiMode?'上游':'账号'}详情`} size="image" width={1480} onClose={onClose}>
  <div className="codex-insights">
   {apiMode?apiOverview:<>   <div className="ci-identity"><span>{resets.data?.account.email||name}</span><span className="ci-tag">{resets.data?.account.plan||'套餐未提供'}</span><span className="ci-snapshot" title={resets.data?.checked_at?`额度与重置卡上次成功采集：${new Date(resets.data.checked_at).toLocaleString()}${resets.data.stale?'；显示上次成功数据':''}`:'等待首次后台采集'}>额度与重置卡 · 每 5 分钟更新{resets.data?.stale?' · 缓存已过期':''}</span><button className="ci-button" title="重新读取后台缓存，不触发采集" onClick={refresh} disabled={usage.isFetching||resets.isFetching}><RefreshCw size={14}/>刷新缓存</button></div>
   <div className="ci-overview ci-overview-account">
    <section><span className="ci-label">账号额度</span>{resets.data?.windows?.length?resets.data.windows.map((w,i)=><div className="ci-quota" key={i}><span>{w.windowDurationMins===10080?'周额度':w.windowDurationMins?`${w.windowDurationMins/60} 小时`:'额度'}</span><strong>剩余 {numeric(Math.max(0,100-w.usedPercent))}%</strong><small>重置 {time(w.resetsAt)}</small></div>):<p>{resets.isPending?'正在读取…':'额度暂不可用'}</p>}</section>
    <section><span className="ci-label">所选范围用量</span><div className="ci-usage-breakdown"><span>输入（未缓存） <strong>{numeric(uncached)}</strong></span><span>输入（缓存） <strong>{numeric(cached)}</strong></span><span>输出 <strong>{numeric(sum(rows,'output_tokens'))}</strong></span></div><span className="ci-muted">Token · {days.length} 天 · {new Set(rows.map(r=>r.cwd)).size} 个工作目录</span></section>
   </div>
   {resets.data?.error&&<p className="ci-notice" role="status">{resets.data.error}</p>}
   <nav className="ci-tabs" aria-label="账号详情栏目"><button aria-selected={tab==='usage'} onClick={()=>setTab('usage')}>每日项目用量</button><button aria-selected={tab==='cards'} onClick={()=>setTab('cards')}>重置卡{cards?` (${cards.availableCount})`:''}</button></nav>
</>}
   {tab==='cards'?<section aria-label="重置卡" className="ci-section">
    <h4>重置卡：{resets.isPending?'读取中…':cards?`${cards.availableCount} 张`:'未提供'}</h4>
    {resets.isError&&<p className="ci-notice" role="alert">重置卡读取失败，请刷新重试。</p>}
    {cards?.credits===null&&<p className="ci-muted">服务仅返回数量，未提供到期明细。</p>}
    {cards?.credits&&<TableFrame label="重置卡列表" className="ci-table-scroll" tableClassName="ci-table" header={<><th>卡片</th><th>状态</th><th>发放时间</th><th>到期时间</th></>}>{cards.credits.map((c,i)=><tr key={i}><td>重置卡 {i+1}</td><td><span className="ci-tag">{c.status==='available'?'可用':c.status||'未提供'}</span></td><td>{time(c.grantedAt)}</td><td>{time(c.expiresAt)}</td></tr>)}</TableFrame>}
    {cards?.credits&&cards.credits.length<cards.availableCount&&<p className="ci-muted">服务未返回全部卡片明细。</p>}
   </section>:<section aria-label="每日项目用量" className="ci-section">
    <div className="ci-toolbar"><label>统计维度 <select aria-label="统计维度" value={dimension} onChange={e=>{setDimension(e.target.value as Dimension);setPage(0);setExpansion({});}}>{Object.entries(dimensionLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><input aria-label="搜索项目或目录" placeholder="搜索项目名称或工作目录" value={search} onChange={e=>{setSearch(e.target.value);setPage(0);}}/><label>日期 <input type="date" aria-label="开始日期" value={from} onChange={e=>{setFrom(e.target.value);setPage(0);}}/>—<input type="date" aria-label="结束日期" value={to} onChange={e=>{setTo(e.target.value);setPage(0);}}/></label><button className="ci-button" onClick={()=>{table.reset();setSearch('');setFrom('');setTo('');setPage(0);}}>清除全部</button><button className="ci-button" onClick={()=>setExpansion(Object.fromEntries(treeKeys(shown).map(key=>[key,true])))}>展开本页</button><button className="ci-button" onClick={()=>setExpansion(Object.fromEntries(treeKeys(groups).map(key=>[key,false])))}>收起全部</button></div>
    <div className="ci-observation"><span className={`ci-dot${data?.partial?' pending':''}`}/>{data?.initialized===false?'首次全量采集尚未完成':data?.partial?'部分记录不可用 / 数据未完整':'缓存已更新'}{data?.progress&&<span className="ci-collection-progress" title={`已读取 ${numeric(data.progress.bytes_read/1048576)} / ${numeric(data.progress.bytes_total/1048576)} MB`}><progress aria-label="本轮采集进度" max={Math.max(1,data.progress.bytes_total)} value={data.progress.bytes_read}/><span>历史文件 {numeric(data.progress.history_files)} · 本轮读取 {numeric(data.progress.files_complete)} / {numeric(data.progress.files_selected??data.progress.files_total)} 个文件 · {numeric(data.progress.bytes_read/1048576)} MB</span></span>}<span className="ci-last-collection">上次采集 {data?.checked_at?collectionTime(data.checked_at):'尚未完成'} · 每 5 分钟采集当天 · {zoneLabel}</span></div>
    {data?.error&&data.error!=='部分历史原始日志缺失，已保留用量但无法按本地日期归属'&&data.error!=='部分记录不可读取或缺少统计字段'&&!data.error.startsWith('小时统计尚未完整：')&&<p className="ci-notice" role="status">{data.error}</p>}{usage.isError&&<p className="ci-notice" role="alert">缓存读取失败，请刷新重试。</p>}
    {rows.some(row=>!row.models?.length)&&<p className="ci-notice" role="status">部分项目的模型明细未返回，请刷新；若仍未恢复，请检查后台服务版本。</p>}
    <TableFrame label="用量统计" className="ci-table-scroll" tableClassName="ci-table ci-usage-table" style={{minWidth:500+columnWidths.reduce((s,w)=>s+w,0)}} columns={<colgroup><col style={{width:240}}/><col style={{width:260}}/>{columnWidths.map((width,k)=><col key={k} style={{width}}/>)}</colgroup>} header={<TableHeaders model={table}/>}>
     {!groups.length&&<TableStateRow columnCount={10}>{usage.isPending?'正在读取缓存…':'所选范围暂无用量记录'}</TableStateRow>}
     {shown.map((node,index)=><Group key={node.key} node={node} creditTotal={byPeriod?node.metrics.estimated_credits??null:rangeTotal} depth={0} defaultOpen={currentPage===0&&index===0} expansion={expansion} setExpansion={setExpansion}/>)}
    </TableFrame>
    <div className="ci-pagination"><span>{groups.length} 个{byPeriod?periodName:dimensionLabels[dimension]} · {new Set(rows.map(row=>JSON.stringify([row.date,row.cwd]))).size} 条日期/项目记录</span><button className="ci-button" disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}>上一页</button><span>{currentPage+1} / {pages}</span><button className="ci-button" disabled={currentPage+1>=pages} onClick={()=>setPage(currentPage+1)}>下一页</button></div>
    {apiMode?<p className="ci-footnote">日期按本地时间，周从周一开始。余额与实际扣费来自上游；Token 与 Credits 来自本地历史，Credits 为估算值。</p>:<p className="ci-footnote">宽表可横向滚动查看完整列。{'显示全部可归属记录；'}缓存命中率 = 缓存输入 / 输入 Token；各汇总层按 Token 加权，输入为零或字段缺失时不计算。周从本地周一开始，日期筛选先于分组；占比以筛选后{byPeriod?`对应${periodName}`:'全部范围'}预计 Credits 为分母。Credits 按 {data?.credit_rate_date||'当前'} 官方费率折算，非实际扣费；未记录速度时按 Standard 估算，带 * 为部分覆盖。<a href="https://learn.chatgpt.com/docs/pricing" target="_blank" rel="noreferrer">费率依据</a></p>}
   </section>}
  </div>
 </Dialog>;
}
function CreditCell({rows}:{rows:Metrics[]}){const value=credits(rows);return <td title={partialCredits(rows)?'部分模型或 Token 字段缺失，仅计入可估算记录':'按当前官方费率折算，非账单'}>{value===null?'—':numeric(value)}{value!==null&&partialCredits(rows)?' *':''}</td>;}
function MetricCells({rows,creditTotal}:{rows:Metrics[];creditTotal:number|null}){
 const amount=credits(rows),input=sum(rows,'input_tokens'),cached=sum(rows,'cached_input_tokens'),tokens=sum(rows,'total_tokens'),valid=input!==null&&cached!==null&&cached<=input;
 return <><td>{numeric(input)}</td><td>{numeric(cached)}</td><td>{valid?numeric(input-cached):'—'}</td><td>{valid&&input>0?`${(cached/input*100).toFixed(1)}%`:'—'}</td><td>{numeric(sum(rows,'output_tokens'))}</td><td>{numeric(tokens)}</td><CreditCell rows={rows}/><td>{creditTotal&&amount!==null?`${(amount/creditTotal*100).toFixed(1)}%`:'—'}</td></>;
}
function Group({node,creditTotal,depth,defaultOpen=false,expansion,setExpansion}:{node:UsageGroup;creditTotal:number|null;depth:number;defaultOpen?:boolean;expansion:Record<string,boolean>;setExpansion:React.Dispatch<React.SetStateAction<Record<string,boolean>>>}){
 const open=expansion[node.key]??defaultOpen,childKind=node.children[0]?.kind;
 const count=node.missingModels&&childKind==='model'?'Model details unavailable':node.children.length?`${node.children.length} ${childKind==='project'?'project':childKind==='model'?'model':'date'}${node.children.length===1?'':'s'}`:'';
 return <><tr className={depth===0?'ci-day':node.kind==='model'?'ci-model':'ci-project'}><td><div className="ci-group-label" style={{paddingLeft:depth*20}}>{node.children.length>0&&<button className="ci-model-toggle" aria-label={`${open?'收起':'展开'} ${node.label}${node.kind==='project'&&childKind==='model'?' 模型':''}`} aria-expanded={open} onClick={()=>setExpansion(p=>({...p,[node.key]:!open}))}><ChevronRight size={13} style={{transform:open?'rotate(90deg)':undefined}}/></button>}{node.kind==='project'?<Folder size={14}/>:node.kind==='model'?<Cpu size={14}/>:null}<span className="ci-group-title" title={node.title||node.label}>{node.label}</span>{count&&<span className="ci-count">{count}</span>}</div></td><td className="ci-directory-cell" title={node.detail}>{node.detail||'—'}</td><MetricCells rows={[node.metrics]} creditTotal={creditTotal}/></tr>{open&&node.children.map(child=><Group key={child.key} node={child} creditTotal={creditTotal} depth={depth+1} expansion={expansion} setExpansion={setExpansion}/>)}</>;
}
