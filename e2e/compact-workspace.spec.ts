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
  const labels = ['jira','UI','数据运维','元数据问题修复','设计文档','Agent','日志','英文文档',
    ...Array.from({ length: 16 }, (_, index) => `并行任务 ${index + 1}`)];
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
  const projectHistoryRequests = new Set<string>();
  page.on('request', request => {
    const url = new URL(request.url());
    const projectId = url.searchParams.get('project_id');
    if (request.method() === 'GET' && url.pathname === '/api/sessions' && projectId) {
      projectHistoryRequests.add(projectId);
    }
  });
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
  expect([...projectHistoryRequests]).toEqual([projects[0].id]);
  const secondHistory = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/sessions' && url.searchParams.get('project_id') === projects[1].id;
  });
  await projectTabs.getByRole('button', { name: 'backuprestore', exact: true }).click();
  expect((await secondHistory).ok()).toBe(true);
  await projectTabs.getByRole('button', { name: 'dolphindb_manager', exact: true }).click();
  await expect(sessions.getByRole('button', { name: '界面设计', exact: true })).toBeVisible();
  const secondProject = projectTabs.locator('.workspace-tab').filter({ hasText: 'backuprestore' });
  const closeProject = secondProject.getByTitle('Close tab');
  let releaseCheck!: () => void;
  const pendingCheck = new Promise<void>(resolve => { releaseCheck = resolve; });
  await page.route(url => url.pathname === '/api/sessions' && !url.search, async route => {
    await pendingCheck;
    await route.continue();
  });
  try {
    await secondProject.getByRole('button', { name: 'backuprestore', exact: true }).click();
    await closeProject.click();
    await expect(closeProject).toHaveAttribute('aria-busy', 'true');
    await projectTabs.getByRole('button', { name: 'dolphindb_manager', exact: true }).click();
  } finally {
    releaseCheck();
  }
  await expect(secondProject).toHaveCount(0);
  await expect(sessions.getByRole('button', { name: '界面设计', exact: true })).toBeVisible();
  await page.mouse.move(1200,300);
  await page.screenshot({path:testInfo.outputPath('compact-workspace-desktop.png')});
  await page.setViewportSize({width:390,height:844});
  await expect(sessions.getByRole('button',{name:'jira',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  expect(await sessions.evaluate(element=>element.scrollWidth>element.clientWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('compact-workspace-mobile.png')});

  const switcher = page.getByRole('button', { name: '切换会话', exact: true });
  const createSession = page.getByRole('button', { name: '新建会话', exact: true });
  await expect(switcher).toBeInViewport();
  await expect(createSession).toBeInViewport();
  await expect(sessions.getByRole('button', { name: '并行任务 16', exact: true })).not.toBeInViewport();
  await switcher.click();
  const dialog = page.getByRole('dialog', { name: '切换会话', exact: true });
  const search = dialog.getByRole('searchbox', { name: '搜索会话' });
  await expect(search).toBeFocused();
  await expect(dialog.getByRole('button', { name: '界面设计', exact: true })).toHaveAttribute('aria-current', 'true');
  await search.fill('并行任务 16');
  await search.press('Enter');
  await expect(dialog).toHaveCount(0);
  const destination = sessions.getByRole('button', { name: '并行任务 16', exact: true });
  await expect(destination.locator('..')).toHaveAttribute('data-active', 'true');
  await expect(destination).toBeInViewport();
  await expect(switcher).toBeInViewport();
  await expect(createSession).toBeInViewport();

  await switcher.click();
  await search.fill('missing-tab');
  await expect(dialog.getByText('没有匹配的会话')).toBeVisible();
  await search.press('Escape');
  await expect(switcher).toBeFocused();
});
