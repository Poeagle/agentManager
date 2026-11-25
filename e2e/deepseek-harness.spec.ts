import { expect, test, type Page } from '@playwright/test';
import { once } from 'node:events';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
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
  const { user } = await response.json();
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
  const { projects: existing } = await (await page.request.get('/api/projects')).json();
  const projectIds = paths.map(path => existing.find((project: { path: string }) => project.path === path).id);
  return { paths, projectIds, userId: user.id };
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

  const table = page.getByRole('table', { name: 'Agent Provider' });
  const providers = table.locator('tbody > tr');
  const row = table.getByRole('row').filter({ has: page.getByRole('cell', { name: 'DeepSeek Harness', exact: true }) });
  await expect(row).toHaveCount(1);
  await expect(row.getByRole('cell', { name: url })).toBeVisible();
  await expect(page.getByText(`${await providers.count()} 个 Provider`, { exact: true })).toBeVisible();
  await row.getByRole('button', { name: '编辑 DeepSeek Harness', exact: true }).click();
  const edit = page.getByRole('dialog', { name: '编辑 Provider · DeepSeek Harness' });
  await expect(edit.getByLabel('Harness 网页地址')).toHaveValue(url);
  await expect(edit.getByRole('combobox', { name: 'Agent', exact: true })).toHaveCount(0);
  await edit.getByRole('button', { name: '关闭编辑 Provider · DeepSeek Harness' }).click();

  await page.getByRole('button', { name: '关闭平台管理' }).click();
}

async function showProviderSettings(page: Page) {
  await page.getByTitle('My account').click();
  await page.getByRole('button', { name: 'Agent 配置', exact: true }).click();
}

async function addHarnessProvider(page: Page, id: string, address: string, models: string) {
  await page.getByRole('button', { name: '新增 Provider' }).click();
  await page.getByRole('combobox', { name: 'Agent', exact: true }).selectOption('deepseek-harness');
  const editor = page.getByRole('dialog', { name: '新增 Provider' });
  await editor.getByLabel('Provider ID').fill(id);
  await editor.getByLabel('API 基础地址').fill(address);
  await editor.getByLabel('API Key').fill('test-only-key');
  await editor.getByLabel('模型 ID（每行一个）').fill(models);
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole('table', { name: 'Agent Provider', exact: true }).getByRole('cell', { name: id, exact: true })).toBeVisible();
}

