import {test,expect} from '@playwright/test';
test('period allocations remain coherent across dimensions, expansion and search',async({page})=>{
 const item=(date:string,cwd:string,n:number)=>({date,hour:`${date}T01:00:00+00:00`,cwd,project_name:cwd.slice(1),estimated_credits:n,estimated_usd:n/25,tokens:{input_tokens:n,cached_input_tokens:0,output_tokens:0,total_tokens:n},models:[{model:'fixture-model',estimated_credits:n,estimated_usd:n/25,tokens:{input_tokens:n,cached_input_tokens:0,output_tokens:0,total_tokens:n}}]});
 await page.route('**/api/codex/**',route=>route.fulfill({json:route.request().url().includes('/insights')?{usage:{storage:{kind:'csv',path:'/fixture/usage-csv/account'},checked_at:'2026-11-14T08:00:00Z',initialized:true,partial:false,timezone:'UTC',quota_hours:[{hour:'2026-11-09T01:00:00+00:00',quota:1},{hour:'2026-11-10T01:00:00+00:00',quota:3}],rows:[item('2026-11-09','/A',90),item('2026-11-09','/B',10),item('2026-11-10','/A',10),item('2026-11-10','/B',90)]}}:{account:{email:'fixture@example.invalid',plan:'pro'},resets:null}}));
 await page.goto('/tests/fixtures/usage-insights.html');const project=()=>page.getByRole('row').filter({has:page.getByText('/A',{exact:true})});
 await expect(page.getByText('CSV 目录：/fixture/usage-csv/account')).toBeVisible();await expect(page.getByText('最新采集：2026/11/14 08:00:00')).toBeVisible();await expect(page.locator('.ci-observation')).toHaveCSS('flex-wrap','nowrap');
 await expect(project().locator('td').nth(9)).toHaveText('0.40 | 0.3 (1.33)');await page.getByLabel('统计维度').selectOption('week');await expect(project().locator('td').nth(9)).toHaveText('4.00 | 2 (2)');
 await page.getByLabel('搜索项目或目录').fill('A');await expect(project().locator('td').nth(9)).toHaveText('4.00 | 2 (2)');await expect(project().locator('td').nth(10)).toHaveText('50.0%');await page.getByRole('button',{name:'展开 A 模型'}).click();await expect(page.getByRole('row').filter({has:page.getByText('fixture-model',{exact:true})}).locator('td').nth(9)).toHaveText('4.00 | 2 (2)');
 await page.getByLabel('统计维度').selectOption('hour');await expect(project().locator('td').nth(9)).toHaveText('0.40 | 0.3 (1.33)');await page.getByLabel('统计维度').selectOption('month');await expect(project().locator('td').nth(9)).toHaveText('4.00 | 2 (2)');
});

