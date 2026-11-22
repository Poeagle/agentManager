import type {AgentCostEstimate,TokenCostBreakdown} from '../types.js';
import {readAgentManagement,type StoredProvider} from '../management-store.js';
import {apiPricingCurrency,estimateProviderApiCost} from '../provider-pricing.js';
import {usdReferenceRateDate,estimateUsageUsd,estimateUsageUsdBreakdown} from './usage-credits.js';

export type CodexPricing={unit:'CNY'|'USD';provider:string;fields:StoredProvider['fields']};
export function codexApiPricing(environment:string|null|undefined):CodexPricing|null{
 if(!environment?.startsWith('provider:'))return null;
 const id=environment.slice('provider:'.length);
 const provider=readAgentManagement('codex').providers.find(entry=>entry.id===id);
 if(!provider)return null;
 const base=provider.fields.baseUrl;
 if(typeof base!=='string'||!base)return null;
 return {unit:apiPricingCurrency(base,provider.fields.models),provider:id,fields:provider.fields};
}
export function codexApiEstimate(pricing:CodexPricing,provider:string|null,model:string|null,tier:string|null,at:string|null,tokens:Record<string,number|null>|null):AgentCostEstimate{
 let breakdown:TokenCostBreakdown|null=null;
 if(tokens&&at&&provider===pricing.provider){
  if(!tier||tier==='default'||tier==='standard'){
   const estimate=estimateProviderApiCost(pricing.fields.baseUrl,pricing.fields,model,at,tokens);
   if(estimate?.unit===pricing.unit)breakdown=estimate.breakdown;
  }
 }
 return {unit:pricing.unit,basis:'api',amount:breakdown?breakdown.input+breakdown.cache+breakdown.output:null,complete:breakdown!==null,...breakdown?{breakdown}:{}};
}

export interface CostTotals {value:number;priced:number;requests:number;gaps:number;input:number;cache:number;output:number;reasoning:number;reasoningMissing:number;unit?:CodexPricing['unit']}
export const emptyCostTotals=():CostTotals=>({value:0,priced:0,requests:0,gaps:0,input:0,cache:0,output:0,reasoning:0,reasoningMissing:0});
export function recordCost(total:CostTotals,model:string|null,tier:string|null,tokens:Record<string,number|null>,api?:AgentCostEstimate){
 const estimate=api?api.amount:estimateUsageUsd(model,tier,tokens);total.requests++;
 if(api)total.unit=api.unit as CodexPricing['unit'];
 if(estimate!==null){total.value+=estimate;const b=api?.breakdown??estimateUsageUsdBreakdown(model,tier,tokens)!;total.input+=b.input;total.cache+=b.cache;total.output+=b.output;if(b.reasoning===null)total.reasoningMissing++;else total.reasoning+=b.reasoning;total.priced++;}
}
export function costDifference(end:CostTotals,start?:CostTotals):CostTotals{return {unit:end.unit,value:Math.max(0,end.value-(start?.value??0)),priced:end.priced-(start?.priced??0),requests:end.requests-(start?.requests??0),gaps:end.gaps-(start?.gaps??0),input:end.input-(start?.input??0),cache:end.cache-(start?.cache??0),output:end.output-(start?.output??0),reasoning:end.reasoning-(start?.reasoning??0),reasoningMissing:end.reasoningMissing-(start?.reasoningMissing??0)};}
export function costSnapshot(total:CostTotals):AgentCostEstimate{return {amount:total.priced?total.value:null,unit:total.unit??'USD',complete:total.requests>0&&total.priced===total.requests&&!total.gaps,...total.unit?{basis:'api'}:{rate_date:usdReferenceRateDate(),basis:'public_usd_reference'},breakdown:total.priced?{input:total.input,cache:total.cache,output:total.output,reasoning:total.reasoningMissing?null:total.reasoning}:undefined};}
