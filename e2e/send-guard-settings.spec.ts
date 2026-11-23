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
 const table=platform.getByRole('table',{name:'发送保护规则'});
 await expect(platform.getByRole('table')).toHaveCount(1);
 await expect(platform.getByLabel('提醒条件组合')).toHaveValue('or');
 await expect(table.getByRole('cell',{name:'发送提醒',exact:true})).toHaveCount(5);
 await expect(table.getByRole('row')).toHaveCount(6);
 await expect(table.getByRole('row').nth(1)).toContainText('窗口占用率 ≥ 80%');
 for(const [index,[minutes,percent]] of [[30,30],[20,50],[10,60],[60,20]].entries()){
  await expect(table.getByRole('row').nth(index+2)).toContainText(`闲置时间 ≥ ${minutes} 分钟 且 窗口占用率 ≥ ${percent}%`);
 }
 await expect(platform.getByRole('spinbutton')).toHaveCount(0);
 await page.setViewportSize({width:390,height:844});
 const reminderOpen=table.getByRole('button',{name:/编辑提醒条件 2/});
 await reminderOpen.press('Enter');
 const reminder=page.getByRole('dialog',{name:'编辑提醒条件 2'});
 await expect(reminder.getByLabel('触发条件 1数值')).toHaveValue('30');
 const reminderBox=(await reminder.boundingBox())!;
 expect(Math.abs(reminderBox.x+reminderBox.width/2-195)).toBeLessThan(2);
 expect(Math.abs(reminderBox.y+reminderBox.height/2-422)).toBeLessThan(2);
 await expect(reminder.getByRole('button',{name:'触发条件组合方式'})).toHaveText('且');
 await reminder.getByRole('button',{name:'触发条件连接方式'}).click();
 await reminder.getByLabel('触发条件 2数值').fill('35');
 await reminder.getByRole('button',{name:'应用到表格'}).click();
 await expect(table.getByRole('row').nth(2)).toContainText('闲置时间 ≥ 30 分钟 或 窗口占用率 ≥ 35%');
 await expect(reminderOpen).toBeFocused();
 await platform.getByLabel('启用发送提醒').uncheck();
 await expect(table.getByText('已停用',{exact:true})).toHaveCount(5);
 await platform.getByLabel('启用发送提醒').check();
 await platform.getByRole('button',{name:'添加自动规则'}).click();
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
 await expect(table.getByRole('row')).toHaveCount(7);
 const action=table.getByRole('cell',{name:/简要压缩/});
 await expect(action).toContainText('切换账号');
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
 const policy=JSON.parse(saved.settings.conversation_send_guard);
 expect(policy.conditions.operator).toBe('or');
 expect(policy.conditions.conditions[1]).toEqual({operator:'or',conditions:[{type:'idle_minutes',value:30},{type:'context_percent',value:35}]});
 expect(policy.automatic_rules).toEqual([
  {action:'brief',target:'available_account',conditions:{operator:'and',conditions:[{type:'account_remaining_percent',value:0}]}},
 ]);

});
