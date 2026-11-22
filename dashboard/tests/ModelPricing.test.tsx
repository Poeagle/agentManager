import {expect,it} from 'vitest';
import {modelMultiplierLabel} from '../src/components/ModelPricing';

it('shows an explicit 1x multiplier for official API and account Credits rates',()=>{
 expect(modelMultiplierLabel({api_pricing:{currency:'USD',source:'official',reference_only:false}})).toBe('1×');
 expect(modelMultiplierLabel({reference_credits:{input:50,cached:2.5,output:250,as_of:'2026-11-22'}})).toBe('1×');
});

it('keeps an unconfigured third-party fallback multiplier unknown',()=>{
 expect(modelMultiplierLabel({api_pricing:{currency:'USD',source:'official',reference_only:true}})).toBe('未填写');
 expect(modelMultiplierLabel({api_pricing:{currency:'USD',source:'official',reference_only:true,provider_multiplier:1.2}})).toBe('1.2×');
});
