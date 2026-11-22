import {useQuery} from '@tanstack/react-query';
import type {AgentModelMetadata,AgentModelPricing} from '../lib/api';
import {api} from '../lib/api';
import {DataTable} from './table/DataTable';
import {useTableModel} from './table/use-table-model';

type ModelRow=AgentModelMetadata&{vendor:string;model:string;providers:string[]};

function amount(value:number,currency:string){
 return `${currency} ${value.toFixed(2)}`;
}

function pricingValues(pricing:AgentModelPricing|undefined,key:'input'|'output'|'cached',credits?:ModelRow['reference_credits']){
 if(!pricing){
  const creditRate=credits?.[key];
  return creditRate==null?'未提供':`Credits ${creditRate.toFixed(2)}`;
 }
 if(pricing.peak&&pricing.off_peak){
  const rates=[pricing.peak[key],pricing.off_peak[key]];
  if(rates.some(value=>value==null))return '未提供';
  return `高峰 ${amount(rates[0]!,pricing.currency)} · 空闲 ${amount(rates[1]!,pricing.currency)}`;
 }
 const bands=pricing.bands?.flatMap(band=>{
  const value=band.rates[key];
  if(value==null)return [];
  return [`${band.label?`${band.label} `:''}${amount(value,pricing.currency)}`];
 })??[];
 return bands.length?bands.join(' · '):'未提供';
}

function releaseDate(row:ModelRow){return row.release_date||'未提供';}
export function AgentModelInformation({active=true}:{active?:boolean}){
 const query=useQuery({queryKey:['agent-model-catalog'],queryFn:api.agentManagement.modelCatalog,enabled:active,refetchInterval:30*60*1000});
 const rows=query.data?.models??[];
 const table=useTableModel(rows,[
  {key:'vendor',title:'厂商',value:row=>row.vendor},
  {key:'model',title:'模型名称',value:row=>row.model},
  {key:'released',title:'发布时间',value:releaseDate,kind:'date'},
  {key:'context',title:'上下文窗口',value:row=>row.official_context_window??row.context_window,kind:'number',format:value=>typeof value==='number'?value.toLocaleString('en-US'):value==null?'未提供':String(value)},
  {key:'input',title:'未缓存输入 / 百万 Token',value:row=>pricingValues(row.api_pricing,'input',row.reference_credits)},
  {key:'output',title:'输出 / 百万 Token',value:row=>pricingValues(row.api_pricing,'output',row.reference_credits)},
  {key:'cached',title:'缓存命中输入 / 百万 Token',value:row=>pricingValues(row.api_pricing,'cached',row.reference_credits)},
 ]);
 return <section className="agent-model-information" aria-label="模型资料">
  <div className="agent-provider-toolbar"><span aria-live="polite">{table.rows.length} 个模型</span>
   <button type="button" className="agent-management-button" onClick={()=>void query.refetch()} disabled={query.isFetching}>
    {query.isFetching?'更新中…':'更新资料'}
   </button>
  </div>
  <DataTable label="模型资料" model={table} minWidth={1040} className="agent-model-information-table"
   loading={query.isPending} error={query.isError?query.error.message:undefined} onRetry={()=>void query.refetch()}
   empty={!table.rows.length} emptyMessage="当前 Provider 尚未配置模型">
   {table.rows.map(row=><tr key={`${row.vendor}:${row.model}`}>
    <td>{row.vendor}</td>
    <td title={row.providers.join('、')}><code>{row.model}</code></td>
    <td>{releaseDate(row)}</td>
    <td>{row.official_context_window??row.context_window?Number(row.official_context_window??row.context_window).toLocaleString('en-US'):'未提供'}</td>
    <td>{pricingValues(row.api_pricing,'input',row.reference_credits)}</td>
    <td>{pricingValues(row.api_pricing,'output',row.reference_credits)}</td>
    <td>{pricingValues(row.api_pricing,'cached',row.reference_credits)}</td>
   </tr>)}
  </DataTable>
 </section>;
}
