/** Current-rate equivalent, not an invoice or historical price reconstruction.
 * Source: https://learn.chatgpt.com/docs/pricing (verified 2026-11-18).
 * Values are credits per million uncached input / cached input / output. */
export const CREDIT_RATE_DATE='2026-11-18';
export const CREDIT_RATES:Record<string,readonly [number,number,number]>={
 'gpt-6.2-astra':[200,10,1000],
 'gpt-6.2-sol':[50,2.5,250],
 'gpt-6-astra':[250,25,1250],
 'gpt-6.1-sol':[50,2.5,250],
 'gpt-6.1-terra':[25,1.25,125],
 'gpt-6-sol':[50,5,250],
 'gpt-6-luna':[2.5,0.25,12.5],
 'gpt-5.6-sol':[100,10,500],
 'gpt-5.6-terra':[50,5,300],
 'gpt-5.6-luna':[5,0.5,30],
};
export type UsageEstimateBasis='credits'|'subscription';
// The promotion ends at midnight Pacific time, not UTC. Estimates always use
// the current rate, including for archived tokens; event dates are not prices.
const ULTRAFAST_PROMOTION_END=Date.parse('2027-03-01T00:00:00-08:00');
function speedMultiplier(model:string,tier:string|null,basis:UsageEstimateBasis):number|null{
 const is62=model==='gpt-6.2-astra'||model==='gpt-6.2-sol';
 if(!tier||tier==='default'||tier==='standard')return 1;
 if(tier==='fast'||tier==='priority')return basis==='subscription'&&!is62?2.5:2;
 if(tier==='ultrafast'){
  if(is62){
   if(basis==='subscription')return 6;
   return Date.now()<ULTRAFAST_PROMOTION_END?3:6;
  }
  if(model==='gpt-6-astra'||model==='gpt-6.1-sol')return basis==='subscription'?8:6;
 }
 return null;
}
export function estimateUsageCredits(model:string|null,tier:string|null,tokens:Record<string,number|null>,basis:UsageEstimateBasis='credits'):number|null{
 const rate=model&&Object.hasOwn(CREDIT_RATES,model)?CREDIT_RATES[model]:null;
 const input=tokens.input_tokens,cached=tokens.cached_input_tokens,output=tokens.output_tokens;
 if(!rate||[input,cached,output].some(v=>typeof v!=='number'||!Number.isFinite(v)||v<0)||cached!>input!)return null;
 const multiplier=speedMultiplier(model!,tier,basis);
 return multiplier===null?null:((input!-cached!)*rate[0]+cached!*rate[1]+output!*rate[2])*multiplier/1e6;
}

export function estimateUsageBreakdown(model:string|null,tier:string|null,tokens:Record<string,number|null>,basis:UsageEstimateBasis='credits') {
 const total=estimateUsageCredits(model,tier,tokens,basis);
 if(total===null||!model)return null;
 const rate=CREDIT_RATES[model], multiplier=speedMultiplier(model,tier,basis)!/1e6;
 const reasoning=tokens.reasoning_output_tokens;
 return {input:(tokens.input_tokens!-tokens.cached_input_tokens!)*rate[0]*multiplier,cache:tokens.cached_input_tokens!*rate[1]*multiplier,output:tokens.output_tokens!*rate[2]*multiplier,reasoning:typeof reasoning==='number'&&Number.isFinite(reasoning)&&reasoning>=0&&reasoning<=tokens.output_tokens!?reasoning*rate[2]*multiplier:null};
}
