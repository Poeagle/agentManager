import {expect,test} from '@playwright/test';

test('shows the default send guard branches and their operators on desktop and mobile',async({page})=>{
 const auth=await (await page.request.get('/api/auth/status')).json();
 const login=await page.request.post(auth.needsSetup?'/api/auth/setup':'/api/auth/login',{
  data:{username:'e2e-admin',password:'test-password'},
 });
 expect(login.ok()).toBe(true);
 await page.request.put('/api/settings',{data:{settings:{statusline_prompted:'true',app_theme:'light'}}});
 await page.goto('/');
 await page.getByTitle('My account',{exact:true}).click();
 const platform=page.getByRole('dialog',{name:'平台管理',exact:true});
 await platform.getByRole('button',{name:'平台设置',exact:true}).click();
 await platform.getByRole('button',{name:'发送保护',exact:true}).click();
 const rule=platform.getByRole('region',{name:'发送提醒条件',exact:true});
 await expect(rule.getByRole('combobox',{name:'发送提醒条件组合方式'})).toHaveValue('or');
 await expect(rule.getByLabel('发送提醒条件 1数值')).toHaveValue('80');
 await expect(rule.getByText('或',{exact:true})).toHaveCount(4);
 for(const [index,[minutes,percent]] of [[30,30],[20,50],[10,60],[60,20]].entries()){
  const label=`发送提醒条件 ${index+2}分组`;
  const branch=rule.getByRole('region',{name:label,exact:true});
  await expect(branch.getByRole('combobox',{name:`${label}组合方式`})).toHaveValue('and');
  await expect(branch.getByText('且',{exact:true})).toBeVisible();
  await expect(branch.getByLabel(`${label} 1`,{exact:true})).toHaveValue('idle_minutes');
  await expect(branch.getByLabel(`${label} 1数值`,{exact:true})).toHaveValue(String(minutes));
  await expect(branch.getByLabel(`${label} 2`,{exact:true})).toHaveValue('context_percent');
  await expect(branch.getByLabel(`${label} 2数值`,{exact:true})).toHaveValue(String(percent));
 }
 const desktopBranch=rule.getByRole('region',{name:'发送提醒条件 2分组',exact:true});
 const idle=desktopBranch.getByLabel('发送提醒条件 2分组 1',{exact:true});
 const usage=desktopBranch.getByLabel('发送提醒条件 2分组 2',{exact:true});
 expect(Math.abs((await idle.boundingBox())!.y-(await usage.boundingBox())!.y)).toBeLessThan(2);
 await page.setViewportSize({width:390,height:844});
 await expect(rule.getByLabel('发送提醒条件 5分组 2数值',{exact:true})).toHaveValue('20');
 expect(await rule.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
});
