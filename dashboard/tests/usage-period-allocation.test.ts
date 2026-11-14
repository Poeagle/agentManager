import {it,expect} from 'vitest';
import {allocateUsagePeriods} from '../src/components/usage-period-allocation';
const row=(date:string,cwd:string,credit:number)=>({date,cwd,tokens:{},estimated_credits:credit,models:[{model:'model',tokens:{},estimated_credits:credit}]});
it('redistributes the observed period by the entire period credit weight',()=>{
 const rows=[row('2026-01-05','a',90),row('2026-01-05','b',10),row('2026-01-06','a',10),row('2026-01-06','b',90)];
 const hours=[{hour:'2026-01-05T01:00:00+00:00',quota:1},{hour:'2026-01-06T01:00:00+00:00',quota:3}];
 const day=allocateUsagePeriods(rows,hours,'day'),week=allocateUsagePeriods(rows,hours,'week');
 expect(day.map(r=>r.models![0].actual_quota)).toEqual([.9,.1,.3,2.7]);
 expect(week.map(r=>r.models![0].actual_quota)).toEqual([1.8,.2,.2,1.8]);
 expect(allocateUsagePeriods(rows,[],'day')[0].models![0].actual_quota).toBeNull();
});
it('conserves the observed total across projects and models for each selected period',()=>{
 const rows=[row('2026-01-05','a',21),row('2026-01-05','b',31),row('2026-01-06','a',13),row('2026-01-06','b',15)];
 const hours=[{hour:'2026-01-05T10:00:00+00:00',quota:1.5},{hour:'2026-01-06T11:00:00+00:00',quota:2.2}];
 for(const dimension of ['day','week','month','project','model'] as const){const result=allocateUsagePeriods(rows,hours,dimension);const actual=result.reduce((sum,r)=>sum+(r.models?.[0].actual_quota??0),0);expect(actual).toBeCloseTo(3.7,12);}
});
it('keeps consumption unknown when there is no observed quota or no estimable weight',()=>{
 const r=[row('2026-01-05','a',0)];expect(allocateUsagePeriods(r,[{hour:'2026-01-05T10:00:00+00:00',quota:1}],'day')[0].models?.[0].actual_quota).toBeNull();
 expect(allocateUsagePeriods([row('2026-01-06','b',5)],[{hour:'2026-01-05T10:00:00+00:00',quota:1}],'day')[0].models?.[0].actual_quota).toBeNull();
});
it('conserves the displayed total when equal shares require rounding',()=>{
 const rows=[row('2026-01-05','a',1),row('2026-01-05','b',1),row('2026-01-05','c',1)];const hours=[{hour:'2026-01-05T10:00:00+00:00',quota:1}];const values=allocateUsagePeriods(rows,hours,'day').map(r=>r.actual_quota);expect(values).toEqual([.3334,.3333,.3333]);expect(values.reduce<number>((n,v)=>n+Math.round(v!*10000),0)).toBe(10000);
});
it('keeps month and year boundaries distinct while recomputing a spanning week',()=>{
 const rows=[row('2025-12-31','a',90),row('2025-12-31','b',10),row('2026-01-01','a',10),row('2026-01-01','b',90)];const hours=[{hour:'2025-12-31T23:00:00+08:00',quota:1},{hour:'2026-01-01T00:00:00+08:00',quota:3}];
 expect(allocateUsagePeriods(rows,hours,'month').map(r=>r.actual_quota)).toEqual([.9,.1,.3,2.7]);expect(allocateUsagePeriods(rows,hours,'week').map(r=>r.actual_quota)).toEqual([1.8,.2,.2,1.8]);
});

it('matches equivalent UTC hour timestamps without merging different instants',()=>{
 const rows=[{...row('2026-01-05','a',1),hour:'2026-01-05T10:00:00Z'}];const result=allocateUsagePeriods(rows,[{hour:'2026-01-05T10:00:00+00:00',quota:1}],'hour');expect(result[0].actual_quota).toBe(1);
});
it('allocates the screenshot daily total to every project with positive credit weight',()=>{
 const rows=[row('2026-11-14','octoally-app',812.77),row('2026-11-14','collectreport',90.81),row('2026-11-14','aizhaopin',78.86)];const result=allocateUsagePeriods(rows,[{hour:'2026-11-14T13:00:00+08:00',quota:3}],'day');expect(result.map(r=>r.actual_quota)).toEqual([2.4819,.2773,.2408]);
});
