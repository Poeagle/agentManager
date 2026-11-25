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
    ...Array.from({ length: 28 }, (_, index) => `并行任务 ${index + 1}`)];
  const now = new Date().toISOString();
  // Native CLI processes are unnecessary for checking saved workspace navigation.
  try {
    const environment = db.prepare('INSERT INTO agent_environments (id, agent_id, name, kind, config, allowed_user_ids) VALUES (?, ?, ?, ?, ?, ?)');
    environment.run('native', 'codex', '本机账号', 'native', '{}', null);
    environment.run('account:review', 'codex', '界面审查账号', 'account', JSON.stringify({
      username: 'review', port: 22, identityFile: '', codexCommand: 'codex', codexHome: '',
    }), JSON.stringify([user.id]));
    for (const [index,label] of labels.entries()) db.prepare(`INSERT INTO sessions
      (id,project_id,task,status,mode,cli_type,created_by_user_id,created_at,updated_at,completed_at)
      VALUES (?,? ,? ,?,'session',?,?,?, ?,?)`)
      .run(`compact-${index}`,projects[0].id,label,index===2?'failed':'completed',index%2?'claude':'codex',user.id,now,now,now);
    db.prepare('UPDATE sessions SET cli_type=?, agent_environment_id=? WHERE id=?')
      .run('codex', 'account:review', 'compact-23');
    db.prepare(`INSERT INTO sessions
      (id,project_id,task,status,mode,cli_type,created_by_user_id,created_at,updated_at,completed_at)
      VALUES (?, ?, ?, 'completed', 'session', 'claude', ?, ?, ?, ?)`)
      .run('compact-backup',projects[1].id,'备份验证',user.id,now,now,now);
  } finally {db.close();}
  const schedule = await page.request.post('/api/scheduled-tasks', { data: {
    project_id: projects[0].id, target_type: 'existing', target_session_id: 'compact-23',
    name: '会话绑定验证', prompt: 'fixture', schedule_kind: 'daily', schedule_value: '09:00', timezone: 'UTC', enabled: false,
  } });
  expect(schedule.ok()).toBeTruthy();
  await page.request.put('/api/user-state/app',{data:{value:{projectTabs:projects.map(project=>({projectId:project.id,projectName:project.name})),activeTab:`project-${projects[0].id}`}}});
  await page.request.put(`/api/user-state/${encodeURIComponent(`project:${projects[0].id}`)}`,{data:{value:{
    activeMode:'terminal',terminalInstances:labels.map((label,index)=>({id:`compact-${index}`,label,customLabel:label})),
    terminalLabels:Object.fromEntries(labels.map((label,index)=>[`compact-${index}`,label])),activeTerminalId:'compact-0',explorerInstances:[],hiddenSessionIds:[],
  }}});
  await page.request.put(`/api/user-state/${encodeURIComponent(`project:${projects[1].id}`)}`,{data:{value:{
    activeMode:'terminal',terminalInstances:[{id:'compact-backup',label:'备份验证',customLabel:'备份验证'}],
    terminalLabels:{'compact-backup':'备份验证'},activeTerminalId:'compact-backup',explorerInstances:[],hiddenSessionIds:[],
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
  const firstBranch = projectTabs.locator('.workspace-project-item').filter({has:page.getByRole('button',{name:'dolphindb_manager',exact:true})});
  const sessions = firstBranch.getByRole('navigation',{name:'会话标签'});
  await expect(sessions.getByRole('button',{name:'jira',exact:true})).toBeVisible();
  expect((await header.boundingBox())!.height).toBe(32);
  const projectRows = projectTabs.locator('.workspace-project-row');
  const firstProject = (await projectRows.nth(0).boundingBox())!;
  const secondProjectRow = (await projectRows.nth(1).boundingBox())!;
  expect(firstProject.x).toBe(secondProjectRow.x);
  expect(secondProjectRow.y).toBeGreaterThan(firstProject.y);
  const toolbar = page.getByRole('toolbar', { name: '项目工具栏' });
  const toolBounds = await Promise.all((await toolbar.getByRole('button').all()).map(button => button.boundingBox()));
  expect(toolBounds).toHaveLength(6);
  expect(toolBounds.every(box => box?.y === toolBounds[0]?.y)).toBe(true);
  expect(toolBounds.at(-1)!.x).toBeGreaterThan(toolBounds[0]!.x);
  expect(toolBounds[0]!.y).toBeLessThan((await header.boundingBox())!.height);
  const sessionRows = sessions.locator('.workspace-tab');
  await expect(sessionRows).toHaveCount(5);
  expect((await sessionRows.first().boundingBox())!.x).toBeGreaterThan(firstProject.x);
  expect(secondProjectRow.y).toBeGreaterThan((await sessionRows.last().boundingBox())!.y);
  await firstBranch.getByRole('button',{name:'展开其余 31 个会话'}).click();
  await expect(sessionRows).toHaveCount(36);
  const scheduledRow = sessions.locator('[data-session-id="compact-23"]');
  await expect(scheduledRow.getByText('定时', { exact: true })).toBeVisible();
  await expect(scheduledRow.getByText('界面审查账号', { exact: true })).toBeVisible();
  await expect(scheduledRow.getByRole('button', { name: '并行任务 16 定时' })).toHaveAccessibleDescription('账号：界面审查账号');
  const accountBounds = (await scheduledRow.getByText('界面审查账号', { exact: true }).boundingBox())!;
  const scheduledBounds = (await scheduledRow.getByText('定时', { exact: true }).boundingBox())!;
  expect(accountBounds.x + accountBounds.width).toBeLessThan(scheduledBounds.x);
  expect(accountBounds.y).toBe(scheduledBounds.y);
  await expect(sessions.getByRole('button', { name: 'jira', exact: true }).getByText('本机账号', { exact: true })).toBeVisible();
  await expect(sessions.getByText('定时', { exact: true })).toHaveCount(1);
  const firstRow = (await sessionRows.nth(0).boundingBox())!;
  const secondRow = (await sessionRows.nth(1).boundingBox())!;
  expect(firstRow.x).toBe(secondRow.x);
  expect(secondRow.y).toBeGreaterThan(firstRow.y);
  expect(await projectTabs.locator('.workspace-project-tabs').evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
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
  await tab.getByRole('button',{name:'jira',exact:true}).focus();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await expect(close).toHaveCSS('opacity','1');
  await page.keyboard.press('Tab');
  await expect(sessions.getByRole('button',{name:'UI',exact:true})).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(sessions.getByRole('button',{name:'UI',exact:true}).locator('..')).toHaveAttribute('data-active','true');
  await sessions.getByRole('button',{name:'UI',exact:true}).dblclick();
  const rename = sessions.getByRole('textbox');
  const renamed = page.waitForResponse(response => {
    const request = response.request();
    return request.method() === 'PUT'
      && decodeURIComponent(new URL(response.url()).pathname) === `/api/user-state/project:${projects[0].id}`
      && request.postDataJSON().value?.terminalLabels?.['compact-1'] === '界面设计';
  });
  await rename.fill('界面设计'); await rename.press('Enter');
  await expect(sessions.getByRole('button',{name:'界面设计',exact:true})).toBeVisible();
  expect((await renamed).ok()).toBe(true);
  expect([...projectHistoryRequests]).toEqual([projects[0].id]);
  const secondHistory = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/sessions' && url.searchParams.get('project_id') === projects[1].id;
  });
  const secondBranch = projectTabs.locator('.workspace-project-item').filter({has:page.getByRole('button',{name:'backuprestore',exact:true})});
  const secondProjectButton = secondBranch.getByRole('button',{name:'backuprestore',exact:true});
  await secondBranch.getByRole('button',{name:'展开 backuprestore 的会话'}).click();
  expect((await secondHistory).ok()).toBe(true);
  await expect(secondProjectButton).not.toHaveAttribute('aria-current','page');
  const backupSession = secondBranch.getByRole('button',{name:'备份验证',exact:true});
  await backupSession.click();
  await expect(secondProjectButton).toHaveAttribute('aria-current','page');
  await expect(backupSession).toHaveAttribute('aria-current','true');
  await expect(firstBranch.getByRole('button',{name:'收起 dolphindb_manager 的会话'})).toHaveAttribute('aria-expanded','true');
  await expect(sessionRows).toHaveCount(36);
  await page.reload();
  await expect(secondProjectButton).toHaveAttribute('aria-current','page');
  await expect(backupSession).toHaveAttribute('aria-current','true');
  await expect(sessionRows).toHaveCount(36);
  await secondBranch.getByRole('button',{name:'收起 backuprestore 的会话'}).click();
  await expect(backupSession).toBeHidden();
  await projectTabs.getByRole('button', { name: 'dolphindb_manager', exact: true }).click();
  await expect(sessions.getByRole('button', { name: '界面设计', exact: true })).toBeVisible();
  const secondProject = projectRows.filter({ hasText: 'backuprestore' });
  const closeProject = secondProject.getByTitle('Close tab');
  let releaseCheck!: () => void;
  const pendingCheck = new Promise<void>(resolve => { releaseCheck = resolve; });
  await page.route(url => url.pathname === '/api/sessions' && !url.search, async route => {
    await pendingCheck;
    await route.continue();
  });
  try {
    await secondProject.getByRole('button', { name: 'backuprestore', exact: true }).click();
    await expect(secondBranch.getByRole('button',{name:'展开 backuprestore 的会话'})).toHaveAttribute('aria-expanded','false');
    await expect(backupSession).toBeHidden();
    await closeProject.click();
    await expect(closeProject).toHaveAttribute('aria-busy', 'true');
    await projectTabs.getByRole('button', { name: 'dolphindb_manager', exact: true }).click();
  } finally {
    releaseCheck();
  }
  await expect(secondProject).toHaveCount(0);
  await expect(sessions.getByRole('button', { name: '界面设计', exact: true })).toBeVisible();
  const sidebar = firstBranch.getByRole('complementary', { name: '会话列表' });
  const workspaceNav = page.getByRole('complementary', { name: '工作区导航' });
  await expect(workspaceNav.getByRole('complementary', { name: '会话列表' })).toBeVisible();
  expect((await sidebar.boundingBox())!.y).toBeGreaterThan((await projectTabs.boundingBox())!.y);
  const separator = page.getByRole('separator', { name: '调整工作区导航宽度' });
  const beforeResize = Number(await separator.getAttribute('aria-valuenow'));
  const handle = (await separator.boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + 64, handle.y + handle.height / 2, { steps: 8 });
  await page.mouse.up();
  const draggedWidth = Number(await separator.getAttribute('aria-valuenow'));
  expect(draggedWidth).toBeGreaterThan(beforeResize + 55);
  await separator.press('ArrowRight');
  const savedWidth = draggedWidth + 16;
  await expect(separator).toHaveAttribute('aria-valuenow', String(savedWidth));
  await page.reload();
  await expect(separator).toHaveAttribute('aria-valuenow', String(savedWidth));
  await expect(sessionRows).toHaveCount(36);
  const desktopSearch = sidebar.getByRole('searchbox', { name: '搜索会话' });
  await expect(desktopSearch).toBeHidden();
  await sidebar.getByRole('button', { name: '搜索会话', exact: true }).click();
  await expect(desktopSearch).toBeFocused();
  await desktopSearch.fill('并行任务 28');
  await expect(sessionRows).toHaveCount(1);
  await desktopSearch.press('Enter');
  await expect(desktopSearch).toBeHidden();
  const destination = sessions.getByRole('button', { name: '并行任务 28', exact: true });
  await expect(destination.locator('..')).toHaveAttribute('data-active', 'true');
  await expect(destination).toBeInViewport();
  await page.getByRole('button', { name: '收起会话列表' }).click();
  await expect(sidebar).toBeHidden();
  await page.getByRole('button', { name: '展开会话列表' }).click();
  await expect(destination).toBeInViewport();
  await page.mouse.move(1200,300);
  await page.screenshot({path:testInfo.outputPath('compact-workspace-desktop.png')});
  await page.setViewportSize({width:390,height:844});
  await expect(sidebar).toBeHidden();
  await expect(projectTabs).toBeHidden();
  const mobileProjects = page.getByRole('button', { name: '项目导航', exact: true });
  await mobileProjects.click();
  await expect(projectTabs.getByRole('button', { name: 'dolphindb_manager', exact: true })).toBeVisible();
  await expect(destination).toBeVisible();
  await page.screenshot({path:testInfo.outputPath('compact-workspace-mobile.png')});
  await destination.click();
  await expect(projectTabs).toBeHidden();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);

  const switcher = page.getByRole('button', { name: '切换会话', exact: true });
  const createSession = page.getByRole('button', { name: '新建会话', exact: true });
  await expect(switcher).toBeInViewport();
  await expect(createSession).toBeInViewport();
  await switcher.click();
  const dialog = page.getByRole('dialog', { name: '切换会话', exact: true });
  const search = dialog.getByRole('searchbox', { name: '搜索会话' });
  await expect(search).toBeFocused();
  await expect(dialog.getByRole('button', { name: '并行任务 28', exact: true })).toHaveAttribute('aria-current', 'true');
  await search.fill('并行任务 16');
  await search.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(switcher).toBeInViewport();
  await expect(createSession).toBeInViewport();

  await switcher.click();
  const scheduledResult = dialog.getByRole('button', { name: '并行任务 16 定时', exact: true });
  await expect(scheduledResult).toHaveAttribute('aria-current', 'true');
  await expect(scheduledResult.getByText('界面审查账号', { exact: true })).toBeVisible();
  await search.fill('missing-tab');
  await expect(dialog.getByText('没有匹配的会话')).toBeVisible();
  await search.press('Escape');
  await expect(switcher).toBeFocused();
});

