import {usagePeriod} from './usage-period-allocation';
import {useMemo,useState} from 'react';
import {useTableModel,type TableColumn,type TableModel} from './table/use-table-model';
import {groupUsage,type Dimension,type Metrics,type UsageGroup,type UsageRow} from './codex-usage-groups';

export const usageFieldDescriptions:Record<string,string>={'label':'按所选维度分组；日期使用平台本地时区，项目按工作目录区分。','cwd':'请求记录中的工作目录；项目名称按平台登记目录匹配。','input':'各请求的输入 Token 累加，包含缓存输入和重复上下文。','cached':'输入 Token 中命中缓存的部分。','uncached':'输入减去缓存输入；缺失或数值异常时显示未知。','hit':'缓存输入除以输入；汇总时先相加再计算。','output':'输出 Token 累加；推理 Token 包含在输出中。','total':'原生日志中记录的总 Token 累加。','actual':'周额度已用百分比的采样变化，按所选周期订阅参考值分配；只覆盖可采集且可分配的区间；数据不完整时按已有记录分配，可能存在偏差。读数未变时为零，但不能证明没有耗用。数值单位为百分点。','credits':'以标准 Credits 费率为基准估算订阅额度相对用量；Fast 按 2.5 倍，未记录档位按标准估算，不是实际账单。','share':'该项预估积分占所选日期范围内同周期全部项目和模型预估积分的比例；搜索和字段筛选不改变分母。'};
type Leaf=UsageRow&{modelName:string|null;missing:boolean};
const number=(m:Metrics,key:string)=>m.tokens[key]??null;
const uncached=(m:Metrics)=>{const a=number(m,'input_tokens'),b=number(m,'cached_input_tokens');return a!==null&&b!==null&&b<=a?a-b:null;};
const hit=(m:Metrics)=>{const a=number(m,'input_tokens'),b=number(m,'cached_input_tokens');return a!==null&&a>0&&b!==null&&b<=a?100*b/a:null;};
const periodKey=(row:UsageRow,dimension:Dimension)=>usagePeriod(row.date,row.hour,dimension);
const collator=new Intl.Collator('zh-CN',{numeric:true,sensitivity:'base'});
function value(group:UsageGroup,key:string):string|number|null{
 const m=group.metrics;
 switch(key){case 'label':return group.label;case 'cwd':return group.detail||null;case 'input':return number(m,'input_tokens');case 'cached':return number(m,'cached_input_tokens');case 'uncached':return uncached(m);case 'hit':return hit(m);case 'output':return number(m,'output_tokens');case 'total':return number(m,'total_tokens');case 'actual':return m.actual_quota??null;case 'credits':case 'share':return m.estimated_credits??null;default:return null;}
}
function sortGroups(groups:UsageGroup[],sort:{key:string;direction:'asc'|'desc'}|null):UsageGroup[]{
 const result=groups.map(group=>({...group,children:sortGroups(group.children,sort)}));if(!sort)return result;
 return result.map((group,index)=>({group,index})).sort((a,b)=>{const x=value(a.group,sort.key),y=value(b.group,sort.key);if(x==null)return y==null?a.index-b.index:1;if(y==null)return -1;const n=typeof x==='number'&&typeof y==='number'?x-y:collator.compare(String(x),String(y));return (sort.direction==='asc'?n:-n)||a.index-b.index;}).map(x=>x.group);
}
export function useUsageTable(rows:UsageRow[],dimension:Dimension,referenceRows:UsageRow[]=rows){
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
  {key:'actual',description:usageFieldDescriptions.actual,title:'耗用额度',kind:'number',filterMode:'range',value:r=>r.actual_quota??null},
  {key:'credits',description:usageFieldDescriptions.credits,title:'预估积分',kind:'number',filterMode:'range',value:r=>r.estimated_credits??null},
 ],[dimension]);
 const base=useTableModel(leaves,columns);
 const denominators=useMemo(()=>{
  const totals=new Map<string,number|null>();
  for(const row of referenceRows){const key=periodKey(row,dimension);if(!totals.has(key))totals.set(key,null);for(const model of row.models?.length?row.models:[row])if(model.estimated_credits!=null)totals.set(key,(totals.get(key)??0)+model.estimated_credits);}
  return totals;
 },[referenceRows,dimension]);
 const shareColumns=useMemo<TableColumn<Leaf>[]>(()=>[{key:'share',description:usageFieldDescriptions.share,title:'占比',kind:'number',filterMode:'range',value:r=>{const denominator=denominators.get(periodKey(r,dimension));return denominator&&r.estimated_credits!=null?100*r.estimated_credits/denominator:null;}}],[denominators,dimension]);
 const share=useTableModel(base.rows,shareColumns);
 const selected=useMemo<UsageRow[]>(()=>share.rows.map(({modelName:_,missing:__,...row})=>row),[share.rows]);
 const groups=useMemo(()=>sortGroups(groupUsage(selected,dimension),sort),[selected,dimension,sort]);
 const table:TableModel<Leaf>={...base,columns:[...columns,...shareColumns],sort,filters:{...base.filters,...share.filters},active:base.active||share.active||!!sort,
  toggleSort(key){setSort(current=>current?.key!==key?{key,direction:'asc'}:current.direction==='asc'?{key,direction:'desc'}:null);},
  setFilter(key,filter){(key==='share'?share:base).setFilter(key,filter);},options(key){return (key==='share'?share:base).options(key);},reset(){base.reset();share.reset();setSort(null);},rows:share.rows};
 const creditTotals=useMemo(()=>new Map(groupUsage(referenceRows,dimension).map(group=>[group.key,group.metrics.estimated_credits??null])),[referenceRows,dimension]);
 return {rows:selected,groups,table,creditTotals};
}
