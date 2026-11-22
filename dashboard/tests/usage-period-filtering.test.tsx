import {act,renderHook} from '@testing-library/react';
import {expect,it} from 'vitest';
import {allocateUsagePeriods} from '../src/components/usage-period-allocation';
import {useUsageTable} from '../src/components/use-usage-table';
import type {UsageRow} from '../src/components/codex-usage-groups';
const reference:UsageRow[]=[
 {date:'2026-01-05',cwd:'/A',tokens:{},estimated_credits:50,estimated_usd:20,models:[{model:'M1',tokens:{},estimated_credits:25,estimated_usd:5},{model:'M2',tokens:{},estimated_credits:25,estimated_usd:15}]},
 {date:'2026-01-05',cwd:'/B',tokens:{},estimated_credits:50,estimated_usd:80,models:[{model:'M1',tokens:{},estimated_credits:50,estimated_usd:80}]},
];
const allocated=()=>allocateUsagePeriods(reference,[{hour:'2026-01-05T01:00:00Z',quota:4}],'day');
it('keeps quota and the original period amount denominator when models are hidden',()=>{
 const {result}=renderHook(()=>useUsageTable(allocated(),'day',reference));
 act(()=>result.current.table.setFilter('label',{text:'M1'}));
 expect(result.current.rows.map(row=>row.actual_quota)).toEqual([1,2]);
 const share=result.current.table.columns.find(column=>column.key==='share')!;
 expect(result.current.table.rows.map(row=>share.value(row))).toEqual([5,80]);
 const group=result.current.groups[0];expect(group.metrics.actual_quota).toBe(3);expect(result.current.amountTotals.get(group.key)).toBe(100);
});
it('keeps hidden projects in the original denominator after project search',()=>{
 const visible=allocated().filter(row=>row.cwd==='/A');
 const {result}=renderHook(()=>useUsageTable(visible,'day',reference));
 expect(result.current.groups[0].metrics.actual_quota).toBe(2);expect(result.current.amountTotals.get(result.current.groups[0].key)).toBe(100);
});

it('keeps total range labels and amount denominators stable when filtering models',()=>{
 const total=allocateUsagePeriods(reference,[{hour:'2026-01-05T01:00:00Z',quota:4}],'total');
 const {result}=renderHook(()=>useUsageTable(total,'total',reference,{from:'2026-01-01',to:'2026-01-31'}));
 act(()=>result.current.table.setFilter('label',{text:'M1'}));
 expect(result.current.groups).toHaveLength(1);const group=result.current.groups[0];
 expect(group.label).toBe('2026-01-01 ~ 2026-01-31');expect(group.metrics.actual_quota).toBe(3);expect(result.current.amountTotals.get(group.key)).toBe(100);
 const share=result.current.table.columns.find(column=>column.key==='share')!;expect(result.current.table.rows.map(row=>share.value(row))).toEqual([5,80]);
});
