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