test('keeps a created tab below its parent after refresh and visible when the parent closes', async ({ page }) => {
  const status = await (await page.request.get('/api/auth/status')).json();
  const login = await page.request.post(status.needsSetup ? '/api/auth/setup' : '/api/auth/login', {
    data: { username: 'e2e-admin', password: 'test-password' },
  });
  expect(login.ok()).toBeTruthy();
  const { user } = await login.json();
  const root = join(process.cwd(), '.test-data', 'e2e');
  const projectPath = join(root, 'tab-lineage');
  mkdirSync(projectPath, { recursive: true });
  const { project } = await (await page.request.post('/api/projects', {
    data: { name: 'Tab lineage', path: projectPath },
  })).json();
  const Database = createRequire(import.meta.url)('../server/node_modules/better-sqlite3');
  const db = new Database(join(root, 'agentmanager.db'));
  const tabs = [
    { id: 'lineage-parent', label: '委派者', parent: null },
    { id: 'lineage-child', label: '验证子任务', parent: 'lineage-parent' },
    { id: 'lineage-grandchild', label: '回归子任务', parent: 'lineage-child' },
    { id: 'lineage-peer', label: '独立会话', parent: null },
  ];
  try {
    const insert = db.prepare(`INSERT INTO sessions(id,project_id,created_by_user_id,task,status,cli_type,parent_session_id,updated_at)
      VALUES(?,?,?,?,'completed','codex',?,?)`);
    tabs.forEach(({ id, label, parent }, index) => {
      insert.run(id, project.id, user.id, label, parent, `2026-01-01T00:00:0${index}.000Z`);
    });
  } finally { db.close(); }
  await page.request.put('/api/settings', { data: { settings: { statusline_prompted: 'true' } } });
  await page.request.put('/api/user-state/app', {
    data: { value: { projectTabs: [{ projectId: project.id, projectName: project.name }], activeTab: `project-${project.id}` } },
  });
  await page.request.put(`/api/user-state/project%3A${project.id}`, {
    data: { value: { terminalInstances: tabs.map(({ id, label }) => ({ id, label, customLabel: label })), activeTerminalId: 'lineage-child' } },
  });

  await page.goto('/');
  const nav = page.getByRole('navigation', { name: '会话标签' }).filter({ visible: true });
  const parent = nav.locator('[data-session-id="lineage-parent"]');
  const child = nav.locator('[data-session-id="lineage-child"]');
  const grandchild = nav.locator('[data-session-id="lineage-grandchild"]');
  await expect(parent).toBeVisible();
  await expect(child).toHaveAttribute('data-parent-session-id', 'lineage-parent');
  await expect(grandchild).toHaveAttribute('data-parent-session-id', 'lineage-child');
  expect((await child.boundingBox())!.y).toBeGreaterThan((await parent.boundingBox())!.y);
  expect((await child.boundingBox())!.x).toBeGreaterThan((await parent.boundingBox())!.x);
  expect((await grandchild.boundingBox())!.x).toBeGreaterThan((await child.boundingBox())!.x);

  await page.reload();
  await expect(child).toBeVisible();
  expect((await child.boundingBox())!.x).toBeGreaterThan((await parent.boundingBox())!.x);
  await parent.getByRole('button', { name: 'Close session' }).click();
  await page.getByRole('button', { name: '停止并关闭', exact: true }).click();
  await expect(parent).toHaveCount(0);
  await expect(child.getByTitle('由其他标签页创建，上级当前未打开')).toBeVisible();
  await expect(grandchild).toBeVisible();
});
