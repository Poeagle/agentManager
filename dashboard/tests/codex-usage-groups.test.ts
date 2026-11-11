import {expect,it} from 'vitest';
import {groupUsage,estimatableUsageRows,type UsageRow,type UsageGroup,type Dimension} from '../src/components/codex-usage-groups';
const metrics=(input:number,cached:number|null)=>({tokens:{input_tokens:input,cached_input_tokens:cached,output_tokens:0,total_tokens:input},estimated_credits:input/100,credit_coverage:{covered:1,total:1}});
const row=(date:string,cwd:string,model:string,input:number,cached:number|null):UsageRow=>({date,cwd,project_name:'Same name',...metrics(input,cached),models:[{model,...metrics(input,cached)}]});
const rows=[row('2026-12-31','/a','large',900,900),row('2027-01-01','/a','small',100,0),row('2027-01-03','/b','large',200,100),row('2027-01-04','/a','large',50,25)];
function verify(nodes:UsageGroup[]){for(const node of nodes){if(node.children.length){expect(node.children.reduce((sum,n)=>sum+n.metrics.tokens.total_tokens!,0)).toBe(node.metrics.tokens.total_tokens);expect(node.children.reduce((sum,n)=>sum+(n.metrics.estimated_credits??0),0)).toBeCloseTo(node.metrics.estimated_credits!);verify(node.children);}}}
it('preserves totals and credit estimates at every level for all five dimensions',()=>{
 for(const dim of ['day','week','month','project','model'] as Dimension[]){const groups=groupUsage(rows,dim);expect(groups.reduce((n,g)=>n+g.metrics.tokens.total_tokens!,0)).toBe(1250);verify(groups);}
 const projects=groupUsage(rows,'project');expect(projects).toHaveLength(2);expect(projects[0].detail).toBe('/a');expect(projects[0].children.map(n=>n.label)).toEqual(['large','small']);expect(projects[0].children[0].children).toHaveLength(2);
 const models=groupUsage(rows,'model');expect(models[0].label).toBe('large');expect(models[0].children).toHaveLength(2);
});
it('uses Monday UTC weeks across year boundaries and calendar months, after filtering',()=>{
 const weeks=groupUsage(rows,'week');expect(weeks.map(n=>n.label)).toEqual(['2027-01-04 ~ 2027-01-10','2026-12-28 ~ 2027-01-03']);expect(weeks[1].metrics.tokens.total_tokens).toBe(1200);
 const months=groupUsage(rows,'month');expect(months.map(n=>n.label)).toEqual(['2027-01','2026-12']);expect(months[0].metrics.tokens.total_tokens).toBe(350);
 const filtered=groupUsage(rows.filter(r=>r.date>='2027-01-01'&&r.date<='2027-01-03'),'week');expect(filtered).toHaveLength(1);expect(filtered[0].metrics.tokens.total_tokens).toBe(300);
});
it('aggregates raw cache counters rather than averaging cache rates and preserves unknown values',()=>{
 const group=groupUsage(rows.slice(0,2),'week')[0];expect(group.metrics.tokens.cached_input_tokens!/group.metrics.tokens.input_tokens!).toBe(.9);
 const unknown=groupUsage([row('2026-01-01','/a','known',10,null)],'model')[0];expect(unknown.metrics.tokens.cached_input_tokens).toBeNull();
 const legacy=groupUsage([{date:'2026-01-01',cwd:'/a',...metrics(10,5)}],'project')[0];expect(legacy.missingModels).toBe(true);expect(legacy.children[0].label).toBe('模型明细未返回');expect(legacy.metrics.tokens.total_tokens).toBe(10);
});
it('hides unestimatable projects and models and recomputes parent counters for every dimension',()=>{
 const known=row('2026-01-01','/known','known',100,50);
 const unknown={...row('2026-01-01','/hidden','unknown',500,400),estimated_credits:null,models:[{model:'unknown',...metrics(500,400),estimated_credits:null}]};
 const mixed={...known,tokens:metrics(600,450).tokens,models:[...known.models!,...unknown.models]};
 const visible=estimatableUsageRows([mixed,unknown]);expect(visible).toHaveLength(1);expect(visible[0].models).toHaveLength(1);expect(visible[0].tokens.total_tokens).toBe(100);
 for(const dimension of ['day','week','month','project','model'] as Dimension[]){const grouped=groupUsage(visible,dimension);expect(grouped[0].metrics.tokens.total_tokens).toBe(100);expect(JSON.stringify(grouped)).not.toContain('unknown');}
});
