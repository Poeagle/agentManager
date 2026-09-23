import { expect, test } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { deflateRawSync } from 'zlib';
import { docxFixture, odpFixture, xlsxFixture } from '../server/tests/helpers/office-fixtures';

test('previews diagrams, tables, images, PDF, and readable wrapped text locally', async ({ page }, testInfo) => {
  const status = await (await page.request.get('/api/auth/status')).json();
  expect((await page.request.post(status.needsSetup ? '/api/auth/setup' : '/api/auth/login', {
    data: { username: 'e2e-admin', password: 'test-password' },
  })).ok()).toBeTruthy();
  const root = join(process.cwd(), '.test-data', 'e2e', 'preview-project');
  mkdirSync(root, { recursive: true });
  const model = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="开始 Start" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="140" height="60" as="geometry"/></mxCell><mxCell id="3" value="完成 Finish" style="ellipse;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;" vertex="1" parent="1"><mxGeometry x="260" y="40" width="140" height="60" as="geometry"/></mxCell><mxCell id="4" style="edgeStyle=orthogonalEdgeStyle;endArrow=block;" edge="1" source="2" target="3" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell></root></mxGraphModel>';
  writeFileSync(join(root, 'flow.drawio'), `<mxfile><diagram name="Flow">${model}</diagram><diagram name="Second">${deflateRawSync(Buffer.from(encodeURIComponent(model.replace('开始 Start', '第二页 Second')))).toString('base64')}</diagram></mxfile>`);
  writeFileSync(join(root, 'table.csv'), 'name,value\n"first\nsecond",42');
  writeFileSync(join(root, 'readme.md'), '# 阅读测试\n\n第一行\n第二行\n');
  writeFileSync(join(root, 'notes.txt'), '第一行\n第二行\n' + 'Long text content '.repeat(120));
  writeFileSync(join(root, 'slides.odp'), odpFixture());
  writeFileSync(join(root, 'report.docx'), docxFixture());
  writeFileSync(join(root, 'sheet.xlsx'), xlsxFixture());
  writeFileSync(join(root, 'image.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#dae8fc"/><text x="15" y="50">Image preview</text></svg>');
  writeFileSync(join(root, 'test.pdf'), '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 400 300]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
  const { project } = await (await page.request.post('/api/projects', { data: { name: 'Preview Project', path: root } })).json();
  await page.request.put('/api/settings', { data: { settings: { statusline_prompted: 'true' } } });
  await page.request.put('/api/user-state/app', { data: { value: {
    projectTabs: [{ projectId: project.id, projectName: project.name }], activeTab: `project-${project.id}`,
  } } });
  await page.goto('/');
  await page.getByTitle('File Explorer', { exact: true }).click();
  const tree = page.getByLabel('文件上传区域').filter({ visible: true });

  await tree.getByRole('button', { name: 'table.csv', exact: true }).click();
  await expect(page.getByRole('cell', { name: '42', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'first second' })).toHaveCSS('white-space', 'pre-wrap');

  await tree.getByRole('button', { name: 'readme.md', exact: true }).click();
  await expect(page.locator('.explorer-markdown p')).toHaveCSS('white-space', 'pre-line');
  await tree.getByRole('button', { name: 'notes.txt', exact: true }).click();
  await expect(page.locator('.cm-lineWrapping')).toBeVisible();
  await expect(page.locator('.cm-content')).toHaveCSS('font-size', '14px');

  await tree.getByRole('button', { name: 'image.svg', exact: true }).click();
  const image = page.getByRole('img', { name: 'image.svg' });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(200);

  await tree.getByRole('button', { name: 'test.pdf', exact: true }).click();
  await expect(page.getByTitle('PDF 文档预览')).toHaveAttribute('src', /^blob:/);
  await tree.getByRole('button', { name: 'slides.odp', exact: true }).click();
  if (existsSync('/usr/lib/libreoffice/program/libsdlo.so') && existsSync('/usr/bin/bwrap')) {
    await expect(page.getByTitle('演示文稿预览')).toHaveAttribute('src', /^blob:/);
  } else await expect(page.getByRole('alert')).toContainText('LibreOffice');
  await tree.getByRole('button', { name: 'report.docx', exact: true }).click();
  if (existsSync('/usr/lib/libreoffice/program/libswlo.so') && existsSync('/usr/bin/bwrap')) {
    await expect(page.getByTitle('Word 文档预览')).toHaveAttribute('src', /^blob:/);
  } else await expect(page.getByRole('alert')).toContainText('LibreOffice');
  await tree.getByRole('button', { name: 'sheet.xlsx', exact: true }).click();
  if (existsSync('/usr/lib/libreoffice/program/libsclo.so') && existsSync('/usr/bin/bwrap')) {
    await expect(page.getByRole('cell', { name: '42', exact: true })).toBeVisible();
    await page.getByLabel('工作表', { exact: true }).selectOption({ label: 'Costs' });
    await expect(page.getByRole('cell', { name: '10', exact: true })).toBeVisible();
  } else await expect(page.getByRole('alert')).toContainText('LibreOffice');

  const remoteRequests: string[] = [];
  page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1') && !request.url().startsWith('blob:') && !request.url().startsWith('data:')) remoteRequests.push(request.url()); });
  await tree.getByRole('button', { name: 'flow.drawio', exact: true }).click();
  const frame = page.frameLocator('iframe[title="draw.io 图表预览"]');
  await expect(frame.locator('svg').first()).toBeVisible();
  await expect(frame.getByText('开始 Start', { exact: true })).toBeVisible();
  await frame.getByTitle('Next Page', { exact: true }).click();
  await expect(frame.getByText('第二页 Second', { exact: true })).toBeVisible();
  await expect(page.getByTitle('draw.io 图表预览')).toHaveAttribute('sandbox', 'allow-scripts');
  expect(remoteRequests).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('document-preview.png') });
});
