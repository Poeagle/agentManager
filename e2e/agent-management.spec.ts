import { expect, test } from '@playwright/test';

test('shows Agent-specific settings for Codex and Claude', async ({ page }) => {
  const status = await (await page.request.get('/api/auth/status')).json();
  expect((await page.request.post(status.needsSetup ? '/api/auth/setup' : '/api/auth/login', {
    data: { username: 'e2e-admin', password: 'test-password' },
  })).ok()).toBeTruthy();
  const token = process.env.AGENTMANAGER_E2E_SESSION_TOKEN;
  if (token) {
  await page.context().addCookies([{
    name: 'agentmanager_session', value: token, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax',
  }]);
  }
  await page.route('**/api/agent-management**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/agent-management/model-catalog') return route.fulfill({ json: { models: [{
      vendor: 'OpenAI', model: 'gpt-6.2-sol', providers: ['xindu'], release_date: '2026-11-17', context_window: 1_050_000,
      api_pricing: { currency: 'USD', source: 'official', bands: [
        { label: '≤ 272K 输入 Token', min_input_tokens: 0, rates: { input: 2, cached: 0.1, output: 10 } },
        { label: '> 272K 输入 Token', min_input_tokens: 272_001, rates: { input: 4, cached: 0.2, output: 15 } },
      ] },
    }] } });
    if (path.endsWith('/model-configs')) return route.fulfill({ json: { models: [] } });
    if (path.endsWith('/detect-models')) return route.fulfill({ json: { models: [] } });
    if (path === '/api/agent-management/codex') return route.fulfill({ json: { state: stateFor('codex') } });
    if (path === '/api/agent-management/claude') return route.fulfill({ json: { state: stateFor('claude') } });
    return route.fulfill({ json: { agents: [{ agent: descriptor('codex', 'Codex'), state: stateFor('codex') }, { agent: descriptor('claude', 'Claude'), state: stateFor('claude') }] } });
  });
  await page.goto('/');
  await page.getByTitle('My account').click();
  await page.getByRole('button', { name: 'Agent 配置' }).click();
  await expect(page.locator('.manager-section-heading')).toHaveText('Agent 配置');
  await expect(page.getByRole('button', { name: '编辑 xindu · Codex' })).toBeVisible();
  await page.getByRole('button', { name: '展开Provider xindu 的模型' }).click();
  const modelTable = page.getByRole('table', { name: 'Provider 模型' });
  await expect(modelTable.getByText('deepseek-v4.1-flash')).toBeVisible();
  await page.getByRole('button', { name: '编辑 xindu · Codex' }).click();
  await page.getByRole('button', {name:'配置文件 (1)'}).click();
  await expect(page.getByText('/Users/ymchen/.codex-xindu/config.toml')).toBeVisible();
  await page.screenshot({ path: 'test-results/agent-management-codex.png', fullPage: true });
  await page.getByRole('button', { name: '关闭编辑 Provider · xindu' }).click();
  await page.getByRole('tab', { name: '模型资料' }).click();
  const catalog = page.getByRole('table', { name: '模型资料' });
  const gptRow = catalog.getByRole('row', { name: /gpt-6\.2-sol/ });
  await expect(gptRow).toContainText('≤ 272K 输入 Token USD 2.00');
  await expect(gptRow).toContainText('> 272K 输入 Token USD 4.00');
  await expect(gptRow).toContainText('> 272K 输入 Token USD 15.00');
  await expect(gptRow).toContainText('> 272K 输入 Token USD 0.20');
  await page.getByRole('tab', { name: 'Provider' }).click();
  await page.getByRole('button', { name: '编辑 Anthropic · Claude' }).click();
  await expect(page.getByRole('textbox',{name:'Claude Provider 名称'})).toHaveValue('Anthropic');
  await expect(page.getByRole('textbox',{name:'Claude API 地址'})).toBeVisible();
  await page.screenshot({ path: 'test-results/agent-management-claude.png', fullPage: true });
});

function descriptor(id: string, label: string) {
  return { id, label, presentation: { icon: id, color: '#60a5fa' }, capabilities: {} };
}
function stateFor(id: string) {
  const files = id === 'codex'
    ? [{ path: '/Users/ymchen/.codex-xindu/config.toml', exists: true, format: 'TOML', description: 'Provider Engine 启动配置', writable: true }]
    : [{ path: '/Users/ymchen/.claude/settings.json', exists: true, format: 'JSON', description: 'Claude Code 用户设置', writable: true }];
  return {
    agent: descriptor(id, id === 'codex' ? 'Codex' : 'Claude'),
    installation: { status: 'ready', executable: `/${id}`, version: '1.0.0', latestVersion: null, updateAvailable: false, installCommand: '', updateCommand: '' },
    authentication: { status: 'authenticated', method: 'fixture', detail: '测试凭据。' },
    defaults: [], providers: id === 'codex' ? [{
      id: 'xindu', name: 'xindu', kind: 'responses', enabled: true, managed: true, status: 'ready', statusText: '独立 Engine 运行中',
      authentication: { status: 'authenticated', method: 'fixture' }, models: ['deepseek-v4.1-flash'], defaultModel: 'deepseek-v4.1-flash',
      fields: [{ key: 'baseUrl', label: 'Responses API 地址', type: 'text', value: 'https://xindu.example/v1', required: true }],
      codexHome: '/Users/ymchen/.codex-xindu', pid: 123, configFiles: files,
    }] : [{ id: 'anthropic', name: 'Anthropic', kind: 'official', enabled: true, managed: false, status: 'ready', statusText: '原生配置', authentication: { status: 'authenticated', method: 'fixture' }, models: [], defaultModel: null, fields: [] }],
    configFiles: files, diagnostics: [], actions: [],
    providerManagement: { create: id === 'codex', update: id === 'codex', delete: id === 'codex', actions: [], fields: [] },
    applySemantics: { settings: 'new_session', providers: 'immediate', detail: 'fixture' }, checkedAt: new Date().toISOString(),
  };
}
