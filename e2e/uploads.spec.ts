import { expect, test, type Locator, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';

async function dropFile(page: Page, target: Locator, name: string, content: string) {
  const dataTransfer = await page.evaluateHandle(({ name, content }) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([content], name, { type: 'text/plain' }));
    return transfer;
  }, { name, content });
  const response=page.waitForResponse(response=>response.url().includes('/api/files/upload?')&&response.request().method()==='POST');
  await target.dispatchEvent('drop', { dataTransfer });
  await dataTransfer.dispose();
  return response;
}

test('all explorer uploads use central storage and can be previewed without changing Git', async ({ page }) => {
  const status = await (await page.request.get('/api/auth/status')).json();
  expect((await page.request.post(status.needsSetup ? '/api/auth/setup' : '/api/auth/login', {
    data: { username: 'e2e-admin', password: 'test-password' },
  })).ok()).toBeTruthy();
  const projectPath = join(process.cwd(), '.test-data', 'e2e', 'upload-project');
  const reportsPath = join(projectPath, 'reports');
  mkdirSync(reportsPath, { recursive: true });
  execFileSync('git',['init','--quiet',projectPath]);
  const gitStatus=()=>execFileSync('git',['-c','safe.directory='+projectPath,'-C',projectPath,'status','--porcelain','--untracked-files=all'],{encoding:'utf8'});
  const before=gitStatus();
  const { project } = await (await page.request.post('/api/projects', { data: { name: 'Upload Project', path: projectPath } })).json();
  await page.request.put('/api/settings', { data: { settings: { statusline_prompted: 'true' } } });
  await page.request.put('/api/user-state/app', {data:{value:{projectTabs:[{projectId:project.id,projectName:project.name}],activeTab:`project-${project.id}`}}});
  await page.goto('/');
  const sidebar = page.getByTitle('File Explorer', { exact: true });
  await expect(sidebar).toBeVisible();
  const first=await dropFile(page,sidebar,'sidebar.txt','sidebar content');
  expect(first.ok()).toBeTruthy();const firstPath=(await first.json()).path;
  expect(firstPath.startsWith(projectPath+'/')).toBe(false);expect(readFileSync(firstPath,'utf8')).toBe('sidebar content');
  expect(existsSync(join(projectPath,'sidebar.txt'))).toBe(false);expect(gitStatus()).toBe(before);
  const zone=page.getByLabel('文件上传区域').filter({visible:true}).first();
  await expect(zone.getByRole('status')).toContainText('平台目录');
  await zone.getByRole('button',{name:'查看上传文件'}).click();
  const preview=page.getByRole('dialog',{name:'目录预览 · 上传文件'});
  await preview.getByRole('button',{name:'sidebar.txt',exact:true}).click();
  await expect(preview).toContainText('sidebar content');await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);
  await page.reload();await zone.getByRole('button',{name:'查看平台上传文件',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'目录预览 · 上传文件'}).getByRole('button',{name:'sidebar.txt',exact:true})).toBeVisible();await page.keyboard.press('Escape');
  const second=await dropFile(page,zone.getByRole('button',{name:'reports',exact:true}),'数据.txt','nested content');
  expect(second.ok()).toBeTruthy();const secondPath=(await second.json()).path;
  expect(secondPath).toContain('/uploads/reports/数据.txt');expect(readFileSync(secondPath,'utf8')).toBe('nested content');
  const duplicate=await dropFile(page,sidebar,'sidebar.txt','do not overwrite');expect(duplicate.status()).toBe(409);
  expect(readFileSync(firstPath,'utf8')).toBe('sidebar content');expect(gitStatus()).toBe(before);
});
