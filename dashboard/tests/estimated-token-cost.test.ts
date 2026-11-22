import {expect,it} from 'vitest';
import {formatEstimatedTokenCost} from '../src/components/estimated-token-cost';

it('shows currency estimates to two decimal places and marks sub-cent amounts',()=>{
 expect(formatEstimatedTokenCost(1.2,'USD',false)).toBe('1.20');
 expect(formatEstimatedTokenCost(1.2,'CNY',true)).toBe('1.20*');
 expect(formatEstimatedTokenCost(0.004,'USD',false)).toBe('<0.01');
 expect(formatEstimatedTokenCost(0.004,'CNY',false)).toBe('<0.01');
});

it('converts Credits to USD and leaves unknown prices unknown',()=>{
 expect(formatEstimatedTokenCost(25,'credits',false)).toBe('1.00');
 expect(formatEstimatedTokenCost(0.004,'credits',false)).toBe('<0.01');
 expect(formatEstimatedTokenCost(null,'USD',false)).toBe('—');
});
