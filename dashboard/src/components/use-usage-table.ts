import {useMemo,useState} from 'react';
import {useTableModel,type TableColumn,type TableModel} from './table/use-table-model';
import {groupUsage,type Dimension,type Metrics,type UsageGroup,type UsageRow} from './codex-usage-groups';

export const usageFieldDescriptions:Record<string,string>={'label':'按所选维度分组；日期使用平台本地时区，项目按工作目录区分。','cwd':'请求记录中的工作目录；项目名称按平台登记目录匹配。','input':'各请求的输入 Token 累加，包含缓存输入和重复上下文。','cached':'输入 Token 中命中缓存的部分。','uncached':'输入减去缓存输入；缺失或数值异常时显示未知。','hit':'缓存输入除以输入；汇总时先相加再计算。','output':'输出 Token 累加；推理 Token 包含在输出中。','total':'原生日志中记录的总 Token 累加。','actual':'周额度已用百分比的采样变化，按区间预估 Credits 分配；只覆盖可采集且可分配的区间；读数未变时为零，但不能证明没有耗用。数值单位为百分点。','credits':'按模型和服务档位费率折算 Token；Fast 和 priority 按双倍估算，未记录档位按标准估算，不是实际账单。','share':'该项预估 Credits 占筛选后对应时间段或全部范围预估 Credits 的比例。'};
type Leaf=UsageRow&{modelName:string|null;missing:boolean};
const number=(m:Metrics,key:string)=>m.tokens[key]??null;
const uncached=(m:Metrics)=>{const a=number(m,'input_tokens'),b=number(m,'cached_input_tokens');return a!==null&&b!==null&&b<=a?a-b:null;};
const hit=(m:Metrics)=>{const a=number(m,'input_tokens'),b=number(m,'cached_input_tokens');return a!==null&&a>0&&b!==null&&b<=a?100*b/a:null;};
const totalCredits=(data:Metrics[])=>{const known=data.filter(r=>r.estimated_credits!=null);return known.length?known.reduce((n,r)=>n+r.estimated_credits!,0):null;};
function periodKey(row:UsageRow,dimension:Dimension){const date=row.date;if(dimension==='hour')return row.hour||`${date} unknown`;if(dimension==='month')return date.slice(0,7);if(dimension==='week'){const value=new Date(date+'T00:00:00Z');value.setUTCDate(value.getUTCDate()-(value.getUTCDay()+6)%7);return value.toISOString().slice(0,10);}return dimension==='day'?date:'all';}
const collator=new Intl.Collator('zh-CN',{numeric:true,sensitivity:'base'});
function value(group:UsageGroup,key:string):string|number|null{
 const m=group.metrics;
 switch(key){case 'label':return group.label;case 'cwd':return group.detail||null;case 'input':return number(m,'input_tokens');case 'cached':return number(m,'cached_input_tokens');case 'uncached':return uncached(m);case 'hit':return hit(m);case 'output':return number(m,'output_tokens');case 'total':return number(m,'total_tokens');case 'actual':return m.actual_quota??null;case 'credits':case 'share':return m.estimated_credits??null;default:return null;}
}
function sortGroups(groups:UsageGroup[],sort:{key:string;direction:'asc'|'desc'}|null):UsageGroup[]{
 const result=groups.map(group=>({...group,children:sortGroups(group.children,sort)}));if(!sort)return result;
 return result.map((group,index)=>({group,index})).sort((a,b)=>{const x=value(a.group,sort.key),y=value(b.group,sort.key);if(x==null)return y==null?a.index-b.index:1;if(y==null)return -1;const n=typeof x==='number'&&typeof y==='number'?x-y:collator.compare(String(x),String(y));return (sort.direction==='asc'?n:-n)||a.index-b.index;}).map(x=>x.group);
}
export function useUsageTable(rows:UsageRow[],dimension:Dimension){
 const [sort,setSort]=useState<{key:string;direction:'asc'|'desc'}|null>(null);
 const leaves=useMemo<Leaf[]>(()=>rows.flatMap<Leaf>(row=>row.models?.length?row.models.map(m=>({...row,...m,modelName:m.model,models:[m],missing:false})): [{...row,modelName:null,missing:true}]),[rows]);
 const columns=useMemo<TableColumn<Leaf>[]>(()=>[
  {key:'label',description:usageFieldDescriptions.label,title:dimension==='project'?'项目 ｜ 模型 ｜ 日期':dimension==='model'?'模型 ｜ 项目 ｜ 日期':`${dimension==='hour'?'小时':dimension==='week'?'周':dimension==='month'?'月':'日期'} ｜ 项目 ｜ 模型`,filterMode:'text',value:r=>`${r.date} ${r.hour||''} ${r.project_name||''} ${r.modelName||''}`},
  {key:'cwd',description:usageFieldDescriptions.cwd,title:'工作目录',filterMode:'text',value:r=>r.cwd},
  {key:'input',description:usageFieldDescriptions.input,title:'输入',kind:'number',filterMode:'range',value:r=>number(r,'input_tokens')},
  {key:'cached',description:usageFieldDescriptions.cached,title:'缓存输入',kind:'number',filterMode:'range',value:r=>number(r,'cached_input_tokens')},
  {key:'uncached',description:usageFieldDescriptions.uncached,title:'非缓存输入',kind:'number',filterMode:'range',value:uncached},
  {key:'hit',description:usageFieldDescriptions.hit,title:'缓存率',kind:'number',filterMode:'range',value:hit},
  {key:'output',description:usageFieldDescriptions.output,title:'输出',kind:'number',filterMode:'range',value:r=>number(r,'output_tokens')},
  {key:'total',description:usageFieldDescriptions.total,title:'总量',kind:'number',filterMode:'range',value:r=>number(r,'total_tokens')},
  {key:'actual',description:usageFieldDescriptions.actual,title:'耗用率',kind:'number',filterMode:'range',value:r=>r.actual_quota??null},
  {key:'credits',description:usageFieldDescriptions.credits,title:'预估额度',kind:'number',filterMode:'range',value:r=>r.estimated_credits??null},
 ],[dimension]);
 const base=useTableModel(leaves,columns);
 const denominators=useMemo(()=>{const groups=new Map<string,Leaf[]>();for(const row of base.rows){const key=periodKey(row,dimension);groups.set(key,[...groups.get(key)||[],row]);}return new Map([...groups].map(([key,items])=>[key,totalCredits(items)]));},[base.rows,dimension]);
 const shareColumns=useMemo<TableColumn<Leaf>[]>(()=>[{key:'share',description:usageFieldDescriptions.share,title:'占比',kind:'number',filterMode:'range',value:r=>{const denominator=denominators.get(periodKey(r,dimension));return denominator&&r.estimated_credits!=null?100*r.estimated_credits/denominator:null;}}],[denominators,dimension]);
 const share=useTableModel(base.rows,shareColumns);
 const selected=useMemo<UsageRow[]>(()=>share.rows.map(({modelName:_,missing:__,...row})=>row),[share.rows]);
 const groups=useMemo(()=>sortGroups(groupUsage(selected,dimension),sort),[selected,dimension,sort]);
 const table:TableModel<Leaf>={...base,columns:[...columns,...shareColumns],sort,filters:{...base.filters,...share.filters},active:base.active||share.active||!!sort,
  toggleSort(key){setSort(current=>current?.key!==key?{key,direction:'asc'}:current.direction==='asc'?{key,direction:'desc'}:null);},
  setFilter(key,filter){(key==='share'?share:base).setFilter(key,filter);},options(key){return (key==='share'?share:base).options(key);},reset(){base.reset();share.reset();setSort(null);},rows:share.rows};
 return {rows:selected,groups,table};
}
