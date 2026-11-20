import type {AgentCostEstimate} from '../types.js';
import {CREDIT_RATE_DATE,estimateUsageCredits,estimateUsageBreakdown} from './usage-credits.js';

export interface CostTotals {value:number;priced:number;requests:number;gaps:number;input:number;cache:number;output:number;reasoning:number;reasoningMissing:number}
export const emptyCostTotals=():CostTotals=>({value:0,priced:0,requests:0,gaps:0,input:0,cache:0,output:0,reasoning:0,reasoningMissing:0});
export function recordCost(total:CostTotals,model:string|null,tier:string|null,tokens:Record<string,number|null>){
 const estimate=estimateUsageCredits(model,tier,tokens,'subscription');total.requests++;
 if(estimate!==null){total.value+=estimate;const b=estimateUsageBreakdown(model,tier,tokens,'subscription')!;total.input+=b.input;total.cache+=b.cache;total.output+=b.output;if(b.reasoning===null)total.reasoningMissing++;else total.reasoning+=b.reasoning;total.priced++;}
}
export function costDifference(end:CostTotals,start?:CostTotals):CostTotals{return {value:Math.max(0,end.value-(start?.value??0)),priced:end.priced-(start?.priced??0),requests:end.requests-(start?.requests??0),gaps:end.gaps-(start?.gaps??0),input:end.input-(start?.input??0),cache:end.cache-(start?.cache??0),output:end.output-(start?.output??0),reasoning:end.reasoning-(start?.reasoning??0),reasoningMissing:end.reasoningMissing-(start?.reasoningMissing??0)};}
export function costSnapshot(total:CostTotals):AgentCostEstimate{return {amount:total.priced?total.value:null,unit:'credits',complete:total.requests>0&&total.priced===total.requests&&!total.gaps,rate_date:CREDIT_RATE_DATE,basis:'subscription',breakdown:total.priced?{input:total.input,cache:total.cache,output:total.output,reasoning:total.reasoningMissing?null:total.reasoning}:undefined};}
