import {describe,expect,it} from 'vitest';
import {recordedCachePercent,totalInputTokens,uncachedInputTokens} from '../src/lib/session-metadata';

describe('recorded cache rate',()=>{
 it('derives total input from complete total and output counters',()=>{
  const tokens={total_tokens:1000,input_tokens:null,cached_input_tokens:800,output_tokens:100,reasoning_output_tokens:20};
  expect(totalInputTokens(tokens)).toBe(900);
  expect(uncachedInputTokens(tokens)).toBe(100);
  expect(recordedCachePercent(tokens)).toBeCloseTo(88.8889,4);
 });

 it('keeps conflicting or impossible cache counters unknown',()=>{
  expect(recordedCachePercent({total_tokens:1000,input_tokens:900,cached_input_tokens:800,output_tokens:200})).toBeNull();
  expect(recordedCachePercent({total_tokens:1000,input_tokens:null,cached_input_tokens:901,output_tokens:100})).toBeNull();
 });
});
