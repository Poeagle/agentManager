import {usageDateRange,usageRangeLabel,type UsageDateRange} from './usage-date-range';
import type {ConversationCostEstimate} from '../lib/api';
type Breakdown=NonNullable<ConversationCostEstimate['breakdown']>;
export type ApiCost={amount:number|null;coverage:{covered:number;total:number};breakdown?:Breakdown};
export type Metrics={tokens:Record<string,number|null>;estimated_credits?:number|null;estimated_usd?:number|null;usd_coverage?:{covered:number;total:number}|null;usd_breakdown?:Breakdown;actual_quota?:number|null;usd_per_quota_point?:number;credit_coverage?:{covered:number;total:number}|null;cost_breakdown?:Breakdown;api_cost?:ApiCost};
export type ModelUsage=Metrics&{model:string|null};
export type UsageRow=Metrics&{date:string;hour?:string|null;cwd:string;project_name?:string;models?:ModelUsage[]};
export type Dimension='hour'|'day'|'week'|'month'|'total'|'project'|'model';
export const dimensionLabels:Record<Dimension,string>={hour:'小时',day:'日',week:'周',month:'月',total:'总量',project:'项目',model:'模型'};
export type UsageGroup={key:string;label:string;title?:string;detail?:string;kind:'date'|'project'|'model';metrics:Metrics;children:UsageGroup[];missingModels:boolean};
type Leaf={date:string;hour?:string|null;cwd:string;project:string;model:string|null;missing:boolean;metrics:Metrics};
function aggregateBreakdown<T>(priced:T[],read:(value:T)=>Breakdown|undefined):Breakdown|undefined{
 if(!priced.length)return undefined;
 const sum:Breakdown={input:0,cache:0,output:0,reasoning:0};
 for(const row of priced){
  const b=read(row);if(!b)return undefined;
  sum.input+=b.input;sum.cache+=b.cache;sum.output+=b.output;
  sum.reasoning=sum.reasoning===null||b.reasoning===null?null:sum.reasoning+b.reasoning;
 }
 return sum;
}
export function aggregateMetrics(rows:Metrics[]):Metrics{
 const fields=new Set(rows.flatMap(r=>Object.keys(r.tokens)));
 const tokens=Object.fromEntries([...fields].map(k=>[k,rows.some(r=>r.tokens[k]==null)?null:rows.reduce((n,r)=>n+r.tokens[k]!,0)]));
 const known=rows.filter(r=>r.estimated_credits!=null);
 const cost_breakdown=aggregateBreakdown(known,r=>r.cost_breakdown);
 const usdRows=rows.filter(r=>r.estimated_usd!=null);
 const positiveUsdRows=usdRows.filter(r=>r.estimated_usd!>0);
 const rate=positiveUsdRows[0]?.usd_per_quota_point;
 const commonRate=rate!==undefined&&positiveUsdRows.every(r=>r.usd_per_quota_point===rate);
 const usd_breakdown=aggregateBreakdown(usdRows,r=>r.usd_breakdown);
 const api_cost=rows.reduce<ApiCost|undefined>((cost,row)=>{
  if(!row.api_cost)return cost;
  const {amount,coverage}=row.api_cost;
  if(!cost)return {amount,coverage:{...coverage}};
  if(amount!==null)cost.amount=(cost.amount??0)+amount;
  cost.coverage.covered+=coverage.covered;
  cost.coverage.total+=coverage.total;
  return cost;
 },undefined);
 if(api_cost)api_cost.breakdown=aggregateBreakdown(rows.filter(r=>r.api_cost?.amount!=null),r=>r.api_cost?.breakdown);
 return {tokens,actual_quota:rows.some(r=>r.actual_quota!=null)?rows.reduce((n,r)=>n+(r.actual_quota??0),0):null,...commonRate?{usd_per_quota_point:rate}:{},estimated_credits:known.length?known.reduce((n,r)=>n+r.estimated_credits!,0):null,credit_coverage:{covered:rows.reduce((n,r)=>n+(r.credit_coverage?.covered??(r.estimated_credits!=null?1:0)),0),total:rows.reduce((n,r)=>n+(r.credit_coverage?.total??1),0)},estimated_usd:usdRows.length?usdRows.reduce((n,r)=>n+r.estimated_usd!,0):null,usd_coverage:{covered:rows.reduce((n,r)=>n+(r.usd_coverage?.covered??(r.estimated_usd!=null?1:0)),0),total:rows.reduce((n,r)=>n+(r.usd_coverage?.total??1),0)},...usd_breakdown?{usd_breakdown}:{},...cost_breakdown?{cost_breakdown}:{},...api_cost?{api_cost}:{}};
}
/** Keep counters and denominators consistent with the records visible in the UI. */
export function estimatableUsageRows(rows:UsageRow[]):UsageRow[]{
 return rows.flatMap(row=>{
  if(!row.models?.length)return row.estimated_credits!=null?[row]:[];
  const models=row.models.filter(model=>model.estimated_credits!=null);
  return models.length?[{...row,...aggregateMetrics(models),models}]:[];
 });
}
function period(date:string,dimension:Dimension){
 if(dimension==='month')return date.slice(0,7);
 if(dimension!=='week')return date;
 const start=new Date(date+'T00:00:00Z');start.setUTCDate(start.getUTCDate()-(start.getUTCDay()+6)%7);
 const end=new Date(start);end.setUTCDate(end.getUTCDate()+6);
 return `${start.toISOString().slice(0,10)} ~ ${end.toISOString().slice(0,10)}`;
}
/** Dates already belong to the report's local timezone. UTC arithmetic above
 * only walks date labels without DST shifts. Each counter contributes once. */
