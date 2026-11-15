import {expect,it} from 'vitest';
import {usageDateRange,usageRangeLabel} from '../src/components/usage-date-range';
it('expands week and month selections to whole local calendar periods',()=>{
 expect(usageDateRange('2026-11-14','2026-11-15','week')).toEqual({from:'2026-11-09',to:'2026-11-15'});
 expect(usageDateRange('2026-11-15','2026-11-16','week')).toEqual({from:'2026-11-09',to:'2026-11-22'});
 expect(usageDateRange('2026-11-14','2026-11-15','month')).toEqual({from:'2026-11-01',to:'2026-11-30'});
});
it('handles leap years and spanning calendar years without assuming fixed durations',()=>{
 expect(usageDateRange('2024-02-28','2024-03-01','month')).toEqual({from:'2024-02-01',to:'2024-03-31'});
 expect(usageDateRange('2025-12-31','2026-01-01','week')).toEqual({from:'2025-12-29',to:'2026-01-04'});
 expect(usageDateRange('2024-03-10','2024-03-10','week')).toEqual({from:'2024-03-04',to:'2024-03-10'});
});
it('keeps total and other dimensions inside the exact inclusive date selection',()=>{
 for(const dimension of ['total','day','hour','project','model'] as const)expect(usageDateRange('2026-11-14','2026-11-15',dimension)).toEqual({from:'2026-11-14',to:'2026-11-15'});
 expect(usageRangeLabel({from:'2026-11-14',to:'2026-11-14'})).toBe('2026-11-14');
 expect(usageDateRange('2026-11-15','2026-11-14','week')).toEqual({from:'2026-11-15',to:'2026-11-14'});
});
it('uses available date bounds for open ranges and handles invalid or empty dates without throwing',()=>{
 expect(usageDateRange('','','week',['2026-11-14','2026-11-15'])).toEqual({from:'2026-11-09',to:'2026-11-15'});
 expect(usageDateRange('','2026-11-15','total',['2026-11-09'])).toEqual({from:'2026-11-09',to:'2026-11-15'});
 expect(usageDateRange('','','total')).toEqual({from:'',to:''});expect(()=>usageDateRange('bad','bad','week')).not.toThrow();
});
