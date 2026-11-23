import type {ReactNode} from 'react';
import {useQuery} from '@tanstack/react-query';
import {api,type AgentModelMetadata,type AgentModelPricing} from '../lib/api';
import {DataTable} from './table/DataTable';
import {useTableModel} from './table/use-table-model';

type ModelRow=AgentModelMetadata&{vendor:string;model:string;providers:string[]};
type RateKey='input'|'output'|'cached';

function amount(value:number,currency:string){
 if(currency==='USD')return '$'+value;
 if(currency==='CNY')return '¥'+value;
 return `${value} ${currency}`;
}

function inputRule(label:string|undefined){
 if(!label)return '';
 const chinese=label.match(/^([≤≥<>])\s*(\S+)\s+输入\s*Token$/i);
 if(chinese)return `输入 ${chinese[1]}${chinese[2]}`;
 const english=label.match(/^(?:for\s+)?prompts?\s+(up to|over|above|greater than|more than)\s+([\d,]+)\s+tokens?$/i);
 if(!english)return label;
 const threshold=Number(english[2].replaceAll(',',''));
 const count=threshold%1000===0?`${threshold/1000}K`:String(threshold);
 return `输入 ${english[1].toLowerCase()==='up to'?'≤':'>'}${count}`;
}

function priceLines(pricing:AgentModelPricing|undefined,key:RateKey,credits:ModelRow['reference_credits']){
 if(!pricing){
  const rate=credits?.[key];
  return rate==null?[]:[{amount:amount(rate,'Credits'),rule:''}];
 }
 if(pricing.peak&&pricing.off_peak){
  return [
   {value:pricing.peak[key],rule:'高峰'},
   {value:pricing.off_peak[key],rule:'空闲'},
  ].flatMap(({value,rule})=>value==null?[]:[{amount:amount(value,pricing.currency),rule}]);
 }
 return pricing.bands?.flatMap(band=>{
  const value=band.rates[key];
  return value==null?[]:[{amount:amount(value,pricing.currency),rule:inputRule(band.label)}];
 })??[];
}

const missing=<span aria-label="未提供" title="未提供">—</span>;
const rateColumns=[
 {key:'input',title:'未缓存输入'},
 {key:'output',title:'输出'},
 {key:'cached',title:'缓存命中'},
] as const;
const rateUnit='每百万 Token';
const columns=[
 {key:'vendor',title:'厂商',value:(row:ModelRow)=>row.vendor},
 {key:'model',title:'模型',value:(row:ModelRow)=>row.model},
 {key:'released',title:'发布日期',value:(row:ModelRow)=>row.release_date,kind:'date'},
 {key:'context',title:'上下文',value:(row:ModelRow)=>row.official_context_window??row.context_window,kind:'number'},
 ...rateColumns.map(({key,title})=>({
  key,title,description:`${title}费率（${rateUnit}）`,
  value:(row:ModelRow)=>priceLines(row.api_pricing,key,row.reference_credits).map(line=>[line.rule,line.amount].filter(Boolean).join(' ')).join(' · ')||null,
 })),
] as const;

export function AgentModelInformation({active=true,navigation}:{active?:boolean;navigation?:ReactNode}){
 const query=useQuery({queryKey:['agent-model-catalog'],queryFn:api.agentManagement.modelCatalog,enabled:active,refetchInterval:active?30*60*1000:false});
 const table=useTableModel(query.data?.models??[],columns);
 return <>
  <div className="agent-management-navigation">
   {navigation}
   {active&&<div className="agent-model-information-toolbar">
    <div className="agent-model-information-summary">
     <span aria-live="polite">{table.rows.length} 个模型</span>
     <span>费率 / 百万 Token</span>
    </div>
    <button type="button" className="agent-management-button" onClick={()=>void query.refetch()} disabled={query.isFetching}>
     {query.isFetching?'更新中…':'更新资料'}
    </button>
   </div>}
  </div>
  {active&&<section className="agent-model-information" aria-label="模型资料">
   <DataTable label="模型资料" model={table} fitWidth className="agent-model-information-table"
    loading={query.isPending} error={query.isError?query.error.message:undefined} onRetry={()=>void query.refetch()}
    empty={!table.rows.length} emptyMessage="暂无模型资料">
    {table.rows.map(row=>{
     const context=row.official_context_window??row.context_window;
     return <tr key={`${row.vendor}:${row.model}`}>
      <td>{row.vendor}</td>
      <td title={row.providers.length?row.providers.join('、'):'官方模型资料'}><code>{row.model}</code></td>
      <td>{row.release_date||missing}</td>
      <td>{context==null?missing:context.toLocaleString('en-US')}</td>
      {rateColumns.map(({key})=>{
       const rates=priceLines(row.api_pricing,key,row.reference_credits);
       return <td key={key}>
        {rates.length?rates.map((rate,index)=><div className="agent-model-price-line" key={index}>
         <span>{rate.amount}</span>
         {rate.rule&&<small>{rate.rule}</small>}
        </div>):missing}
       </td>;
      })}
     </tr>;
    })}
   </DataTable>
  </section>}
 </>;
}
