/** Current-rate equivalent, not an invoice or historical price reconstruction.
 * Source: https://learn.chatgpt.com/docs/pricing (verified 2026-11-11).
 * Values are credits per million uncached input / cached input / output. */
export const CREDIT_RATE_DATE='2026-11-11';
export const CREDIT_RATES:Record<string,readonly [number,number,number]>={
 'gpt-6-astra':[250,25,1250],
 'gpt-6.1-sol':[50,2.5,250],
 'gpt-6.1-terra':[25,1.25,125],
 'gpt-6-sol':[50,5,250],
 'gpt-6-luna':[2.5,0.25,12.5],
 'gpt-5.6-sol':[100,10,500],
 'gpt-5.6-terra':[50,5,300],
 'gpt-5.6-luna':[5,0.5,30],
};
export function estimateUsageCredits(model:string|null,tier:string|null,tokens:Record<string,number|null>):number|null{
 const rate=model?CREDIT_RATES[model]:null;
 const input=tokens.input_tokens,cached=tokens.cached_input_tokens,output=tokens.output_tokens;
 if(!rate||[input,cached,output].some(v=>typeof v!=='number'||!Number.isFinite(v)||v<0)||cached!>input!)return null;
 const multiplier=tier==='fast'||tier==='priority'?2:tier==='ultrafast'?6:!tier||tier==='default'||tier==='standard'?1:null;
 return multiplier===null?null:((input!-cached!)*rate[0]+cached!*rate[1]+output!*rate[2])*multiplier/1e6;
}
