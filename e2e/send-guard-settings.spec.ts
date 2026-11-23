import {expect,test} from '@playwright/test';

test('shows complete rules per row and edits Provider scope in the centered editor on desktop and mobile',async({page})=>{
 const auth=await (await page.request.get('/api/auth/status')).json();
 const login=await page.request.post(auth.needsSetup?'/api/auth/setup':'/api/auth/login',{data:{username:'e2e-admin',password:'test-password'}});
 expect(login.ok()).toBe(true);
 await page.request.put('/api/settings',{data:{settings:{statusline_prompted:'true',app_theme:'light'}}});
 await page.route('**/api/agent-management',route=>route.fulfill({json:{agents:[
  {agent:{id:'codex',label:'Codex'},state:{providers:[{id:'native',name:'本机'},{id:'backup',name:'备用'}]}},
  {agent:{id:'claude',label:'Claude'},state:{providers:[{id:'anthropic',name:'Anthropic'}]}},
 ]}}));
 await page.goto('/');
 await page.getByTitle('My account',{exact:true}).click();
 const platform=page.getByRole('dialog',{name:'平台管理',exact:true});
 await platform.getByRole('button',{name:'平台设置',exact:true}).click();
 await platform.getByRole('button',{name:'发送保护',exact:true}).click();

 const table=platform.getByRole('table',{name:'发送保护规则'});
 await expect(platform.getByRole('table')).toHaveCount(1);
 await expect(table.getByRole('row')).toHaveCount(2);
 await expect(table.getByRole('cell',{name:'全部 Provider',exact:true})).toBeVisible();
 await expect(table.getByRole('cell',{name:'发送提醒',exact:true})).toBeVisible();
 await expect(platform.getByRole('spinbutton')).toHaveCount(0);
 await page.setViewportSize({width:1280,height:720});
 const reminderOpen=table.getByRole('button',{name:/编辑规则 1/});
 await reminderOpen.press('Enter');
 const reminder=page.getByRole('dialog',{name:'编辑规则 1'});
 await expect(reminder.getByLabel('触发条件 1数值')).toHaveValue('80');
 await expect(reminder.getByRole('button',{name:'触发条件组合方式'})).toHaveText('或');
 const desktopBox=(await reminder.boundingBox())!;
 expect(desktopBox.width).toBeGreaterThanOrEqual(740);
 const idle=(await reminder.getByLabel('触发条件 2分组 1',{exact:true}).boundingBox())!;
 const occupancy=(await reminder.getByLabel('触发条件 2分组 2',{exact:true}).boundingBox())!;
 expect(Math.abs(idle.y-occupancy.y)).toBeLessThan(2);
 await page.setViewportSize({width:390,height:844});
 for(const [index,[minutes,percent]] of [[30,30],[20,50],[10,60],[60,20]].entries()){
  const branch=reminder.getByRole('region',{name:`触发条件 ${index+2}分组`});
  await expect(branch.getByLabel(`触发条件 ${index+2}分组 1数值`)).toHaveValue(String(minutes));
  await expect(branch.getByLabel(`触发条件 ${index+2}分组 2数值`)).toHaveValue(String(percent));
 }
 const box=(await reminder.boundingBox())!;
 expect(box.width).toBeLessThanOrEqual(366);
 expect(await reminder.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
 expect(Math.abs(box.x+box.width/2-195)).toBeLessThan(2);
 expect(Math.abs(box.y+box.height/2-422)).toBeLessThan(2);
 await reminder.getByLabel('Provider 范围').selectOption('selected');
 await expect(reminder.getByRole('button',{name:'应用到表格'})).toBeDisabled();
 await reminder.getByLabel('Codex · 本机').check();
 await reminder.getByLabel('Claude · Anthropic').check();
 await reminder.getByLabel('触发条件 2分组 2数值').fill('35');
 await reminder.getByRole('button',{name:'应用到表格'}).click();
 await expect(reminderOpen).toBeFocused();
 await expect(table.getByRole('row')).toHaveCount(2);
 await expect(table.getByRole('cell',{name:/Codex · 本机、Claude · Anthropic/})).toBeVisible();
 expect(await table.evaluate(el=>el.scrollWidth<=el.parentElement!.clientWidth+1)).toBe(true);

 await platform.getByRole('button',{name:'添加规则'}).click();
 const add=page.getByRole('dialog',{name:'添加规则'});
 await add.getByLabel('执行动作').selectOption('brief');
 await add.getByLabel('换到有剩余额度的账号').check();
 await add.getByLabel('触发条件 1',{exact:true}).selectOption('account_remaining_percent');
 await add.getByLabel('Provider 范围').selectOption('selected');
 await add.getByLabel('Codex · 备用').check();
 expect(await add.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
 await add.getByRole('button',{name:'应用到表格'}).click();
 await expect(table.getByRole('row')).toHaveCount(3);
 const action=table.getByRole('cell',{name:/简要压缩/});
 await expect(action).toContainText('切换账号');
 await action.click();
 const edit=page.getByRole('dialog',{name:'编辑规则 1'});
 await expect(edit.getByLabel('触发条件 1数值')).toHaveValue('0');
 await edit.getByLabel('触发条件 1数值').fill('15');
 await page.keyboard.press('Escape');
 await expect(edit).toHaveCount(0);
 await expect(platform).toBeVisible();
 await expect(table.getByRole('row').nth(1)).toContainText('账号额度剩余 ≤ 0%');

 await page.setViewportSize({width:1280,height:720});
 await platform.getByRole('button',{name:'保存发送保护规则'}).click();
 await expect(platform.getByText('发送保护规则已保存')).toBeVisible();
 const saved=await (await page.request.get('/api/settings')).json();
 const policy=JSON.parse(saved.settings.conversation_send_guard);
 expect(policy.rules[0]).toEqual({action:'brief',target:'available_account',provider_ids:['codex:backup'],conditions:{operator:'and',conditions:[{type:'account_remaining_percent',value:0}]}});
 expect(policy.rules[1]).toMatchObject({action:'remind',provider_ids:['codex:native','claude:anthropic'],conditions:{operator:'or'}});
 expect(policy.rules[1].conditions.conditions).toHaveLength(5);
 expect(policy.rules[1].conditions.conditions[1]).toEqual({operator:'and',conditions:[{type:'idle_minutes',value:30},{type:'context_percent',value:35}]});
});
