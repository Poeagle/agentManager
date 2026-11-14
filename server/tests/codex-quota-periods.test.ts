import {it,expect} from 'vitest';
import {quotaHours} from '../src/services/agents/codex/quota-periods.js';
const sample=(time:string,used:number)=>({checked_at:time,used,reset_at:2000000000,email:'test@example.invalid'});
const event=(at:string,input:number)=>({at,day:at.slice(0,10),hour:null,cwd:'/p',model:'gpt-6.1-sol',tier:null,tokens:JSON.stringify({input_tokens:input,cached_input_tokens:0,output_tokens:0})});
it('records same-hour account changes even without requests, and ignores gaps and upward remaining changes',()=>{
 const samples=[sample('2026-01-01T10:00:00Z',10),sample('2026-01-01T10:05:00Z',11),sample('2026-01-01T10:25:00Z',12),sample('2026-01-01T10:30:00Z',0)];
 expect(quotaHours(samples,[],'2026-01-01T11:00:00Z','UTC').hours).toEqual([{hour:'2026-01-01T10:00:00+00:00',quota:1}]);
});
it('splits a crossing at midnight by the credits of events on either side',()=>{
 const samples=[sample('2026-01-01T23:58:00Z',10),sample('2026-01-02T00:03:00Z',14)];
 const events=[event('2026-01-01T23:59:00Z',100),event('2026-01-02T00:01:00Z',300)];
 expect(quotaHours(samples,events,'2026-01-02T00:04:00Z','UTC').hours).toEqual([{hour:'2026-01-01T23:00:00+00:00',quota:1},{hour:'2026-01-02T00:00:00+00:00',quota:3}]);
 expect(quotaHours(samples,[],'2026-01-02T00:04:00Z','UTC').hours).toEqual([]);
});
it('handles large historical samples and request sets with bounded memory',()=>{
 const base=Date.parse('2026-01-01T00:00:00Z'),samples=Array.from({length:5000},(_,i)=>sample(new Date(base+i*300000).toISOString(),i/10000));
 const events=Array.from({length:300000},(_,i)=>event(new Date(base+i*5000+1000).toISOString(),10));
 const start=performance.now(),result=quotaHours(samples,events,new Date(base+5000*300000).toISOString(),'UTC');
 expect(result.hours.length).toBeGreaterThan(400);expect(result.hours.reduce((n,r)=>n+r.quota,0)).toBeCloseTo(.4999,4);
 console.log(`quotaHours: 300000 events, 5000 samples in ${Math.round(performance.now()-start)}ms`);
},30000);
it('keeps two repeated local hours distinct when the timezone offset changes',()=>{
 const samples=[sample('2026-11-01T05:10:00Z',10),sample('2026-11-01T05:15:00Z',11),sample('2026-11-01T06:10:00Z',11),sample('2026-11-01T06:15:00Z',13)];
 const result=quotaHours(samples,[],'2026-11-01T06:20:00Z','America/New_York');
 expect(result.hours).toEqual([{hour:'2026-11-01T01:00:00-04:00',quota:1},{hour:'2026-11-01T01:00:00-05:00',quota:2}]);expect(result.gaps).toBe(1);
});
