import {test,expect} from '@playwright/test';

test('platform font previews, reverts, persists and falls back',async({page},testInfo)=>{
 const auth=await(await page.request.get('/api/auth/status')).json();expect((await page.request.post(auth.needsSetup?'/api/auth/setup':'/api/auth/login',{data:{username:'e2e-admin',password:'test-password'}})).ok()).toBeTruthy();
 await page.request.put('/api/settings',{data:{settings:{app_font_family:'',app_theme:'light',statusline_prompted:'true'}}});await page.goto('/');
 const dialog=page.getByRole('dialog',{name:'平台管理'});
 const open=async()=>{await page.getByTitle('My account', { exact: true }).click();await dialog.getByRole('navigation',{name:'平台管理分类'}).getByRole('button',{name:'平台设置',exact:true}).click();await dialog.getByRole('button',{name:'外观',exact:true}).click();};
 const bodyFont=()=>page.locator('body').evaluate(node=>getComputedStyle(node).fontFamily);
 await open();await dialog.getByLabel('平台字体',{exact:true}).selectOption('yahei');await expect.poll(bodyFont).toContain('Microsoft YaHei');
 await expect.poll(()=>dialog.locator('.settings-panel-shell').evaluate(node=>getComputedStyle(node).fontFamily)).toContain('Microsoft YaHei');
 await dialog.getByRole('button',{name:'关闭平台管理'}).click();await expect.poll(bodyFont).not.toContain('Microsoft YaHei');
 await open();await dialog.getByLabel('平台字体',{exact:true}).selectOption('custom');await dialog.getByLabel('自定义字体名称',{exact:true}).fill('DejaVu Serif');await expect.poll(bodyFont).toContain('DejaVu Serif');
 await expect(dialog.getByLabel('字体预览')).toContainText('项目、对话与任务进展');await page.screenshot({path:testInfo.outputPath('platform-font-preview.png')});
 await dialog.getByRole('button',{name:'保存设置',exact:true}).click();await expect(dialog.getByRole('button',{name:'已保存',exact:true})).toBeVisible();
 expect((await(await page.request.get('/api/settings')).json()).settings.app_font_family).toBe('DejaVu Serif');await page.reload();await expect.poll(bodyFont).toContain('DejaVu Serif');
 await open();await expect(dialog.getByLabel('自定义字体名称',{exact:true})).toHaveValue('DejaVu Serif');
 await dialog.getByLabel('平台字体',{exact:true}).selectOption('custom');await dialog.getByLabel('自定义字体名称',{exact:true}).fill('MissingFontForFallback');
 await expect.poll(bodyFont).toContain('MissingFontForFallback');expect(await bodyFont()).toContain('sans-serif');
 await page.setViewportSize({width:390,height:844});await dialog.getByLabel('平台字体',{exact:true}).scrollIntoViewIfNeeded();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:testInfo.outputPath('platform-font-mobile.png')});
 await dialog.getByRole('button',{name:'关闭平台管理'}).click();await expect.poll(bodyFont).toContain('DejaVu Serif');
 await page.setViewportSize({width:1280,height:720});await open();await dialog.getByLabel('平台字体',{exact:true}).selectOption('system');await dialog.getByRole('button',{name:'保存设置',exact:true}).click();await expect(dialog.getByRole('button',{name:'已保存',exact:true})).toBeVisible();await page.reload();await expect.poll(bodyFont).not.toContain('DejaVu Serif');
});
