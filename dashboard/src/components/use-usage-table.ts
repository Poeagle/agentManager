import {useMemo,useState} from 'react';
import {useTableModel,type TableColumn,type TableModel} from './table/use-table-model';
import {groupUsage,type Dimension,type Metrics,type UsageGroup,type UsageRow} from './codex-usage-groups';

type Leaf=UsageRow&{modelName:string|null;missing:boolean};
const number=(m:Metrics,key:string)=>m.tokens[key]??null;
const uncached=(m:Metrics)=>{const a=number(m,'input_tokens'),b=number(m,'cached_input_tokens');return a!==null&&b!==null&&b<=a?a-b:null;};
const hit=(m:Metrics)=>{const a=number(m,'input_tokens'),b=number(m,'cached_input_tokens');return a!==null&&a>0&&b!==null&&b<=a?100*b/a:null;};
const totalCredits=(data:Metrics[])=>{const known=data.filter(r=>r.estimated_credits!=null);return known.length?known.reduce((n,r)=>n+r.estimated_credits!,0):null;};
function periodKey(row:UsageRow,dimension:Dimension){const date=row.date;if(dimension==='hour')return row.hour||`${date} unknown`;if(dimension==='month')return date.slice(0,7);if(dimension==='week'){const value=new Date(date+'T00:00:00Z');value.setUTCDate(value.getUTCDate()-(value.getUTCDay()+6)%7);return value.toISOString().slice(0,10);}return dimension==='day'?date:'all';}
const collator=new Intl.Collator('zh-CN',{numeric:true,sensitivity:'base'});
function value(group:UsageGroup,key:string):string|number|null{
 const m=group.metrics;
 switch(key){case 'label':return group.label;case 'cwd':return group.detail||null;case 'input':return number(m,'input_tokens');case 'cached':return number(m,'cached_input_tokens');case 'uncached':return uncached(m);case 'hit':return hit(m);case 'output':return number(m,'output_tokens');case 'total':return number(m,'total_tokens');case 'credits':case 'share':return m.estimated_credits??null;default:return null;}
}
function sortGroups(groups:UsageGroup[],sort:{key:string;direction:'asc'|'desc'}|null):UsageGroup[]{
 const result=groups.map(group=>({...group,children:sortGroups(group.children,sort)}));if(!sort)return result;
 return result.map((group,index)=>({group,index})).sort((a,b)=>{const x=value(a.group,sort.key),y=value(b.group,sort.key);if(x==null)return y==null?a.index-b.index:1;if(y==null)return -1;const n=typeof x==='number'&&typeof y==='number'?x-y:collator.compare(String(x),String(y));return (sort.direction==='asc'?n:-n)||a.index-b.index;}).map(x=>x.group);
}
export function useUsageTable(rows:UsageRow[],dimension:Dimension){
 const [sort,setSort]=useState<{key:string;direction:'asc'|'desc'}|null>(null);
 const leaves=useMemo<Leaf[]>(()=>rows.flatMap<Leaf>(row=>row.models?.length?row.models.map(m=>({...row,...m,modelName:m.model,models:[m],missing:false})): [{...row,modelName:null,missing:true}]),[rows]);
 const columns=useMemo<TableColumn<Leaf>[]>(()=>[
  {key:'label',title:dimension==='project'?'项目 / 模型 / 日期':dimension==='model'?'模型 / 项目 / 日期':`${dimension==='hour'?'小时':dimension==='week'?'周期':dimension==='month'?'月份':'日期'} / 项目 / 模型`,filterMode:'text',value:r=>`${r.date} ${r.hour||''} ${r.project_name||''} ${r.modelName||''}`},
  {key:'cwd',title:'工作目录',filterMode:'text',value:r=>r.cwd},
  {key:'input',title:'输入 Token',kind:'number',filterMode:'range',value:r=>number(r,'input_tokens')},
  {key:'cached',title:'缓存输入',kind:'number',filterMode:'range',value:r=>number(r,'cached_input_tokens')},
  {key:'uncached',title:'非缓存输入',kind:'number',filterMode:'range',value:uncached},
  {key:'hit',title:'缓存命中率',kind:'number',filterMode:'range',value:hit},
  {key:'output',title:'输出 Token',kind:'number',filterMode:'range',value:r=>number(r,'output_tokens')},
  {key:'total',title:'总 Token',kind:'number',filterMode:'range',value:r=>number(r,'total_tokens')},
  {key:'credits',title:'预计 Credits',kind:'number',filterMode:'range',value:r=>r.estimated_credits??null},
 ],[dimension]);
 const base=useTableModel(leaves,columns);
 const denominators=useMemo(()=>{const groups=new Map<string,Leaf[]>();for(const row of base.rows){const key=periodKey(row,dimension);groups.set(key,[...groups.get(key)||[],row]);}return new Map([...groups].map(([key,items])=>[key,totalCredits(items)]));},[base.rows,dimension]);
 const shareColumns=useMemo<TableColumn<Leaf>[]>(()=>[{key:'share',title:'耗用占比',kind:'number',filterMode:'range',value:r=>{const denominator=denominators.get(periodKey(r,dimension));return denominator&&r.estimated_credits!=null?100*r.estimated_credits/denominator:null;}}],[denominators,dimension]);
 const share=useTableModel(base.rows,shareColumns);
 const selected=useMemo<UsageRow[]>(()=>share.rows.map(({modelName:_,missing:__,...row})=>row),[share.rows]);
 const groups=useMemo(()=>sortGroups(groupUsage(selected,dimension),sort),[selected,dimension,sort]);
 const table:TableModel<Leaf>={...base,columns:[...columns,...shareColumns],sort,filters:{...base.filters,...share.filters},active:base.active||share.active||!!sort,
  toggleSort(key){setSort(current=>current?.key!==key?{key,direction:'asc'}:current.direction==='asc'?{key,direction:'desc'}:null);},
  setFilter(key,filter){(key==='share'?share:base).setFilter(key,filter);},options(key){return (key==='share'?share:base).options(key);},reset(){base.reset();share.reset();setSort(null);},rows:share.rows};
 return {rows:selected,groups,table};
}
