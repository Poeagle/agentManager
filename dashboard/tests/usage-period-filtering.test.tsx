import {act,renderHook} from '@testing-library/react';
import {expect,it} from 'vitest';
import {allocateUsagePeriods} from '../src/components/usage-period-allocation';
import {useUsageTable} from '../src/components/use-usage-table';
import type {UsageRow} from '../src/components/codex-usage-groups';
const reference:UsageRow[]=[
 {date:'2026-01-05',cwd:'/A',tokens:{},estimated_credits:50,models:[{model:'M1',tokens:{},estimated_credits:25},{model:'M2',tokens:{},estimated_credits:25}]},
 {date:'2026-01-05',cwd:'/B',tokens:{},estimated_credits:50,models:[{model:'M1',tokens:{},estimated_credits:50}]},
];
const allocated=()=>allocateUsagePeriods(reference,[{hour:'2026-01-05T01:00:00Z',quota:4}],'day');
it('keeps quota and the original period credit denominator when models are hidden',()=>{
 const {result}=renderHook(()=>useUsageTable(allocated(),'day',reference));
 act(()=>result.current.table.setFilter('label',{text:'M1'}));
 expect(result.current.rows.map(row=>row.actual_quota)).toEqual([1,2]);
 const share=result.current.table.columns.find(column=>column.key==='share')!;
 expect(result.current.table.rows.map(row=>share.value(row))).toEqual([25,50]);
 const group=result.current.groups[0];expect(group.metrics.actual_quota).toBe(3);expect(result.current.creditTotals.get(group.key)).toBe(100);
});
it('keeps hidden projects in the original denominator after project search',()=>{
 const visible=allocated().filter(row=>row.cwd==='/A');
 const {result}=renderHook(()=>useUsageTable(visible,'day',reference));
 expect(result.current.groups[0].metrics.actual_quota).toBe(2);expect(result.current.creditTotals.get(result.current.groups[0].key)).toBe(100);
});
