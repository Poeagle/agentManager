import {test,expect} from '@playwright/test';
import {mkdirSync} from 'fs';
import {join} from 'path';

test('cancel retains a tab, stopping preserves history and deleting removes the running session permanently',async({page},testInfo)=>{
  const auth=await(await page.request.get('/api/auth/status')).json();expect((await page.request.post(auth.needsSetup?'/api/auth/setup':'/api/auth/login',{data:{username:'e2e-admin',password:'test-password'}})).ok()).toBeTruthy();
  const path=join(process.cwd(),'.test-data/e2e/close-action-project');mkdirSync(path,{recursive:true});const {project}=await(await page.request.post('/api/projects',{data:{name:'关闭操作验证',path}})).json();
  const create=async()=>{const response=await page.request.post('/api/sessions',{data:{project_id:project.id,project_path:path,mode:'terminal'}});expect(response.ok()).toBe(true);return (await response.json()).session;};
  const stopped=await create(),deleted=await create();
  await page.request.put('/api/settings',{data:{settings:{statusline_prompted:'true',app_theme:'light'}}});await page.request.put('/api/user-state/app',{data:{value:{projectTabs:[{projectId:project.id,projectName:project.name}],activeTab:`project-${project.id}`}}});
  await page.request.put(`/api/user-state/${encodeURIComponent(`project:${project.id}`)}`,{data:{value:{terminalInstances:[{id:stopped.id,label:'保留历史'},{id:deleted.id,label:'删除记录'}],activeTerminalId:stopped.id,explorerInstances:[],hiddenSessionIds:[]}}});
  await page.goto('/');const tabs=page.getByLabel('会话标签',{exact:true});await expect(tabs.getByTitle('Close session')).toHaveCount(2);
  await tabs.getByTitle('Close session').first().click();let dialog=page.getByRole('dialog');await expect(dialog.getByRole('button',{name:'取消',exact:true})).toBeFocused();await expect(dialog).not.toContainText('隐藏');await dialog.getByRole('button',{name:'取消',exact:true}).click();await expect(tabs.getByTitle('Close session')).toHaveCount(2);
  await tabs.getByTitle('Close session').first().click();dialog=page.getByRole('dialog');await page.screenshot({path:testInfo.outputPath('close-options.png')});await dialog.getByRole('button',{name:'停止并关闭',exact:true}).click();await expect(dialog).toHaveCount(0);await expect(tabs.getByTitle('Close session')).toHaveCount(1);
  let record=await page.request.get(`/api/sessions/${stopped.id}`);expect(record.ok()).toBe(true);expect((await record.json()).session.status).toBe('cancelled');
  await tabs.getByTitle('Close session').click();await page.getByRole('dialog').getByRole('button',{name:'删除会话',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);expect((await page.request.get(`/api/sessions/${deleted.id}`)).status()).toBe(404);
  await page.reload();await expect(tabs.getByTitle('Close session')).toHaveCount(0);const list=await(await page.request.get(`/api/sessions?project_id=${project.id}`)).json();expect(list.sessions.some((s:{id:string})=>s.id===stopped.id)).toBe(true);expect(list.sessions.some((s:{id:string})=>s.id===deleted.id)).toBe(false);
  await page.request.delete(`/api/sessions/${stopped.id}/record`);
});