export function groupUsage(rows:UsageRow[],dimension:Dimension,range?:UsageDateRange):UsageGroup[]{
 const totalLabel=dimension==='total'?usageRangeLabel(range??usageDateRange('','','total',rows.map(row=>row.date))):'';
 const leaves:Leaf[]=rows.flatMap(row=>(row.models?.length?row.models:[{...row,model:null}]).map(model=>({date:row.date,hour:row.hour,cwd:row.cwd,project:row.project_name||row.cwd.split('/').filter(Boolean).pop()||'Unassigned',model:model.model,missing:!row.models?.length,metrics:model})));
 const order:('date'|'project'|'model')[]=dimension==='project'?['project','model','date']:dimension==='model'?['model','project','date']:['date','project','model'];
 function build(items:Leaf[],depth:number,parent:string):UsageGroup[]{
  if(depth===order.length)return [];
  const kind=order[depth],groups=new Map<string,Leaf[]>();
  for(const item of items){const id=kind==='project'?item.cwd:kind==='model'?JSON.stringify([item.model,item.missing]):depth===0&&dimension==='total'?'all':depth===0&&dimension==='hour'?(item.hour?item.hour.replace('T',' ').replace(':00:00Z',':00 UTC').replace(/:00:00([+-])/,':00 UTC$1'):`${item.date} time unknown`):period(item.date,depth===0?dimension:'day');const group=groups.get(id)||[];group.push(item);groups.set(id,group);}
  return [...groups].map(([id,group])=>{const first=group[0],key=JSON.stringify([parent,kind,id]);return {key,kind,label:depth===0&&dimension==='total'?totalLabel:kind==='project'?first.project:kind==='model'?(first.missing?'Model details unavailable':first.model||'Model not recorded'):kind==='date'&&depth===0&&dimension==='hour'?id.replace(/ UTC(?:[+-]\d{2}:\d{2})?$/,''):id,title:kind==='date'&&depth===0&&dimension==='hour'?id:undefined,detail:kind==='project'?(first.cwd||'Working directory unavailable'):undefined,metrics:aggregateMetrics(group.map(g=>g.metrics)),children:build(group,depth+1,key),missingModels:group.some(g=>g.missing)};}).sort((a,b)=>kind==='date'?b.label.localeCompare(a.label):(b.metrics.tokens.total_tokens??0)-(a.metrics.tokens.total_tokens??0)||a.label.localeCompare(b.label));
 }
 return build(leaves,0,dimension);
}
