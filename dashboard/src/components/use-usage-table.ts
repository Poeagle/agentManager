import {usageDateRange,type UsageDateRange} from './usage-date-range';
import {usagePeriod} from './usage-period-allocation';
import {useMemo,useState} from 'react';
import {useTableModel,type TableColumn,type TableModel} from './table/use-table-model';
import {groupUsage,type Dimension,type Metrics,type UsageGroup,type UsageRow} from './codex-usage-groups';

export const usageFieldDescriptions:Record<string,string>={'label':'按所选维度分组；日期使用平台本地时区，项目按工作目录区分。','cwd':'可解析的软链接别名按真实工作目录合并；显示平台登记目录或真实目录，原始路径仍保留在日志和 CSV 中。','input':'各请求的输入 Token 累加，包含缓存输入和重复上下文。','cached':'输入 Token 中命中缓存的部分。','uncached':'输入减去缓存输入；缺失或数值异常时显示未知。','hit':'缓存输入除以输入；汇总时先相加再计算。','output':'输出 Token 累加；推理 Token 包含在输出中。','total':'原生日志中记录的总 Token 累加。','actual':'周额度已用百分比的采样变化，按所选周期订阅参考值分配；只覆盖可采集且可分配的区间；数据不完整时按已有记录分配，可能存在偏差。读数未变时为零，但不能证明没有耗用。数值单位为百分点。','cost':'根据官方模型费率、速度档位和 Token 用量估算 USD 等值金额；不代表实际账单，只覆盖已知模型费率。','share':'该项预估金额占实际统计范围内同周期全部项目和模型预估金额的比例；搜索和字段筛选不改变分母。'};
usageFieldDescriptions.cost+=` ${usageFieldDescriptions.actual} 括号内为预估金额除以采样额度；额度为零或字段缺失时不计算。此列按预估金额排序和筛选。`;
usageFieldDescriptions.reasoning='推理 Token 和对应的预估耗费已计入输出。';
type Leaf=UsageRow&{modelName:string|null;missing:boolean};
const number=(m:Metrics,key:string)=>m.tokens[key]??null;
const uncached=(m:Metrics)=>{const a=number(m,'input_tokens'),b=number(m,'cached_input_tokens');return a!==null&&b!==null&&b<=a?a-b:null;};
const hit=(m:Metrics)=>{const a=number(m,'input_tokens'),b=number(m,'cached_input_tokens');return a!==null&&a>0&&b!==null&&b<=a?100*b/a:null;};
const periodKey=(row:UsageRow,dimension:Dimension)=>usagePeriod(row.date,row.hour,dimension);
const collator=new Intl.Collator('zh-CN',{numeric:true,sensitivity:'base'});
function value(group:UsageGroup,key:string):string|number|null{
 const m=group.metrics;
 switch(key){case 'label':return group.label;case 'cwd':return group.detail||null;case 'input':return number(m,'input_tokens');case 'cached':return number(m,'cached_input_tokens');case 'uncached':return uncached(m);case 'hit':return hit(m);case 'reasoning':return number(m,'reasoning_output_tokens');case 'output':return number(m,'output_tokens');case 'total':return number(m,'total_tokens');case 'cost':case 'share':return m.estimated_usd??null;default:return null;}
}
function sortGroups(groups:UsageGroup[],sort:{key:string;direction:'asc'|'desc'}|null):UsageGroup[]{
 const result=groups.map(group=>({...group,children:sortGroups(group.children,sort)}));if(!sort)return result;
 return result.map((group,index)=>({group,index})).sort((a,b)=>{const x=value(a.group,sort.key),y=value(b.group,sort.key);if(x==null)return y==null?a.index-b.index:1;if(y==null)return -1;const n=typeof x==='number'&&typeof y==='number'?x-y:collator.compare(String(x),String(y));return (sort.direction==='asc'?n:-n)||a.index-b.index;}).map(x=>x.group);
}
export function useUsageTable(rows:UsageRow[],dimension:Dimension,referenceRows:UsageRow[]=rows,range?:UsageDateRange){
 const groupRange=useMemo(()=>range??usageDateRange('','',dimension,referenceRows.map(row=>row.date)),[range,referenceRows,dimension]);
 const [sort,setSort]=useState<{key:string;direction:'asc'|'desc'}|null>(null);
 const leaves=useMemo<Leaf[]>(()=>rows.flatMap<Leaf>(row=>row.models?.length?row.models.map(m=>({...row,...m,modelName:m.model,models:[m],missing:false})): [{...row,modelName:null,missing:true}]),[rows]);
 const columns=useMemo<TableColumn<Leaf>[]>(()=>[
  {key:'label',description:usageFieldDescriptions.label,title:dimension==='project'?'项目 ｜ 模型 ｜ 日期':dimension==='model'?'模型 ｜ 项目 ｜ 日期':`${dimension==='hour'?'小时':dimension==='week'?'周':dimension==='month'?'月':dimension==='total'?'总量':'日期'} ｜ 项目 ｜ 模型`,filterMode:'text',value:r=>`${r.date} ${r.hour||''} ${r.project_name||''} ${r.modelName||''}`},
  {key:'cwd',description:usageFieldDescriptions.cwd,title:'工作目录',filterMode:'text',value:r=>r.cwd},
  {key:'input',description:usageFieldDescriptions.input,title:'输入',kind:'number',filterMode:'range',value:r=>number(r,'input_tokens')},
  {key:'cached',description:usageFieldDescriptions.cached,title:'缓存输入',kind:'number',filterMode:'range',value:r=>number(r,'cached_input_tokens')},
  {key:'uncached',description:usageFieldDescriptions.uncached,title:'非缓存输入',kind:'number',filterMode:'range',value:uncached},
  {key:'hit',description:usageFieldDescriptions.hit,title:'缓存率',kind:'number',filterMode:'range',value:hit},
  {key:'reasoning',description:usageFieldDescriptions.reasoning,title:'推理',kind:'number',filterMode:'range',value:r=>number(r,'reasoning_output_tokens')},
  {key:'output',description:usageFieldDescriptions.output,title:'输出',kind:'number',filterMode:'range',value:r=>number(r,'output_tokens')},
  {key:'total',description:usageFieldDescriptions.total,title:'总量',kind:'number',filterMode:'range',value:r=>number(r,'total_tokens')},
  {key:'cost',description:usageFieldDescriptions.cost,title:'预估金额 | 额度',kind:'number',filterMode:'range',value:r=>r.estimated_usd??null},
 ],[dimension]);
 const base=useTableModel(leaves,columns);
 const denominators=useMemo(()=>{
  const totals=new Map<string,number|null>();
  for(const row of referenceRows){const key=periodKey(row,dimension);if(!totals.has(key))totals.set(key,null);for(const model of row.models?.length?row.models:[row])if(model.estimated_usd!=null)totals.set(key,(totals.get(key)??0)+model.estimated_usd);}
  return totals;
 },[referenceRows,dimension]);
 const shareColumns=useMemo<TableColumn<Leaf>[]>(()=>[{key:'share',description:usageFieldDescriptions.share,title:'占比',kind:'number',filterMode:'range',value:r=>{const denominator=denominators.get(periodKey(r,dimension));return denominator&&r.estimated_usd!=null?100*r.estimated_usd/denominator:null;}}],[denominators,dimension]);
 const share=useTableModel(base.rows,shareColumns);
 const selected=useMemo<UsageRow[]>(()=>share.rows.map(({modelName:_,missing:__,...row})=>row),[share.rows]);
 const groups=useMemo(()=>sortGroups(groupUsage(selected,dimension,groupRange),sort),[selected,dimension,groupRange,sort]);
 const table:TableModel<Leaf>={...base,columns:[...columns,...shareColumns],sort,filters:{...base.filters,...share.filters},active:base.active||share.active||!!sort,
  toggleSort(key){setSort(current=>current?.key!==key?{key,direction:'asc'}:current.direction==='asc'?{key,direction:'desc'}:null);},
  setFilter(key,filter){(key==='share'?share:base).setFilter(key,filter);},options(key){return (key==='share'?share:base).options(key);},reset(){base.reset();share.reset();setSort(null);},rows:share.rows};
 const amountTotals=useMemo(()=>new Map(groupUsage(referenceRows,dimension,groupRange).map(group=>[group.key,group.metrics.estimated_usd??null])),[referenceRows,dimension,groupRange]);
 return {rows:selected,groups,table,amountTotals};
}
