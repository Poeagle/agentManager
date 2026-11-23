import {expect,test} from '@playwright/test';

test('edits reminder groups and automatic rule rows on desktop and mobile',async({page})=>{
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
 await expect(rule.getByRole('button',{name:'发送提醒条件组合方式'})).toHaveText('或');
 await expect(rule.getByLabel('发送提醒条件 1数值')).toHaveValue('80');
 await expect(rule.getByText('或',{exact:true})).toHaveCount(5);
 for(const [index,[minutes,percent]] of [[30,30],[20,50],[10,60],[60,20]].entries()){
  const label=`发送提醒条件 ${index+2}分组`;
  const branch=rule.getByRole('region',{name:label,exact:true});
  await expect(branch.getByRole('button',{name:`${label}组合方式`})).toHaveText('且');
  await expect(branch.getByRole('button',{name:`${label}连接方式`})).toHaveText('且');
  await expect(branch.getByLabel(`${label} 1`,{exact:true})).toHaveValue('idle_minutes');
  await expect(branch.getByLabel(`${label} 1数值`,{exact:true})).toHaveValue(String(minutes));
  await expect(branch.getByLabel(`${label} 2`,{exact:true})).toHaveValue('context_percent');
  await expect(branch.getByLabel(`${label} 2数值`,{exact:true})).toHaveValue(String(percent));
 }
 const desktopBranch=rule.getByRole('region',{name:'发送提醒条件 2分组',exact:true});
 const idle=desktopBranch.getByLabel('发送提醒条件 2分组 1',{exact:true});
 const usage=desktopBranch.getByLabel('发送提醒条件 2分组 2',{exact:true});
 expect(Math.abs((await idle.boundingBox())!.y-(await usage.boundingBox())!.y)).toBeLessThan(2);
 await desktopBranch.getByRole('button',{name:'发送提醒条件 2分组连接方式'}).click();
 await expect(desktopBranch.getByRole('button',{name:'发送提醒条件 2分组组合方式'})).toHaveText('或');
 await page.setViewportSize({width:390,height:844});
 await expect(rule.getByLabel('发送提醒条件 5分组 2数值',{exact:true})).toHaveValue('20');
 expect(await rule.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
 const automatic=platform.getByRole('region',{name:'发送保护自动规则'});
 const table=automatic.getByRole('table',{name:'自动规则'});
 await automatic.getByRole('button',{name:'添加自动规则'}).click();
 const add=page.getByRole('dialog',{name:'添加自动规则'});
 const box=(await add.boundingBox())!;
 expect(Math.abs(box.x+box.width/2-195)).toBeLessThan(2);
 expect(Math.abs(box.y+box.height/2-422)).toBeLessThan(2);
 await add.getByLabel('执行动作').selectOption('brief');
 await add.getByLabel('换到有剩余额度的账号').check();
 await add.getByLabel('触发条件 1',{exact:true}).selectOption('account_remaining_percent');
 await expect(add.getByLabel('触发条件 1数值')).toHaveValue('0');
 expect(await add.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
 await add.getByRole('button',{name:'应用到表格'}).click();
 await expect(table.getByRole('row')).toHaveCount(2);
 const action=table.getByRole('cell',{name:/简要压缩/});
 await expect(action).toContainText('切换账号');
 expect(await automatic.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
 expect(await table.evaluate(el=>el.scrollWidth<=el.parentElement!.clientWidth+1)).toBe(true);
 await action.click();
 const edit=page.getByRole('dialog',{name:'编辑自动规则 1'});
 await expect(edit.getByLabel('触发条件 1数值')).toHaveValue('0');
 await edit.getByLabel('触发条件 1数值').fill('15');
 await page.keyboard.press('Escape');
 await expect(edit).toHaveCount(0);
 await expect(platform).toBeVisible();
 await expect(table.getByRole('row').nth(1)).toContainText('账号额度剩余 ≤ 0%');
 const open=table.getByRole('button',{name:/编辑自动规则 1/});
 await open.press('Enter');
 await expect(edit.getByLabel('触发条件 1数值')).toHaveValue('0');
 await edit.getByRole('button',{name:'取消',exact:true}).click();
 await expect(open).toBeFocused();
 await page.setViewportSize({width:1280,height:720});
 await expect(table.getByRole('row').nth(1)).toContainText('账号额度剩余 ≤ 0%');
 await platform.getByRole('button',{name:'保存发送保护规则'}).click();
 await expect(platform.getByText('发送保护规则已保存')).toBeVisible();
 const saved=await (await page.request.get('/api/settings')).json();
 expect(JSON.parse(saved.settings.conversation_send_guard).automatic_rules).toEqual([
  {action:'brief',target:'available_account',conditions:{operator:'and',conditions:[{type:'account_remaining_percent',value:0}]}},
 ]);

});
