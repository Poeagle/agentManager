import {expect,it} from 'vitest';
import {DEFAULT_SEND_GUARD,evaluateSendGuard,validateSendGuard} from '../src/services/send-guard-policy.js';
it('evaluates inclusive thresholds and nested AND/OR without treating unknown as zero',()=>{
 const evaluate=(context_percent:number|null,idle_minutes:number|null)=>evaluateSendGuard(DEFAULT_SEND_GUARD.conditions,{context_percent,idle_minutes,context_tokens:null});
 expect(evaluate(80,0)).toBe(true);expect(evaluate(79,29)).toBe(false);expect(evaluate(50,30)).toBe(true);expect(evaluate(49,100)).toBe(false);expect(evaluate(90,null)).toBe(true);expect(evaluate(50,null)).toBe(null);expect(evaluate(null,null)).toBe(null);
});
it('validates bounded groups and numeric limits',()=>{
 expect(()=>validateSendGuard(DEFAULT_SEND_GUARD)).not.toThrow();
 for(const value of [null,{}, {...DEFAULT_SEND_GUARD,enabled:'true'}, {...DEFAULT_SEND_GUARD,conditions:{operator:'xor',conditions:[]}}, {...DEFAULT_SEND_GUARD,conditions:{operator:'and',conditions:[{type:'context_percent',value:101}]}}, {...DEFAULT_SEND_GUARD,conditions:{operator:'or',conditions:Array(21).fill({type:'idle_minutes',value:30})}}])expect(()=>validateSendGuard(value)).toThrow();
 let group:any={operator:'and',conditions:[{type:'idle_minutes',value:1}]};for(let i=0;i<4;i++)group={operator:'or',conditions:[group]};expect(()=>validateSendGuard({enabled:true,conditions:group})).toThrow();
});
