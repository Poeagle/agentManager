import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

test('compact workspace preserves readable labels, activity details and keyboard controls', async ({page}, testInfo) => {
  await page.setViewportSize({width:1440,height:900});
  const status = await (await page.request.get('/api/auth/status')).json();
  const auth = await page.request.post(status.needsSetup ? '/api/auth/setup' : '/api/auth/login', {data:{username:'e2e-admin',password:'test-password'}});
  expect(auth.ok()).toBeTruthy();
  const {user} = await auth.json();
  await page.request.put('/api/settings',{data:{settings:{statusline_prompted:'true',app_theme:'light'}}});
  const projects: Array<{id:string;name:string}> = [];
  for (const name of ['dolphindb_manager','backuprestore','octoally-app','xeleQuote','modulepublish']) {
    const path = join(process.cwd(),'.test-data','e2e','compact',name);
    mkdirSync(path,{recursive:true});
    const response = await page.request.post('/api/projects',{data:{name,path}});
    expect(response.ok()).toBeTruthy(); projects.push((await response.json()).project);
  }
  const require = createRequire(import.meta.url);
  const Database = require('../server/node_modules/better-sqlite3');
  const db = new Database(join(process.cwd(),'.test-data','e2e','agentmanager.db'));
  const labels = ['jira','UI','数据运维','元数据问题修复','设计文档','Agent','日志','英文文档'];
  const now = new Date().toISOString();
  // Native CLI processes are unnecessary for checking saved workspace navigation.
  try {
    for (const [index,label] of labels.entries()) db.prepare(`INSERT INTO sessions
      (id,project_id,task,status,mode,cli_type,created_by_user_id,created_at,updated_at,completed_at)
      VALUES (?,? ,? ,?,'session',?,?,?, ?,?)`)
      .run(`compact-${index}`,projects[0].id,label,index===2?'failed':'completed',index%2?'claude':'codex',user.id,now,now,now);
  } finally {db.close();}
  await page.request.put('/api/user-state/app',{data:{value:{projectTabs:projects.map(project=>({projectId:project.id,projectName:project.name})),activeTab:`project-${projects[0].id}`}}});
  await page.request.put(`/api/user-state/${encodeURIComponent(`project:${projects[0].id}`)}`,{data:{value:{
    activeMode:'terminal',terminalInstances:labels.map((label,index)=>({id:`compact-${index}`,label,customLabel:label})),
    terminalLabels:Object.fromEntries(labels.map((label,index)=>[`compact-${index}`,label])),activeTerminalId:'compact-0',explorerInstances:[],hiddenSessionIds:[],
  }}});
  await page.goto('/');
  const header = page.locator('.workspace-header');
  const projectTabs = page.getByRole('navigation',{name:'项目标签'});
  const sessions = page.getByLabel('会话标签',{exact:true}).filter({visible:true});
  await expect(sessions.getByRole('button',{name:'jira',exact:true})).toBeVisible();
  expect((await header.boundingBox())!.height).toBe(32);
  expect((await projectTabs.boundingBox())!.height).toBe(28);
  expect((await sessions.boundingBox())!.height).toBe(28);
  expect((await page.getByLabel('项目工具栏',{exact:true}).filter({visible:true}).boundingBox())!.width).toBe(36);
  expect((await sessions.boundingBox())!.y + (await sessions.boundingBox())!.height).toBeLessThanOrEqual(90);
  expect(await sessions.getByText('jira',{exact:true}).evaluate(element=>getComputedStyle(element.parentElement!).fontSize)).toBe('12px');
  expect(await sessions.locator('.workspace-tab').first().locator('svg').count()).toBe(2); // Agent + close, with a separate status dot.
  await expect(sessions.getByText('jira',{exact:true})).toHaveAttribute('title',/最后活跃：/);
  await expect(projectTabs.getByText('dolphindb_manager',{exact:true})).toHaveAttribute('title',/最后活跃：/);
  await expect(sessions.locator('[title="Codex 原生状态未知"]').first()).toBeVisible();
  await expect(sessions.getByText(/· (刚刚|\d+[分时天])/)).toHaveCount(0);
  const tab = sessions.locator('.workspace-tab').first();
  const bounds = await tab.boundingBox();
  await tab.hover();
  expect(await tab.boundingBox()).toEqual(bounds);
  const close = tab.getByRole('button',{name:'Close session'});
  await close.focus();
  await expect(close).toHaveCSS('opacity','1');
  await page.keyboard.press('Tab');
  await expect(sessions.getByRole('button',{name:'UI',exact:true})).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(sessions.getByRole('button',{name:'UI',exact:true}).locator('..')).toHaveAttribute('data-active','true');
  await sessions.getByRole('button',{name:'UI',exact:true}).dblclick();
  const rename = sessions.getByRole('textbox');
  await rename.fill('界面设计'); await rename.press('Enter');
  await expect(sessions.getByRole('button',{name:'界面设计',exact:true})).toBeVisible();
  await page.mouse.move(1200,300);
  await page.screenshot({path:testInfo.outputPath('compact-workspace-desktop.png')});
  await page.setViewportSize({width:390,height:844});
  await expect(sessions.getByRole('button',{name:'jira',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  expect(await sessions.evaluate(element=>element.scrollWidth>element.clientWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('compact-workspace-mobile.png')});
});
