import {describe,it,expect} from 'vitest';
import {allocateQuota,type QuotaEvent,type QuotaSample} from '../src/services/agents/codex/quota-allocation.js';
const sample=(minute:number,used:number,extra:Partial<QuotaSample>={}):QuotaSample=>({checked_at:`2026-01-01T00:${String(minute).padStart(2,'0')}:00.000Z`,used,reset_at:Date.parse('2026-01-08T00:00:00Z')/1000,email:'a@example.invalid',...extra});
const event=(minute:number,cwd:string,input:number,model='gpt-6.1-sol'):QuotaEvent=>({at:`2026-01-01T00:${String(minute).padStart(2,'0')}:00.000Z`,day:'2026-01-01',hour:'2026-01-01T00:00:00+00:00',cwd,model,tier:null,tokens:JSON.stringify({input_tokens:input,cached_input_tokens:0,output_tokens:0})});
const key=(cwd:string)=>JSON.stringify(['2026-01-01','2026-01-01T00:00:00+00:00',cwd,'gpt-6.1-sol']);
describe('observed quota allocation',()=>{
 it('allocates an observed change proportionally to credits in its interval',()=>{
  const result=allocateQuota([sample(0,10),sample(5,12)],[event(1,'a',100),event(2,'b',300)],sample(6,0).checked_at);
  expect(result.get(key('a'))).toBeCloseTo(.5);expect(result.get(key('b'))).toBeCloseTo(1.5);
 });
 it('does not attribute gaps, resets, unknown rates or uncollected events',()=>{
  const events=[event(1,'a',100)];
  expect(allocateQuota([sample(0,1),sample(20,2)],events,sample(21,0).checked_at).size).toBe(0);
  expect(allocateQuota([sample(0,1),sample(5,2,{reset_at:1})],events,sample(6,0).checked_at).size).toBe(0);
  expect(allocateQuota([sample(0,1),sample(5,2)],[...events,event(2,'b',10,'unknown')],sample(6,0).checked_at).size).toBe(0);
  expect(allocateQuota([sample(0,1),sample(5,2)],events,sample(4,0).checked_at).size).toBe(0);
  expect(allocateQuota([sample(0,1),sample(5,1)],events,sample(6,0).checked_at).size).toBe(0);
 });
});
