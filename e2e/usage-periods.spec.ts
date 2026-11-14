import {test,expect} from '@playwright/test';
test('period allocations remain coherent across dimensions, expansion and search',async({page})=>{
 const item=(date:string,cwd:string,n:number)=>({date,hour:`${date}T01:00:00+00:00`,cwd,project_name:cwd.slice(1),estimated_credits:n,tokens:{input_tokens:n,cached_input_tokens:0,output_tokens:0,total_tokens:n},models:[{model:'fixture-model',estimated_credits:n,tokens:{input_tokens:n,cached_input_tokens:0,output_tokens:0,total_tokens:n}}]});
 await page.route('**/api/codex/**',route=>route.fulfill({json:route.request().url().includes('/insights')?{usage:{initialized:true,partial:false,timezone:'UTC',quota_hours:[{hour:'2026-11-09T01:00:00+00:00',quota:1},{hour:'2026-11-10T01:00:00+00:00',quota:3}],rows:[item('2026-11-09','/A',90),item('2026-11-09','/B',10),item('2026-11-10','/A',10),item('2026-11-10','/B',90)]}}:{account:{email:'fixture@example.invalid',plan:'pro'},resets:null}}));
 await page.goto('/tests/fixtures/usage-insights.html');const project=()=>page.getByRole('row').filter({has:page.getByText('/A',{exact:true})});
 await expect(project().locator('td').nth(8)).toHaveText('0.3');await page.getByLabel('统计维度').selectOption('week');await expect(project().locator('td').nth(8)).toHaveText('2');
 await page.getByLabel('搜索项目或目录').fill('A');await expect(project().locator('td').nth(8)).toHaveText('2');await page.getByRole('button',{name:'展开 A 模型'}).click();await expect(page.getByRole('row').filter({has:page.getByText('fixture-model',{exact:true})}).locator('td').nth(8)).toHaveText('2');
 await page.getByLabel('统计维度').selectOption('hour');await expect(project().locator('td').nth(8)).toHaveText('0.3');await page.getByLabel('统计维度').selectOption('month');await expect(project().locator('td').nth(8)).toHaveText('2');
});
