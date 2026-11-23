import {expect,it} from 'vitest';
import {DEFAULT_SEND_GUARD,evaluateSendGuard,validateSendGuard} from '../src/services/send-guard-policy.js';
const evaluate=(context_percent:number|null,idle_minutes:number|null)=>evaluateSendGuard(DEFAULT_SEND_GUARD.conditions,{context_percent,idle_minutes,context_tokens:null});
it.each([
 [80,0], [30,30], [50,20], [60,10], [20,60],
])('matches when occupancy %s and idle %s reach a default branch', (percent,minutes)=>{
 expect(evaluate(percent,minutes)).toBe(true);
 expect(evaluate(percent-1,minutes)).toBe(false);
 if(minutes>0)expect(evaluate(percent,minutes-1)).toBe(false);
});
it('retains unknown telemetry and can match occupancy independently of idle time',()=>{
 expect(evaluate(80,null)).toBe(true);
 expect(evaluate(60,null)).toBe(null);
 expect(evaluate(19,null)).toBe(false);
 expect(evaluate(null,null)).toBe(null);
});
it('validates bounded groups and numeric limits',()=>{
 expect(()=>validateSendGuard(DEFAULT_SEND_GUARD)).not.toThrow();
 for(const value of [null,{}, {...DEFAULT_SEND_GUARD,enabled:'true'}, {...DEFAULT_SEND_GUARD,conditions:{operator:'xor',conditions:[]}}, {...DEFAULT_SEND_GUARD,conditions:{operator:'and',conditions:[{type:'context_percent',value:101}]}}, {...DEFAULT_SEND_GUARD,conditions:{operator:'or',conditions:Array(21).fill({type:'idle_minutes',value:30})}}])expect(()=>validateSendGuard(value)).toThrow();
 let group:any={operator:'and',conditions:[{type:'idle_minutes',value:1}]};for(let i=0;i<4;i++)group={operator:'or',conditions:[group]};expect(()=>validateSendGuard({enabled:true,conditions:group})).toThrow();
});

it('validates automatic targets and treats unavailable quota as unknown',()=>{
 const conditions={operator:'and' as const,conditions:[{type:'account_remaining_percent' as const,value:0}]};
 const values={context_percent:80,context_tokens:800,idle_minutes:10};
 expect(evaluateSendGuard(conditions,values)).toBeNull();
 expect(evaluateSendGuard(conditions,{...values,account_remaining_percent:0.4})).toBe(false);
 expect(evaluateSendGuard(conditions,{...values,account_remaining_percent:0})).toBe(true);
 const rule={action:'brief',target:'available_account',conditions};
 expect(()=>validateSendGuard({...DEFAULT_SEND_GUARD,automatic_rules:[rule]})).not.toThrow();
 for(const invalid of [{...rule,action:'compact'},{...rule,action:'constructor'},{...rule,target:'arbitrary'},{...rule,conditions:{...conditions,conditions:[{type:'account_remaining_percent',value:-1}]}}]){
  expect(()=>validateSendGuard({...DEFAULT_SEND_GUARD,automatic_rules:[invalid]})).toThrow();
 }
 expect(()=>validateSendGuard({...DEFAULT_SEND_GUARD,automatic_rules:Array(9).fill(rule)})).toThrow();
});

it('requires an explicit nonempty list of unique Provider IDs when narrowing a rule',()=>{
 const rule={action:'remind',conditions:DEFAULT_SEND_GUARD.conditions};
 expect(()=>validateSendGuard({enabled:true,rules:[rule,{...rule,provider_ids:['codex:native','claude:anthropic']}]})).not.toThrow();
 for(const provider_ids of [[],['codex:native','codex:native'],['missing-agent-prefix'],[null]]){
  expect(()=>validateSendGuard({enabled:true,rules:[{...rule,provider_ids}]})).toThrow();
 }
 expect(()=>validateSendGuard({enabled:true,rules:[{...rule,target:'available_account'}]})).toThrow();
 expect(()=>validateSendGuard({...DEFAULT_SEND_GUARD,rules:[rule]})).toThrow();
});