async function chooseHarnessModel(page: Page, provider: string, model: string) {
  const table = page.getByRole('table', { name: 'Agent Provider', exact: true });
  await table.getByRole('button', { name: `Provider ${provider} 的模型` }).click();
  await page.getByRole('table', { name: `Provider ${provider} 的模型`, exact: true })
    .getByRole('row').filter({ hasText: model }).getByRole('button', { name: '设为新标签页默认' }).click();
  await expect(page.getByText(`Harness 新标签页默认模型 · ${provider} / ${model}`, { exact: true })).toBeVisible();
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

test('configures Harness and restores its workspace, custom tab name and order', async ({ page }) => {
  const { paths, projectIds, userId } = await prepareProjects(page);
  const otherTabs = [
    { id: 'harness-neighbor-codex', label: 'Codex 工作记录', agent: 'codex' },
    { id: 'harness-neighbor-claude', label: 'Claude 工作记录', agent: 'claude' },
  ];
  const Database = createRequire(import.meta.url)('../server/node_modules/better-sqlite3');
  const db = new Database(join(process.cwd(), '.test-data', 'e2e', 'agentmanager.db'));
  const now = new Date().toISOString();
  try {
    const insert = db.prepare(`INSERT INTO sessions
      (id, project_id, task, status, mode, cli_type, created_by_user_id, created_at, updated_at, completed_at)
      VALUES (?, ?, ?, 'completed', 'session', ?, ?, ?, ?, ?)`);
    for (const tab of otherTabs) insert.run(tab.id, projectIds[0], tab.label, tab.agent, userId, now, now, now);
  } finally {
    db.close();
  }
  expect((await page.request.put(`/api/user-state/${encodeURIComponent(`project:${projectIds[0]}`)}`, {
    data: { value: { terminalInstances: otherTabs.map(({ id, label }) => ({ id, label })), hiddenSessionIds: [] } },
  })).ok()).toBeTruthy();
  const received: string[] = [];
  const server = createServer(async (req, res) => {
    if (req.method === 'POST') {
      let path = '';
      for await (const chunk of req) path += chunk;
      received.push(path);
      res.writeHead(204).end();
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
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

    const projectBranch = (name: string) => page.locator('.workspace-project-item')
      .filter({ has: page.getByRole('button', { name, exact: true }) });
    const strip = projectBranch(projects[0]).getByLabel('会话标签', { exact: true });
    const tabButtons = strip.locator('.workspace-tab-button');
    const expectTabOrder = async (labels: string[]) => {
      await expect(tabButtons).toHaveCount(labels.length);
      for (const [index, label] of labels.entries()) {
        await expect(tabButtons.nth(index)).toHaveAccessibleName(label);
      }
    };
    const [codexLabel, claudeLabel] = otherTabs.map(tab => tab.label);
    const harnessLabel = '项目调研';
    const harnessTab = strip.getByRole('button', { name: 'DeepSeek Harness', exact: true });
    await expectTabOrder([codexLabel, claudeLabel, 'DeepSeek Harness']);
    await harnessTab.dblclick();
    const rename = strip.getByRole('textbox', { name: '标签名称' });
    await expect(rename).toBeVisible({ timeout: 4_000 });
    await rename.fill(`  ${harnessLabel}  `);
    await rename.press('Enter');
    const renamed = strip.getByRole('button', { name: harnessLabel, exact: true });
    await renamed.press('F2');
    await rename.fill('取消重命名');
    await rename.press('Escape');
    await expect(renamed).toBeVisible();

    const codexTab = strip.getByRole('button', { name: codexLabel, exact: true });
    await renamed.dragTo(codexTab);
    await expectTabOrder([harnessLabel, codexLabel, claudeLabel]);
    await codexTab.dragTo(renamed);
    await expectTabOrder([codexLabel, harnessLabel, claudeLabel]);
    await expect(visibleHarness(page).getByLabel('Project path')).toHaveText(paths[0]);
    expect(received.filter(path => path === paths[0])).toHaveLength(1);

    await page.reload();
    await expectTabOrder([codexLabel, harnessLabel, claudeLabel]);
    await expect(visibleHarness(page).getByLabel('Project path')).toHaveText(paths[0]);

    await page.getByRole('navigation', { name: '项目标签' }).getByRole('button', { name: 'Projects', exact: true }).click();
    await openHarness(page, projects[1]);
    await expect(visibleHarness(page).getByLabel('Project path')).toHaveText(paths[1]);
    const projectTabs = page.getByRole('navigation', { name: '项目标签' });
    await projectTabs.getByText(projects[0], { exact: true }).click();
    await expect(visibleHarness(page).getByLabel('Project path')).toHaveText(paths[0]);
    await expectTabOrder([codexLabel, harnessLabel, claudeLabel]);
    await projectTabs.getByText(projects[1], { exact: true }).click();
    await expect(visibleHarness(page).getByLabel('Project path')).toHaveText(paths[1]);

    await page.reload();
    await expect(visibleHarness(page).getByLabel('Project path')).toHaveText(paths[1]);
    const closeHarness = projectBranch(projects[1]).getByRole('button', { name: '关闭 DeepSeek Harness' });
    await closeHarness.click();
    await page.reload();
    await expect(page.locator('iframe[title="DeepSeek Harness"]:visible')).toHaveCount(0);
    await expect(closeHarness).toHaveCount(0);
    expect((await (await page.request.get('/api/settings')).json()).settings.deepseek_harness_url).toBe(url);
    const { sessions } = await (await page.request.get('/api/sessions')).json();
    expect(sessions.filter((session: { project_id: string }) => projectIds.includes(session.project_id))
      .map((session: { id: string }) => session.id).sort()).toEqual(otherTabs.map(tab => tab.id).sort());
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await page.request.put('/api/settings', { data: { settings: { deepseek_harness_url: '' } } });
  }
});

test('manages multiple upstreams and applies the selected model to newly opened project tabs', async ({ page }) => {
  await prepareProjects(page);
  const plugin = await readFile(new URL('../integrations/deepseek-harness/client.js', import.meta.url), 'utf8');
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><output aria-label="Harness current model"></output>
      <button type="button">完成会话</button>
      <script>
      window.__OCTOALLY_HARNESS_PARENT_ORIGINS__ = [${JSON.stringify(new URL(req.headers.referer || 'http://127.0.0.1:' + (process.env.E2E_UI_PORT || '43111')).origin)}];
      const ok = value => ({ok:true, value});
      const load = () => JSON.parse(localStorage.getItem('configuration') || '{"providers":{},"revision":0}');
      const sessions = {};
      let active;
      document.querySelector('button').onclick = () => {
        sessions[active].blank = false;
        sessionStorage.setItem(active, JSON.stringify(sessions[active]));
      };
      const remote = {
        settings: {
          describe: async () => {
            const {providers, revision} = load();
            return ok({ writable: true, namespaces:[{ns:'llm-pi-ai', revision, user:{providers}, value:{providers}}] });
          },
          mutate: async (_ns, ops, revision) => {
            const current = load();
            if (revision !== current.revision) return {ok:false, error:{code:'settings/conflict'}};
            for (const {path:[_providers,id,key], value} of ops) (current.providers[id] ??= {})[key] = value;
            current.revision++;
            localStorage.setItem('configuration', JSON.stringify(current));
            return ok();
          },
        },
        credentials: { set: async (ref, value) => {
          if (value !== 'test-only-key' || !ref.startsWith('OCTOALLY_')) return {ok:false};
          return ok();
        }, unset: async () => ok() },
        llm: {listConfigurableProviders: async () => ok([])},
        session: {
          modelCatalog: async () => ok({groups:Object.entries(load().providers).map(([id, row]) => ({
            id, name:row.displayName, models:row.models,
          }))}),
          selectModel: async ({sessionId,provider,model}) => {
            if (!load().providers[provider]?.models.some(entry => entry.id === model)) return {ok:false};
            sessions[sessionId].label = provider + ' / ' + model;
            sessionStorage.setItem(sessionId, JSON.stringify(sessions[sessionId]));
            return ok();
          },
        },
      };
      const workspace = {workspaceId:'workspace',sessionIds:[]};
      const navigation = {
        connectWorkspace: async () => {
          const id = workspace.sessionIds[0];
          sessions[id] ??= {blank:true, retainedBy:{mainView:1}};
          return id;
        },
        openWorkspace: async id => navigation.openSession(await navigation.connectWorkspace(id)),
        openSession: id => {
          active = id;
          document.querySelector('output').textContent = sessions[id].label || 'Harness 默认';
        },
      };
      const services = {
        workspaces:{create: async ({path}) => {
          workspace.workspaceId = path;
          workspace.sessionIds = ['session:' + path];
          const [id] = workspace.sessionIds;
          const saved = sessionStorage.getItem(id);
          if (saved) sessions[id] = JSON.parse(saved);
          return workspace;
        },list:{getSnapshot:() => ({phase:'ready',items:[workspace],archivedSessionIds:[]}),subscribe:() => () => {}}},
        sessions:{list:{getSnapshot:() => ({phase:'ready',byId:sessions}),subscribe:() => () => {}}},
        uiWorkspace:navigation, remote,
      };
      window.__ModuleLoader__ = {load: ({factory}) => factory().apply({
        get: key => services[key], effect: action => action(),
      })};
      </script><script>${plugin}</script>`);
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    await configure(page, url);
    await showProviderSettings(page);
    for (const upstream of ['upstream-a', 'upstream-b']) {
      await addHarnessProvider(page, upstream, `https://${upstream}.example.test/v1`, 'shared-model\nsecond-model');
    }
    await chooseHarnessModel(page, 'upstream-b', 'shared-model');
    await page.getByRole('button', { name: '编辑 upstream-b', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '编辑 Provider · upstream-b' });
    await expect(editor.getByLabel('API Key')).toHaveValue('');
    await editor.getByLabel('模型 ID（每行一个）').fill('second-model');
    await expect(editor.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
    await editor.getByLabel('模型 ID（每行一个）').fill('shared-model\nthird-model');
    await editor.getByRole('button', { name: '保存', exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(page.getByRole('cell', { name: 'third-model' })).toBeVisible();
    expect(JSON.stringify(await (await page.request.get('/api/settings')).json())).not.toContain('test-only-key');
    await page.getByRole('button', { name: '关闭平台管理' }).click();
    await openHarness(page, projects[0]);
    await expect(visibleHarness(page).getByLabel('Harness current model')).toHaveText('upstream-b / shared-model');
    await visibleHarness(page).getByRole('button', { name: '完成会话' }).click();

    await showProviderSettings(page);
    await chooseHarnessModel(page, 'upstream-a', 'shared-model');
    await page.getByRole('button', { name: '关闭平台管理' }).click();
    await expect(visibleHarness(page).getByLabel('Harness current model')).toHaveText('upstream-b / shared-model');
    await page.reload();
    await expect(visibleHarness(page).getByLabel('Harness current model')).toHaveText('upstream-b / shared-model');
    await page.getByRole('navigation', { name: '项目标签' }).getByRole('button', { name: 'Projects', exact: true }).click();
    await openHarness(page, projects[1]);
    await expect(visibleHarness(page).getByLabel('Harness current model')).toHaveText('upstream-a / shared-model');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await page.request.put('/api/settings', { data: { settings: { deepseek_harness_url: '' } } });
  }
});

test('opens both projects through the real Harness Web bridge', async ({ page }) => {
  test.setTimeout(80_000);
  test.skip(!realHarness, 'Requires a separately started, isolated DSH 0.2.2-rc.5 instance with the OctoAlly bridge.');
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
  const modelId = process.env.E2E_DEEPSEEK_HARNESS_MODEL;
  const fixtureModel = 'octoally-smoke-model';
  if (!modelId) {
    const provider = `gateway-${Date.now()}`;
    await showProviderSettings(page);
    await addHarnessProvider(page, provider, 'http://127.0.0.1:1/v1', fixtureModel);
    await chooseHarnessModel(page, provider, fixtureModel);
    await page.getByRole('button', { name: '关闭平台管理' }).click();
  }
  await openHarness(page, projects[0], true);
  const frame = visibleHarness(page);
  await expect(frame.getByRole('button', { name: /Choose workspace|选择工作区/ }).filter({ hasText: projects[0] })).toBeVisible();
  if (!modelId) await expect(frame.getByRole('button', { name: /^(Select model|选择模型)/ })).toContainText(fixtureModel);

  const tabs = page.getByRole('navigation', { name: '项目标签' });
  await tabs.getByRole('button', { name: 'Projects', exact: true }).click();
  await openHarness(page, projects[1]);
  await expect(visibleHarness(page).getByRole('button', { name: /Choose workspace|选择工作区/ }).filter({ hasText: projects[1] })).toBeVisible();
  await tabs.getByText(projects[0], { exact: true }).click();
  await expect(visibleHarness(page).getByRole('button', { name: /Choose workspace|选择工作区/ }).filter({ hasText: projects[0] })).toBeVisible();
  await page.reload();
  await expect(visibleHarness(page).getByRole('button', { name: /Choose workspace|选择工作区/ }).filter({ hasText: projects[0] })).toBeVisible();

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
