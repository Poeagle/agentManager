import {expect,test} from '@playwright/test';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';

test('project descriptions have a separate column and long values stay inside desktop columns',async({page},testInfo)=>{
 const status=await(await page.request.get('/api/auth/status')).json();
 expect((await page.request.post(status.needsSetup?'/api/auth/setup':'/api/auth/login',{data:{username:'e2e-admin',password:'test-password'}})).ok()).toBeTruthy();
 const path=join(process.cwd(),'.test-data/e2e','long-project-columns','deep-directory'.repeat(8));mkdirSync(path,{recursive:true});
 const name='finonelib-ficc-trading-backtester-with-a-long-project-name',description='pyswordfish 调度，包含策略运行与行情处理；这是独立的项目描述，不应与名称挤在同一列。'.repeat(4);
 const response=await page.request.post('/api/projects',{data:{name,path,description}});expect(response.ok()).toBeTruthy();const {project}=await response.json();
 const branch='release300-Python-API-1926-with-an-extra-long-branch-name';
 await page.route('**/api/git/status?*',route=>route.fulfill({json:{branch,ahead:0,behind:0,files:[],remoteUrl:null}}));
 await page.request.put('/api/settings',{data:{settings:{statusline_prompted:'true',app_theme:'light'}}});await page.goto('/');await page.getByRole('button',{name:'Projects',exact:true}).click();
 const table=page.getByRole('table',{name:'项目列表',exact:true}),row=table.locator(`tr[data-project-id="${project.id}"]`);
 await expect(table.getByRole('button',{name:'描述排序',exact:true})).toBeVisible();
 await expect(row.getByRole('button',{name:branch,exact:false})).toBeVisible();
 await expect(row.locator('td').nth(1)).not.toContainText('pyswordfish');await expect(row.locator('td').nth(2)).toHaveText(description);
 for(const width of [1440,1920]){
  await page.setViewportSize({width,height:1000});
  const layout=await row.evaluate(node=>{
   const cells=[...node.querySelectorAll(':scope > td')];
   return {widths:cells.map(cell=>cell.getBoundingClientRect().width),contained:cells.every(cell=>[...cell.children].every(child=>{
    const outer=cell.getBoundingClientRect(),inner=child.getBoundingClientRect();return inner.left>=outer.left&&inner.right<=outer.right+1;
   })),descriptionHeight:cells[2].firstElementChild!.getBoundingClientRect().height};
  });
  expect(layout.contained).toBe(true);expect(layout.widths[1]).toBeCloseTo(360,0);expect(layout.widths[2]).toBeCloseTo(280,0);expect(layout.widths[4]).toBeGreaterThanOrEqual(240);expect(layout.widths[5]).toBeCloseTo(224,0);expect(layout.widths[6]).toBeCloseTo(140,0);expect(layout.widths[7]).toBeGreaterThanOrEqual(135);expect(layout.descriptionHeight).toBeLessThanOrEqual(36);
  const nameButton=row.getByRole('button',{name,exact:true});await expect(nameButton).toBeVisible();
  expect(await nameButton.locator('span').evaluate(node=>node.scrollWidth<=node.clientWidth&&getComputedStyle(node).textOverflow!=='ellipsis')).toBe(true);
  await row.getByRole('button',{name:`打开项目 ${name}`,exact:true}).scrollIntoViewIfNeeded();await expect(row.getByRole('button',{name:`打开项目 ${name}`,exact:true})).toBeVisible();
  await page.screenshot({path:testInfo.outputPath(`project-columns-${width}.png`)});
 }
 await row.getByRole('button',{name:`展开项目 ${name} 的会话`,exact:true}).click();await expect(page.getByRole('table',{name:'项目会话',exact:true})).toBeVisible();
});
