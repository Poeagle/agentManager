import { expect, test, type Page } from '@playwright/test';
import { once } from 'node:events';
import { mkdir, realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

const projects = ['Harness Alpha', 'Harness Beta'];
const realHarness = process.env.E2E_DEEPSEEK_HARNESS_LOG;

async function prepareProjects(page: Page) {
  const { needsSetup } = await (await page.request.get('/api/auth/status')).json();
  const response = await page.request.post(needsSetup ? '/api/auth/setup' : '/api/auth/login', {
    data: { username: 'e2e-admin', password: 'test-password' },
  });
  expect(response.ok()).toBeTruthy();
  const settings = await page.request.put('/api/settings', {
    data: { settings: { statusline_prompted: 'true', deepseek_harness_url: '' } },
  });
  expect(settings.ok()).toBeTruthy();
  expect((await page.request.put('/api/user-state/app', {
    data: { value: { activeTab: 'home', projectTabs: [] } },
  })).ok()).toBeTruthy();

  const paths = [];
  for (const name of projects) {
    const path = join(process.cwd(), '.test-data', 'e2e', name);
    await mkdir(path, { recursive: true });
    paths.push(await realpath(path));
    const created = await page.request.post('/api/projects', { data: { name, path } });
    expect(created.ok() || created.status() === 409).toBeTruthy();
  }
  return paths;
}

async function configure(page: Page, url: string) {
  await page.goto('/');
  await page.getByTitle('My account').click();
  await page.getByRole('button', { name: 'Agent 配置', exact: true }).click();
  await page.getByRole('button', { name: '新增 Provider' }).click();
  await page.getByRole('combobox', { name: 'Agent', exact: true }).selectOption('deepseek-harness');
  const dialog = page.getByRole('dialog', { name: 'DeepSeek Harness 接入' });
  await dialog.getByLabel('Harness 网页地址').fill(url);
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: '关闭平台管理' }).click();
}

async function openHarness(page: Page, name: string, throughPlus = false) {
  if (throughPlus) {
    await page.getByRole('button', { name, exact: true }).click();
    await page.getByRole('button', { name: '新建会话', exact: true }).click();
  } else {
    await page.getByRole('button', { name: '打开项目 ' + name }).click();
  }
  await page.getByRole('radio', { name: 'DeepSeek Harness' }).check();
  await page.getByRole('button', { name: '打开标签页' }).click();
}

function visibleHarness(page: Page) {
  return page.locator('iframe[title="DeepSeek Harness"]:visible').contentFrame();
}

