import {describe,it,expect} from 'vitest';
import {estimateUsageCredits} from '../src/services/agents/codex/usage-credits.js';
describe('current-rate Codex credit equivalents',()=>{
 const tokens={input_tokens:1000000,cached_input_tokens:600000,output_tokens:100000,reasoning_output_tokens:50000};
 it('subtracts cached inputs, includes reasoning only through outputs, and applies speed multipliers',()=>{
  expect(estimateUsageCredits('gpt-6.1-sol',null,tokens)).toBe(46.5);
  expect(estimateUsageCredits('gpt-6.1-sol','fast',tokens)).toBe(93);
  expect(estimateUsageCredits('gpt-6.1-sol','ultrafast',tokens)).toBe(279);
  expect(estimateUsageCredits('gpt-6.1-sol','fast',tokens,'subscription')).toBe(116.25);
  expect(estimateUsageCredits('gpt-6.1-sol','ultrafast',tokens,'subscription')).toBe(372);
 });
 it('keeps unsupported models, unknown modes and invalid counters unknown',()=>{
  expect(estimateUsageCredits('future-model',null,tokens)).toBeNull();
  expect(estimateUsageCredits('gpt-6.1-sol','unknown-mode',tokens)).toBeNull();
  expect(estimateUsageCredits('gpt-6.1-sol',null,{...tokens,cached_input_tokens:null})).toBeNull();
  expect(estimateUsageCredits('gpt-6.1-sol',null,{...tokens,cached_input_tokens:2000000})).toBeNull();
 });
});
