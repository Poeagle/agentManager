import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

test('edits rendered Markdown and shows dotfiles', async ({ page }) => {
  const hookErrors: string[] = [];
  page.on('pageerror', error => {
    if (/Invalid hook call|reading 'useRef'/.test(error.message)) hookErrors.push(error.message);
  });
  page.on('console', message => {
    if (message.type() === 'error' && /Invalid hook call|reading 'useRef'/.test(message.text())) hookErrors.push(message.text());
  });
  const status = await (await page.request.get('/api/auth/status')).json();
  expect((await page.request.post(status.needsSetup ? '/api/auth/setup' : '/api/auth/login', {
    data: { username: 'e2e-admin', password: 'test-password' },
  })).ok()).toBeTruthy();

  const root = join(process.cwd(), '.test-data', 'e2e', 'markdown-visual-edit');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, '.gitignore'), 'notes.tmp\n');
  writeFileSync(join(root, 'diagram.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9hZsEAAAAASUVORK5CYII=', 'base64'));
  const markdownPath = join(root, 'README.md');
  writeFileSync(markdownPath, '---\ntitle: Example\n---\n# Guide\n\nA short note.\n\n![diagram](diagram.png)\n\n- first\n- second\n\n- [ ] todo\n\n| Name | Value |\n| --- | --- |\n| alpha | 42 |\n\n```dos\nclearCachedModules();\n```\n');

  const { project } = await (await page.request.post('/api/projects', { data: { name: 'Markdown Visual Edit', path: root } })).json();
  await page.request.put('/api/settings', { data: { settings: { statusline_prompted: 'true' } } });
  await page.request.put('/api/user-state/app', { data: { value: {
    projectTabs: [{ projectId: project.id, projectName: project.name }], activeTab: `project-${project.id}`,
  } } });
  await page.goto('/');
  await page.getByTitle('File Explorer', { exact: true }).click();
  const tree = page.getByLabel('文件上传区域').filter({ visible: true });
  await expect(tree.getByRole('button', { name: '.gitignore', exact: true })).toBeVisible();
  await tree.getByRole('button', { name: '隐藏点文件' }).click();
  await expect(tree.getByRole('button', { name: '.gitignore', exact: true })).toHaveCount(0);
  await tree.getByRole('button', { name: '显示点文件' }).click();
  await expect(tree.getByRole('button', { name: '.gitignore', exact: true })).toBeVisible();

  await tree.getByRole('button', { name: 'README.md', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Markdown 可视编辑区' });
  await expect(editor).toBeVisible();
  await expect(editor).toHaveAttribute('spellcheck', 'false');
  await expect(page.getByRole('img', { name: 'diagram' })).toHaveAttribute('src', /^blob:/);
  await expect(editor.getByRole('cell', { name: '42' })).toBeVisible();
  await editor.locator('p', { hasText: 'A short note.' }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' updated');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => readFileSync(markdownPath, 'utf8')).toContain('A short note. updated');
  await expect.poll(() => readFileSync(markdownPath, 'utf8')).toContain('title: Example');
  await expect.poll(() => readFileSync(markdownPath, 'utf8')).toContain('![diagram](diagram.png)');
  await expect.poll(() => readFileSync(markdownPath, 'utf8')).toContain('```dos\nclearCachedModules();\n```');
  await expect.poll(() => readFileSync(markdownPath, 'utf8')).toContain('- first\n- second');
  await expect.poll(() => readFileSync(markdownPath, 'utf8')).toContain('- [ ] todo');
  await expect.poll(() => readFileSync(markdownPath, 'utf8')).toContain('alpha');
  await page.getByRole('button', { name: '源码', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('A short note. updated');
  await page.getByRole('button', { name: '可视编辑', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Markdown 可视编辑区' })).toContainText('A short note. updated');
  expect(hookErrors).toEqual([]);
});

test('a failed visual editor keeps the project mounted and the complete Markdown available in source', async ({ page }) => {
  const status = await (await page.request.get('/api/auth/status')).json();
  expect((await page.request.post(status.needsSetup ? '/api/auth/setup' : '/api/auth/login', {
    data: { username: 'e2e-admin', password: 'test-password' },
  })).ok()).toBeTruthy();
  const root = join(process.cwd(), '.test-data', 'e2e', 'markdown-editor-recovery');
  mkdirSync(root, { recursive: true });
  const markdownPath = join(root, 'README.md');
  const content = '---\ntitle: Keep metadata\n---\n# Draft\n\nKeep all content.\n';
  writeFileSync(markdownPath, content);
  const { project } = await (await page.request.post('/api/projects', { data: { name: 'Markdown Recovery', path: root } })).json();
  await page.request.put('/api/settings', { data: { settings: { statusline_prompted: 'true' } } });
  await page.request.put('/api/user-state/app', { data: { value: {
    projectTabs: [{ projectId: project.id, projectName: project.name }], activeTab: `project-${project.id}`,
  } } });
  await page.route('**/src/components/MarkdownVisualEditor.tsx*', route => route.fulfill({
    contentType: 'application/javascript',
    body: `export function MarkdownVisualEditor() { throw new TypeError("Cannot read properties of null (reading 'useRef')"); }`,
  }));
  await page.goto('/');
  await page.getByTitle('File Explorer', { exact: true }).click();
  const tree = page.getByLabel('文件上传区域').filter({ visible: true });
  await tree.getByRole('button', { name: 'README.md', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('当前文件内容已保留');
  await expect(tree).toBeVisible();
  await expect(page.getByText(/failed to render/)).toHaveCount(0);
  await page.getByRole('button', { name: '切换到源码' }).click();
  await expect(page.locator('.cm-content')).toContainText('title: Keep metadata');
  await expect(page.locator('.cm-content')).toContainText('Keep all content.');
  expect(readFileSync(markdownPath, 'utf8')).toBe(content);
});