test('configures Harness, binds each project, and restores and closes its tab', async ({ page }) => {
  const paths = await prepareProjects(page);
  const received: string[] = [];
  const server = createServer(async (req, res) => {
    if (req.method === 'POST') {
      let path = '';
      for await (const chunk of req) path += chunk;
      received.push(path);
      res.writeHead(204).end();
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><output aria-label="Project path"></output>
      <script>
      addEventListener('message', event => {
        const {data} = event;
        if (event.source !== parent || data?.channel !== 'octoally:dsh/1') return;
        if (data.type === 'open') {
          document.querySelector('output').textContent = data.path;
          fetch('/', {method:'POST', body:data.path});
        }
        parent.postMessage({channel:data.channel, id:data.id, type:data.type==='hello' ? 'ready' : 'opened'}, event.origin);
      });
      </script>`);
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    await configure(page, url);
    await openHarness(page, projects[0], true);
    await expect(visibleHarness(page).getByLabel('Project path')).toHaveText(paths[0]);
    await page.getByTitle('Terminal', { exact: true }).filter({ visible: true }).click();
    await page.getByRole('button', { name: 'DeepSeek Harness', exact: true }).click();
    await expect(visibleHarness(page).getByLabel('Project path')).toHaveText(paths[0]);
    expect(received.filter(path => path === paths[0])).toHaveLength(1);

    await page.getByRole('navigation', { name: '项目标签' }).getByRole('button', { name: 'Projects', exact: true }).click();
    await openHarness(page, projects[1]);
    await expect(visibleHarness(page).getByLabel('Project path')).toHaveText(paths[1]);
    const projectTabs = page.getByRole('navigation', { name: '项目标签' });
    await projectTabs.getByText(projects[0], { exact: true }).click();
    await expect(visibleHarness(page).getByLabel('Project path')).toHaveText(paths[0]);
    await projectTabs.getByText(projects[1], { exact: true }).click();
    await expect(visibleHarness(page).getByLabel('Project path')).toHaveText(paths[1]);

    await page.reload();
    await expect(visibleHarness(page).getByLabel('Project path')).toHaveText(paths[1]);
    await page.getByRole('button', { name: '关闭 DeepSeek Harness' }).filter({ visible: true }).click();
    await page.reload();
    await expect(page.locator('iframe[title="DeepSeek Harness"]:visible')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '关闭 DeepSeek Harness' }).filter({ visible: true })).toHaveCount(0);
    expect((await (await page.request.get('/api/settings')).json()).settings.deepseek_harness_url).toBe(url);
    const { sessions } = await (await page.request.get('/api/sessions')).json();
    expect(sessions.filter((session: { project_path: string }) => paths.includes(session.project_path))).toHaveLength(0);
  } finally {
    await page.request.put('/api/settings', { data: { settings: { deepseek_harness_url: '' } } });
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('opens both projects through the real Harness Web bridge', async ({ page }) => {
  test.setTimeout(80_000);
  test.skip(!realHarness, 'Requires a separately started, isolated DSH 0.2.2-rc.5 instance with the OctoAlly bridge.');
  const { readFile } = await import('node:fs/promises');
  const log = await readFile(realHarness!, 'utf8');
  const launch = log.match(/https?:\/\/[^\s]+[?&]token=[A-Za-z0-9_-]+/)?.[0];
  if (!launch) throw new Error('The isolated Harness did not publish a startup URL.');
  const url = new URL(launch);
  if (url.hostname !== '127.0.0.1') throw new Error('Run this test with an isolated loopback Harness.');
  const auth = await page.request.get(launch);
  expect(auth.status()).toBe(200);
  const root = url.origin + '/';
  await prepareProjects(page);
  await configure(page, root);
  await openHarness(page, projects[0], true);
  const frame = visibleHarness(page);
  await expect(frame.getByRole('button', { name: /Choose workspace|选择工作区/ }).filter({ hasText: projects[0] })).toBeVisible();

  const tabs = page.getByRole('navigation', { name: '项目标签' });
  await tabs.getByRole('button', { name: 'Projects', exact: true }).click();
  await openHarness(page, projects[1]);
  await expect(visibleHarness(page).getByRole('button', { name: /Choose workspace|选择工作区/ }).filter({ hasText: projects[1] })).toBeVisible();
  await tabs.getByText(projects[0], { exact: true }).click();
  await expect(visibleHarness(page).getByRole('button', { name: /Choose workspace|选择工作区/ }).filter({ hasText: projects[0] })).toBeVisible();
  await page.reload();
  await expect(visibleHarness(page).getByRole('button', { name: /Choose workspace|选择工作区/ }).filter({ hasText: projects[0] })).toBeVisible();

  const modelId = process.env.E2E_DEEPSEEK_HARNESS_MODEL;
  if (modelId) {
    const restoredFrame = visibleHarness(page);
    const notice = restoredFrame.getByRole('dialog', { name: /Preview Notice|预览/ });
    if (await notice.isVisible()) await notice.getByRole('button', { name: /Continue|继续/ }).click();
    const onboarding = restoredFrame.getByRole('dialog', { name: /Get started|快速开始/ });
    if (await onboarding.isVisible()) await onboarding.getByRole('button', { name: /Close|关闭/ }).click();
    const modelPicker = restoredFrame.getByRole('button', { name: /^(Select model|选择模型)/ });
    if (!(await modelPicker.textContent())?.toLowerCase().includes(modelId.toLowerCase())) {
      await modelPicker.click();
      await restoredFrame.getByRole('menuitemradio', { name: modelId, exact: false }).first().click();
    }
    const composer = restoredFrame.locator('[data-composer-input][contenteditable="true"]');
    const send = restoredFrame.getByRole('button', { name: /^(Send message|发送消息)$/ });
    await expect(async () => {
      await composer.click({ timeout: 1500 });
      await composer.press('ControlOrMeta+a');
      await composer.pressSequentially('Reply with exactly this one sentence and no tools: Harness Responses smoke test ready.');
      await expect(send).toBeEnabled({ timeout: 1500 });
    }).toPass({ timeout: 12_000 });
    await send.click();
    const reply = () => visibleHarness(page).locator('p').filter({ hasText: /^Harness Responses smoke test ready[.]$/ });
    await expect(reply()).toBeVisible({ timeout: 30_000 });
    await page.reload();
    await expect(reply()).toBeVisible();
  }
});