for(const api of [false,true])test(`selected dates expand for weeks/months and remain exact for total (${api?'API':'subscription'})`,async({page})=>{
 const item=(date:string,cwd:string,n:number)=>({date,cwd,project_name:cwd.slice(1),estimated_credits:n,estimated_usd:n/25,tokens:{input_tokens:n,cached_input_tokens:0,output_tokens:0,total_tokens:n},models:[{model:'fixture-model',estimated_credits:n,estimated_usd:n/25,tokens:{input_tokens:n,cached_input_tokens:0,output_tokens:0,total_tokens:n}}]});
 const rows=[item('2026-11-08','/Before',100),item('2026-11-09','/A',90),item('2026-11-09','/B',10),item('2026-11-14','/A',10),item('2026-11-14','/B',90),item('2026-11-15','/A',20),item('2026-11-15','/B',80),item('2026-11-30','/After',100),item('2026-12-01','/December',500)];
 const quota_hours=[['2026-11-08',5],['2026-11-09',1],['2026-11-14',3],['2026-11-15',2],['2026-11-30',4],['2026-12-01',7]].map(([date,quota])=>({hour:`${date}T01:00:00+08:00`,quota}));let reads=0;
 await page.route('**/api/codex/**',route=>{if(route.request().url().includes('/insights')){reads++;return route.fulfill({json:{usage:{initialized:true,partial:false,timezone:'Asia/Taipei',rows,quota_hours}}});}return route.fulfill({json:{account:{email:'fixture@example.invalid',plan:'pro'},resets:null}});});
 await page.goto('/tests/fixtures/usage-insights.html'+(api?'?api=1':''));await expect(page.getByText('/December',{exact:true})).toBeVisible();
 await page.getByLabel('开始日期').fill('2026-11-14');await page.getByLabel('结束日期').fill('2026-11-15');await page.getByLabel('统计维度').selectOption('total');
 const root=page.locator('tr.ci-day'),project=(name:string)=>page.getByRole('row').filter({has:page.getByText(name,{exact:true})});
 await expect(root).toHaveCount(1);await expect(root).toContainText('2026-11-14 ~ 2026-11-15');await expect(root.locator('td').nth(8)).toHaveText(api?'200 (—)':'200 (8.00)');
 if(api){await expect(page.getByRole('columnheader',{name:'耗用额度',exact:true})).toHaveCount(0);await expect(page.getByRole('columnheader',{name:'预估金额 | 额度',exact:true})).toHaveCount(0);}else{await expect(project('/A').locator('td').nth(9)).toHaveText('1.20 | 0.75 (1.6)');await expect(root.locator('td').nth(9)).toHaveText('8.00 | 5 (1.6)');}
 await page.getByLabel('统计维度').selectOption('week');await expect(root).toContainText('2026-11-09 ~ 2026-11-15');await expect(root.locator('td').nth(8)).toHaveText(api?'300 (—)':'300 (12.00)');await expect(page.getByText('统计范围：2026-11-09 ~ 2026-11-15')).toBeVisible();
 if(!api)await expect(project('/A').locator('td').nth(9)).toHaveText('4.80 | 2.4 (2)');
 await page.getByLabel('统计维度').selectOption('month');await expect(root.locator('td').nth(8)).toHaveText(api?'500 (—)':'500 (20.00)');await expect(page.getByText('/Before',{exact:true})).toBeVisible();await expect(page.getByText('/After',{exact:true})).toBeVisible();await expect(page.getByText('/December',{exact:true})).toHaveCount(0);
 await page.getByLabel('统计维度').selectOption('total');await page.getByLabel('搜索项目或目录').fill('A');await expect(project('/B')).toHaveCount(0);await expect(root).toContainText('2026-11-14 ~ 2026-11-15');
 if(!api){await expect(project('/A').locator('td').nth(9)).toHaveText('1.20 | 0.75 (1.6)');await expect(project('/A').locator('td').nth(10)).toHaveText('15.0%');}
 expect(reads).toBe(1);await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('allocates one line to project names, paths and numeric values at desktop and mobile widths',async({page},info)=>{
 const project='quantitative_strategy',directory='/workspace/quantitative/strategy-engine/market-data';
 const metrics={estimated_credits:3757.13,estimated_usd:3757.13/25,actual_quota:15,
  tokens:{input_tokens:852254294,cached_input_tokens:837980928,output_tokens:2856707,total_tokens:855111001}};
 const rows=[{date:'2026-11-16',cwd:directory,project_name:project,...metrics,models:[{model:'fixture-model',...metrics}]}];
 await page.route('**/api/codex/**',route=>route.fulfill({json:route.request().url().includes('/insights')
  ?{usage:{initialized:true,partial:false,timezone:'UTC',rows}}
  :{account:{email:'fixture@example.invalid',plan:'pro'},resets:null}}));
 await page.setViewportSize({width:1548,height:850});
 await page.goto('/tests/fixtures/usage-insights.html');

 const table=page.getByRole('table',{name:'用量统计'});
 const scroll=page.getByRole('region',{name:'用量统计，可横向滚动查看全部列'});
 const row=table.getByRole('row').filter({has:page.getByText(directory,{exact:true})});
 const label=row.getByText(project,{exact:true}),path=row.getByText(directory,{exact:true}),cost=row.locator('td').nth(9);
 await expect(table.getByRole('columnheader')).toHaveCount(11);
 await expect(table.getByRole('columnheader',{name:'预估金额 | 额度',exact:true})).toBeVisible();
 await expect(cost).toHaveText('150.29 | 15 (10.02)');
 await expect(label).toHaveCSS('white-space','nowrap');
 await expect(path).toHaveCSS('white-space','nowrap');
 await expect(path).toHaveAttribute('title',directory);
 expect(await label.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
 expect(await path.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
 expect(await row.locator('td').evaluateAll(cells=>cells.slice(2).every(cell=>cell.scrollWidth<=cell.clientWidth))).toBe(true);
 expect(await scroll.evaluate(node=>node.scrollWidth<=node.clientWidth+1)).toBe(true);
 await page.screenshot({path:info.outputPath('combined-usage-cost.png')});

 await page.getByRole('button',{name:`展开 ${project} 模型`}).click();
 await expect(table.getByRole('row').filter({has:page.getByText('fixture-model',{exact:true})}).locator('td').nth(9)).toHaveText('150.29 | 15 (10.02)');
 await page.setViewportSize({width:390,height:844});
 await expect(path).toHaveCSS('text-overflow','ellipsis');
 expect(await scroll.evaluate(node=>node.scrollWidth>node.clientWidth)).toBe(true);
 await cost.scrollIntoViewIfNeeded();
 expect(await cost.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:info.outputPath('combined-usage-cost-mobile.png')});
});
