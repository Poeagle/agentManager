import {Fragment,useMemo,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {ChevronRight,Folder,RefreshCw,Cpu} from 'lucide-react';
import {Dialog} from './Dialog';
import {fetchJSON} from '../lib/api';
import './CodexAccountInsights.css';
import {TableFrame,TableStateRow,TableHeaders} from './table/DataTable';
import {dimensionLabels,type Metrics,type UsageRow as Row,type Dimension,type UsageGroup} from './codex-usage-groups';
import {useUsageTable,usageFieldDescriptions} from './use-usage-table';
import {allocateUsagePeriods} from './usage-period-allocation';
type Usage={quota_hours?:Array<{hour:string;quota:number}>;quota_range?:{start:string|null;end:string|null;gaps?:number};timezone_pending?:string|null;unassigned?:{tokens:Record<string,number|null>;requests:number;estimated_credits:number|null}|null;initialized?:boolean;checked_at:string|null;partial:boolean;error:string|null;rows:Row[];timezone:string;credit_rate_date?:string;progress?:{history_files?:number;files_selected?:number;mode?:string;day?:string;files_total:number;files_complete:number;bytes_total:number;bytes_read:number}|null};
type Resets={collection_started_at?:string|null;checked_at?:string|null;error?:string|null;stale?:boolean;pending?:boolean;account:{email:string|null;plan:string|null};windows?:Array<{usedPercent:number;windowDurationMins:number|null;resetsAt:number|null}>;resets:{availableCount:number;credits:Array<{expiresAt:number|null;grantedAt:number|null;status:string|null}>|null}|null};
const numeric=(n:number|null|undefined)=>n==null?'—':n.toLocaleString(undefined,{maximumFractionDigits:2});
const compact=(n:number|null)=>n===null?'—':new Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:1}).format(n);
const cellNumber=(n:number|null|undefined)=>n==null?'':numeric(n);
const quotaNumber=(n:number|null)=>n===null?'':n.toLocaleString(undefined,{maximumFractionDigits:4});
const time=(value:number|null)=>value===null?'未提供':new Date(value*1000).toLocaleString();
const sum=(rows:Metrics[],field:string):number|null=>!rows.length||rows.some(r=>r.tokens[field]==null)?null:rows.reduce((s,r)=>s+r.tokens[field]!,0);
const credits=(rows:Metrics[])=>{const known=rows.filter(r=>r.estimated_credits!=null);return known.length?known.reduce((s,r)=>s+r.estimated_credits!,0):null;};
const partialCredits=(rows:Metrics[])=>rows.some(r=>r.estimated_credits==null||r.credit_coverage&&r.credit_coverage.covered<r.credit_coverage.total);
const treeKeys=(nodes:UsageGroup[]):string[]=>nodes.flatMap(n=>[n.key,...treeKeys(n.children)]);
// Reserve numeric columns from the longest formatted value, including descendants.
// Text columns have independent bounds; narrow screens scroll the whole table.
function usageColumnWidths(nodes:UsageGroup[]){
 // Keep headings, controls and full formatted numbers visible.
 const widths=[70,82,94,70,70,70,84,84,64];
 function visit(items:UsageGroup[]){for(const node of items){const t=node.metrics.tokens;
  [t.input_tokens,t.cached_input_tokens,t.input_tokens!=null&&t.cached_input_tokens!=null?t.input_tokens-t.cached_input_tokens:null,null,t.output_tokens,t.total_tokens,node.metrics.actual_quota,node.metrics.estimated_credits,null].forEach((value,i)=>{if(value!=null)widths[i]=Math.max(widths[i],(i===6?quotaNumber(value):numeric(value)).length*7+14);});visit(node.children);
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
 const datedRows=useMemo(()=>(data?.rows||[]).filter(r=>(!from||r.date>=from)&&(!to||r.date<=to)),[data,from,to]);
 const filteredRows=useMemo(()=>{const dated=datedRows;const hours=(data?.quota_hours||[]).filter(h=>(!from||h.hour.slice(0,10)>=from)&&(!to||h.hour.slice(0,10)<=to));const allocated=!apiMode&&data?.quota_hours?allocateUsagePeriods(dated,hours,dimension):dated;return allocated.filter(r=>!search||`${r.cwd} ${r.project_name||''}`.toLowerCase().includes(search.toLowerCase()));},[data,datedRows,from,to,search,apiMode,dimension]);
 const {rows,groups,table,creditTotals}=useUsageTable(filteredRows,dimension,datedRows);
 const pages=Math.max(1,Math.ceil(groups.length/10)),currentPage=Math.min(page,pages-1),shown=groups.slice(currentPage*10,currentPage*10+10);
 const input=sum(rows,'input_tokens'),cached=sum(rows,'cached_input_tokens'),cacheRate=input!==null&&input>0&&cached!==null&&cached<=input?cached/input*100:null;
 const incompleteCredits=!!data?.rows.some(row=>row.models?.length?row.models.some(model=>model.estimated_credits==null||!!model.credit_coverage&&model.credit_coverage.covered<model.credit_coverage.total):row.estimated_credits==null||!!row.credit_coverage&&row.credit_coverage.covered<row.credit_coverage.total);
 const summaryMetrics:Array<[string,number|null,string]>=[['总量',sum(rows,'total_tokens'),'筛选范围内原生日志记录的总 Token'],['输入',input,'筛选范围内输入 Token，包含缓存'],['缓存',cached,'筛选范围内命中缓存的输入 Token'],['推理',sum(rows,'reasoning_output_tokens'),'筛选范围内的推理 Token，包含在输出中'],['输出',sum(rows,'output_tokens'),'筛选范围内输出 Token，包含推理 Token']];
 const rangeTotal=credits(datedRows),byPeriod=['hour','day','week','month'].includes(dimension);
 const columnWidths=useMemo(()=>{const widths=usageColumnWidths(groups);return apiMode?widths.slice(0,6):widths;},[groups,apiMode]);
 const displayTable=apiMode?{...table,columns:table.columns.filter(column=>!['actual','credits','share'].includes(column.key))}:table;
 const periodName=dimension==='hour'?'小时':dimension==='day'?'日期':dimension==='week'?'周期':'月份';
 const cards=resets.data?.resets;
 const refresh=()=>{void usage.refetch();if(!apiMode)void resets.refetch();};
 const tabs=<nav className="ci-tabs" aria-label="账号详情栏目"><button aria-selected={tab==='usage'} onClick={()=>setTab('usage')}>每日项目用量</button><button aria-selected={tab==='cards'} onClick={()=>setTab('cards')}>重置卡{cards?` (${cards.availableCount})`:''}</button></nav>;
 return <Dialog appearance="manager" title={`${name} ${apiMode?'上游':'账号'}详情`} size="image" width={1450} maxWidth="96vw" onClose={onClose} actions={!apiMode?<div className="ci-header-details"><div className="ci-identity"><span>{resets.data?.account.email||name}</span><span className="ci-tag">{resets.data?.account.plan||'套餐未提供'}</span></div><div className="ci-overview ci-overview-account">
    <section>{resets.data?.windows?.length?resets.data.windows.map((w,i)=><div className="ci-quota" key={i}><span>{w.windowDurationMins===10080?'周额度':w.windowDurationMins?`${w.windowDurationMins/60} 小时`:'额度'}</span><strong>剩余 {numeric(Math.max(0,100-w.usedPercent))}%</strong><small title="当前额度窗口的下次重置时刻；不是采样统计的起止时间">重置 {time(w.resetsAt)}</small></div>):<p>{resets.isPending?'正在读取…':'额度暂不可用'}</p>}</section>
    <section><span className="ci-token-summary">Token {summaryMetrics.map(([label,value,meaning],index)=><Fragment key={label}>{index>0&&'｜'}<span title={`${meaning}：${numeric(value)}`}>{label}</span></Fragment>)}：{summaryMetrics.map(([label,value,meaning],index)=><Fragment key={label}>{index>0&&'｜'}<span title={`${meaning}：${numeric(value)}`}>{compact(value)}</span></Fragment>)}</span><span className="ci-cache-rate" title="筛选范围内缓存输入除以输入 Token；输入为零或数据缺失时未知" aria-label={`缓存率 ${cacheRate===null?'未知':`${cacheRate.toFixed(1)}%`}`}><span aria-hidden="true"/>缓存率 <strong>{cacheRate===null?'—':`${cacheRate.toFixed(1)}%`}</strong></span></section>
   </div><button className="ci-button ci-refresh-action" title="重新读取后台缓存，不触发采集" onClick={refresh} disabled={usage.isFetching||resets.isFetching}><RefreshCw size={14}/>刷新缓存</button></div>:undefined}>
  <div className="codex-insights">
   {apiMode?apiOverview:<>
   {resets.data?.error&&<p className="ci-notice" role="status">{resets.data.error}</p>}
   {tab==='cards'&&tabs}
</>}
   {tab==='cards'?<section aria-label="重置卡" className="ci-section">
    <h4>重置卡：{resets.isPending?'读取中…':cards?`${cards.availableCount} 张`:'未提供'}</h4>
    {resets.isError&&<p className="ci-notice" role="alert">重置卡读取失败，请刷新重试。</p>}
    {cards?.credits===null&&<p className="ci-muted">服务仅返回数量，未提供到期明细。</p>}
    {cards?.credits&&<TableFrame label="重置卡列表" className="ci-table-scroll" tableClassName="ci-table" header={<><th>卡片</th><th>状态</th><th>发放时间</th><th>到期时间</th></>}>{cards.credits.map((c,i)=><tr key={i}><td>重置卡 {i+1}</td><td><span className="ci-tag">{c.status==='available'?'可用':c.status||'未提供'}</span></td><td>{time(c.grantedAt)}</td><td>{time(c.expiresAt)}</td></tr>)}</TableFrame>}
    {cards?.credits&&cards.credits.length<cards.availableCount&&<p className="ci-muted">服务未返回全部卡片明细。</p>}
   </section>:<section aria-label="每日项目用量" className="ci-section">
    <div className="ci-toolbar">{!apiMode&&tabs}<label>统计维度 <select aria-label="统计维度" value={dimension} onChange={e=>{setDimension(e.target.value as Dimension);setPage(0);setExpansion({});}}>{Object.entries(dimensionLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><input aria-label="搜索项目或目录" placeholder="搜索项目名称或工作目录" value={search} onChange={e=>{setSearch(e.target.value);setPage(0);}}/><label>日期 <input type="date" aria-label="开始日期" value={from} onChange={e=>{setFrom(e.target.value);setPage(0);}}/>—<input type="date" aria-label="结束日期" value={to} onChange={e=>{setTo(e.target.value);setPage(0);}}/></label><button className="ci-button" onClick={()=>{table.reset();setSearch('');setFrom('');setTo('');setPage(0);}}>清除全部</button><button className="ci-button" onClick={()=>setExpansion(Object.fromEntries(treeKeys(shown).map(key=>[key,true])))}>展开本页</button><button className="ci-button" onClick={()=>setExpansion(Object.fromEntries(treeKeys(groups).map(key=>[key,false])))}>收起全部</button></div>
    <div className="ci-observation"><span className={`ci-dot${data?.partial?' pending':''}`}/>{data?.initialized===false?'首次全量采集尚未完成':data?.partial?'部分记录不可用 ｜ 数据未完整':'缓存已更新'}{data?.progress&&<span className="ci-collection-progress" title={`已读取 ${numeric(data.progress.bytes_read/1048576)} ｜ ${numeric(data.progress.bytes_total/1048576)} MB`}><progress aria-label="本轮采集进度" max={Math.max(1,data.progress.bytes_total)} value={data.progress.bytes_read}/><span>历史文件 {numeric(data.progress.history_files)} · 本轮读取 {numeric(data.progress.files_complete)} ｜ {numeric(data.progress.files_selected??data.progress.files_total)} 个文件 · {numeric(data.progress.bytes_read/1048576)} MB</span></span>}{!apiMode&&data?.quota_range?.start&&data.quota_range.end&&<span title="首次至末次可计入统计的额度采样时间；这是已观测数据的覆盖范围，并非周额度周期，中间可能有未覆盖时段">额度采样覆盖 {collectionTime(data.quota_range.start)} ～ {collectionTime(data.quota_range.end)}</span>}{!apiMode&&!!data?.quota_range?.gaps&&<span title="额度回升、采集断档或跨小时区间缺少计算依据时不计入">耗用额度部分时段未覆盖</span>}{!apiMode&&incompleteCredits&&<span title="部分请求缺少模型、速度或 Token，分配只使用可估算的请求">部分请求无法计算权重</span>}<span className="ci-last-collection">{!apiMode&&<span title={`最近成功一轮的额度采集启动：${resets.data?.collection_started_at?collectionTime(resets.data.collection_started_at):'未记录'}；显示值为接口读取完成时间；前端仅读缓存`}>额度读取完成 {resets.data?.checked_at?collectionTime(resets.data.checked_at):'尚未完成'} · </span>}<span title="最近一次成功扫描会话日志的完成时间；不代表最后一次 Token 使用时间">用量扫描完成 {data?.checked_at?collectionTime(data.checked_at):'尚未完成'}</span> · 每 5 分钟后台采集 · {zoneLabel}</span></div>
    {data?.error&&data.error!=='历史部分记录不可读取；已核对的数据已按新规则更新'&&!data.error.startsWith('历史缓存无法完整核对')&&data.error!=='部分历史原始日志缺失，已保留用量但无法按本地日期归属'&&data.error!=='部分记录不可读取或缺少统计字段'&&!data.error.startsWith('小时统计尚未完整：')&&<p className="ci-notice" role="status">{data.error}</p>}{usage.isError&&<p className="ci-notice" role="alert">缓存读取失败，请刷新重试。</p>}
    {rows.some(row=>!row.models?.length)&&<p className="ci-notice" role="status">部分项目的模型明细未返回，请刷新；若仍未恢复，请检查后台服务版本。</p>}
    <TableFrame label="用量统计" className="ci-table-scroll" tableClassName="ci-table ci-usage-table" style={{minWidth:485+columnWidths.reduce((s,w)=>s+w,0)}} columns={<colgroup><col style={{width:230}}/><col style={{width:255}}/>{columnWidths.map((width,k)=><col key={k} style={{width}}/>)}</colgroup>} header={<TableHeaders model={displayTable}/>}>
     {!groups.length&&<TableStateRow columnCount={apiMode?8:11}>{usage.isPending?'正在读取缓存…':'所选范围暂无用量记录'}</TableStateRow>}
     {shown.map((node,index)=><Group key={node.key} node={node} creditTotal={byPeriod?creditTotals.get(node.key)??null:rangeTotal} depth={0} apiMode={apiMode} defaultOpen={currentPage===0&&index===0} expansion={expansion} setExpansion={setExpansion}/>)}
    </TableFrame>
    <div className="ci-pagination"><span>{groups.length} 个{byPeriod?periodName:dimensionLabels[dimension]} · {new Set(rows.map(row=>JSON.stringify([row.date,row.cwd]))).size} 条日期｜项目记录</span><button className="ci-button" disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}>上一页</button><span>{currentPage+1} ｜ {pages}</span><button className="ci-button" disabled={currentPage+1>=pages} onClick={()=>setPage(currentPage+1)}>下一页</button></div>
    {apiMode?<p className="ci-footnote">日期按本地时间，周从周一开始。余额与实际扣费来自上游；Token 来自本地历史。</p>:<p className="ci-footnote">耗用额度以周额度百分点显示，只覆盖成功采样且能分配的区间；按所选周期内订阅参考值分配，读数未变化时显示 0，重置、采样中断及费率未知时不计入；其他未采集客户端的耗用或历史缺失也可能影响分配。宽表可横向滚动查看完整列。{'显示全部可归属记录；'}缓存命中率 = 缓存输入 ÷ 输入 Token；各汇总层按 Token 加权，输入为零或字段缺失时不计算。周从本地周一开始，日期筛选先于分组；占比以所选日期范围内{byPeriod?`对应${periodName}`:'全部范围'}全部项目及模型的预估积分为分母，搜索与字段筛选不改变分母。预估值按 {data?.credit_rate_date||'当前'} 官方费率与订阅速度倍率折算，用于比较而非实际扣费；未记录速度时按 Standard 估算，带 * 为部分覆盖。<a href="https://learn.chatgpt.com/docs/pricing" target="_blank" rel="noreferrer">费率依据</a></p>}
   </section>}
  </div>
 </Dialog>;
}
function CreditCell({rows}:{rows:Metrics[]}){const value=credits(rows);return <td data-field-description={usageFieldDescriptions.credits} title={partialCredits(rows)?'部分模型或 Token 字段缺失，仅计入可估算记录':'标准 Credits 费率结合订阅速度倍率的相对参考值，非账单'}>{value===null?'':numeric(value)}{value!==null&&partialCredits(rows)?' *':''}</td>;}
function MetricCells({rows,creditTotal,apiMode}:{rows:Metrics[];creditTotal:number|null;apiMode:boolean}){
 const amount=credits(rows),input=sum(rows,'input_tokens'),cached=sum(rows,'cached_input_tokens'),tokens=sum(rows,'total_tokens'),valid=input!==null&&cached!==null&&cached<=input;
 return <><td data-field-description={usageFieldDescriptions.input}>{cellNumber(input)}</td><td data-field-description={usageFieldDescriptions.cached}>{cellNumber(cached)}</td><td data-field-description={usageFieldDescriptions.uncached}>{valid?numeric(input-cached):''}</td><td data-field-description={usageFieldDescriptions.hit}>{valid&&input>0?`${(cached/input*100).toFixed(1)}%`:''}</td><td data-field-description={usageFieldDescriptions.output}>{cellNumber(sum(rows,'output_tokens'))}</td><td data-field-description={usageFieldDescriptions.total}>{cellNumber(tokens)}</td>{!apiMode&&<><td data-field-description={usageFieldDescriptions.actual} title="所选周期内观测的周额度百分点，按订阅参考值分配；未覆盖的时段不计入">{quotaNumber(rows.some(r=>r.actual_quota!=null)?rows.reduce((n,r)=>n+(r.actual_quota??0),0):null)}</td><CreditCell rows={rows}/><td data-field-description={usageFieldDescriptions.share}>{creditTotal&&amount!==null?`${(amount/creditTotal*100).toFixed(1)}%`:''}</td></>}</>;
}
function Group({node,creditTotal,depth,apiMode,defaultOpen=false,expansion,setExpansion}:{node:UsageGroup;creditTotal:number|null;depth:number;apiMode:boolean;defaultOpen?:boolean;expansion:Record<string,boolean>;setExpansion:React.Dispatch<React.SetStateAction<Record<string,boolean>>>}){
 const open=expansion[node.key]??defaultOpen,childKind=node.children[0]?.kind;
 const count=node.missingModels&&childKind==='model'?'模型明细不可用':node.children.length?`${node.children.length} ${childKind==='project'?'项目':childKind==='model'?'模型':'日期'}`:'';
 return <><tr className={depth===0?'ci-day':node.kind==='model'?'ci-model':'ci-project'}><td data-field-description={usageFieldDescriptions.label}><div className="ci-group-label" style={{paddingLeft:depth*20}}>{node.children.length>0?<button className="ci-model-toggle" aria-label={`${open?'收起':'展开'} ${node.label}${node.kind==='project'&&childKind==='model'?' 模型':''}`} aria-expanded={open} onClick={()=>setExpansion(p=>({...p,[node.key]:!open}))}><ChevronRight size={13} style={{transform:open?'rotate(90deg)':undefined}}/></button>:<span className="ci-model-toggle-spacer" aria-hidden="true"/>}{node.kind==='project'?<Folder size={14}/>:node.kind==='model'?<Cpu size={14}/>:null}<span className="ci-group-title" title={node.title||node.label}>{node.label}</span>{count&&<span className="ci-count">{count}</span>}</div></td><td data-field-description={usageFieldDescriptions.cwd} className="ci-directory-cell" title={node.kind==='project'?node.detail:undefined}>{node.kind==='project'?node.detail||'':null}</td><MetricCells rows={[node.metrics]} creditTotal={creditTotal} apiMode={apiMode}/></tr>{open&&node.children.map(child=><Group key={child.key} node={child} creditTotal={creditTotal} depth={depth+1} apiMode={apiMode} expansion={expansion} setExpansion={setExpansion}/>)}</>;
}
