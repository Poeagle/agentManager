import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {estimateUsageCredits} from '../src/services/agents/codex/usage-credits.js';
describe('current-rate Codex credit equivalents',()=>{
 const tokens={input_tokens:1000000,cached_input_tokens:600000,output_tokens:100000,reasoning_output_tokens:50000};
 beforeEach(()=>{vi.spyOn(Date,'now').mockReturnValue(Date.parse('2026-11-18T00:00:00Z'));});
 afterEach(()=>vi.restoreAllMocks());
 it.each([
  ['gpt-6.2-sol',50,2.5,250],['gpt-6.2-astra',200,10,1000],
 ] as const)('prices uncached input, cache hits and output separately for %s', (model,input,cached,output)=>{
  expect(estimateUsageCredits(model,'standard',{input_tokens:1000000,cached_input_tokens:0,output_tokens:0})).toBe(input);
  expect(estimateUsageCredits(model,'default',{input_tokens:1000000,cached_input_tokens:1000000,output_tokens:0})).toBe(cached);
  expect(estimateUsageCredits(model,null,{input_tokens:0,cached_input_tokens:0,output_tokens:1000000,reasoning_output_tokens:500000})).toBe(output);
 });
 it.each([['gpt-6.2-sol',46.5],['gpt-6.2-astra',186]] as const)('uses model-specific subscription and purchased-credit speeds for %s',(model,standard)=>{
  for(const basis of ['subscription','credits'] as const){
   expect(estimateUsageCredits(model,null,tokens,basis)).toBe(standard);
   expect(estimateUsageCredits(model,'fast',tokens,basis)).toBe(standard*2);
   expect(estimateUsageCredits(model,'priority',tokens,basis)).toBe(standard*2);
   expect(estimateUsageCredits(model,'ultrafast',tokens,basis)).toBe(standard*(basis==='subscription'?6:3));
  }
 });
 it.each(['gpt-6.2-sol','gpt-6.2-astra'])('ends the %s purchased-credit promotion at Pacific midnight while subscription stays at 6x',model=>{
  const standard=estimateUsageCredits(model,'standard',tokens)!;
  for(const [at,multiplier] of [['2027-03-01T00:00:00Z',3],['2027-03-01T07:59:59.999Z',3],['2027-03-01T08:00:00Z',6]] as const){
   vi.mocked(Date.now).mockReturnValue(Date.parse(at));
   expect(estimateUsageCredits(model,'ultrafast',tokens)).toBe(standard*multiplier);
   expect(estimateUsageCredits(model,'ultrafast',tokens,'subscription')).toBe(standard*6);
  }
 });
 it('subtracts cached inputs, includes reasoning only through outputs, and applies speed multipliers',()=>{
  expect(estimateUsageCredits('gpt-6.1-sol',null,tokens)).toBe(46.5);
  expect(estimateUsageCredits('gpt-6.1-sol','fast',tokens)).toBe(93);
  expect(estimateUsageCredits('gpt-6.1-sol','ultrafast',tokens)).toBe(279);
  expect(estimateUsageCredits('gpt-6.1-sol','fast',tokens,'subscription')).toBe(116.25);
  expect(estimateUsageCredits('gpt-6.1-sol','ultrafast',tokens,'subscription')).toBe(372);
  expect(estimateUsageCredits('gpt-6-astra','fast',tokens,'subscription')).toBe(600);
  expect(estimateUsageCredits('gpt-6-astra','ultrafast',tokens,'subscription')).toBe(1920);
  expect(estimateUsageCredits('gpt-6-astra','ultrafast',tokens,'credits')).toBe(1440);
 });
 it('keeps unsupported models, unknown modes and invalid counters unknown',()=>{
  expect(estimateUsageCredits('future-model',null,tokens)).toBeNull();
  expect(estimateUsageCredits('toString',null,tokens)).toBeNull();
  expect(estimateUsageCredits('gpt-6.2-astra-future',null,tokens)).toBeNull();
  expect(estimateUsageCredits('gpt-6.1-terra','ultrafast',tokens)).toBeNull();
  expect(estimateUsageCredits('gpt-6.1-sol','unknown-mode',tokens)).toBeNull();
  expect(estimateUsageCredits('gpt-6.1-sol',null,{...tokens,cached_input_tokens:null})).toBeNull();
  expect(estimateUsageCredits('gpt-6.1-sol',null,{...tokens,cached_input_tokens:2000000})).toBeNull();
  expect(estimateUsageCredits('gpt-6.2-sol','fast',{...tokens,input_tokens:-1})).toBeNull();
  expect(estimateUsageCredits('gpt-6.2-astra','ultrafast',{...tokens,output_tokens:NaN})).toBeNull();
 });
});
