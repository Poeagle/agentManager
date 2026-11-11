export type Metrics={tokens:Record<string,number|null>;estimated_credits?:number|null;credit_coverage?:{covered:number;total:number}|null};
export type ModelUsage=Metrics&{model:string|null};
export type UsageRow=Metrics&{date:string;cwd:string;project_name?:string;models?:ModelUsage[]};
export type Dimension='day'|'week'|'month'|'project'|'model';
export const dimensionLabels:Record<Dimension,string>={day:'日',week:'周',month:'月',project:'项目',model:'模型'};
export type UsageGroup={key:string;label:string;detail?:string;kind:'date'|'project'|'model';metrics:Metrics;children:UsageGroup[];missingModels:boolean};
type Leaf={date:string;cwd:string;project:string;model:string|null;missing:boolean;metrics:Metrics};
export function aggregateMetrics(rows:Metrics[]):Metrics{
 const fields=new Set(rows.flatMap(r=>Object.keys(r.tokens)));
 const tokens=Object.fromEntries([...fields].map(k=>[k,rows.some(r=>r.tokens[k]==null)?null:rows.reduce((n,r)=>n+r.tokens[k]!,0)]));
 const known=rows.filter(r=>r.estimated_credits!=null);
 return {tokens,estimated_credits:known.length?known.reduce((n,r)=>n+r.estimated_credits!,0):null,credit_coverage:{covered:rows.reduce((n,r)=>n+(r.credit_coverage?.covered??(r.estimated_credits!=null?1:0)),0),total:rows.reduce((n,r)=>n+(r.credit_coverage?.total??1),0)}};
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
/** Each source counter contributes once to each ancestor. Period boundaries use
 * UTC; project identity is the full cwd, never the potentially duplicate name. */
export function groupUsage(rows:UsageRow[],dimension:Dimension):UsageGroup[]{
 const leaves:Leaf[]=rows.flatMap(row=>(row.models?.length?row.models:[{...row,model:null}]).map(model=>({date:row.date,cwd:row.cwd,project:row.project_name||row.cwd.split('/').filter(Boolean).pop()||'未归属',model:model.model,missing:!row.models?.length,metrics:model})));
 const order:('date'|'project'|'model')[]=dimension==='project'?['project','model','date']:dimension==='model'?['model','project','date']:['date','project','model'];
 function build(items:Leaf[],depth:number,parent:string):UsageGroup[]{
  if(depth===order.length)return [];
  const kind=order[depth],groups=new Map<string,Leaf[]>();
  for(const item of items){const id=kind==='project'?item.cwd:kind==='model'?JSON.stringify([item.model,item.missing]):period(item.date,depth===0?dimension:'day');const group=groups.get(id)||[];group.push(item);groups.set(id,group);}
  return [...groups].map(([id,group])=>{const first=group[0],key=JSON.stringify([parent,kind,id]);return {key,kind,label:kind==='project'?first.project:kind==='model'?(first.missing?'模型明细未返回':first.model||'模型未记录'):id,detail:kind==='project'?(first.cwd||'原始记录未提供工作目录'):undefined,metrics:aggregateMetrics(group.map(g=>g.metrics)),children:build(group,depth+1,key),missingModels:group.some(g=>g.missing)};}).sort((a,b)=>kind==='date'?b.label.localeCompare(a.label):(b.metrics.tokens.total_tokens??0)-(a.metrics.tokens.total_tokens??0)||a.label.localeCompare(b.label));
 }
 return build(leaves,0,dimension);
}
