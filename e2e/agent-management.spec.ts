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
    if (path.endsWith('/detect-models')) return route.fulfill({ json: { models: [] } });
    if (path === '/api/agent-management/codex') return route.fulfill({ json: { state: stateFor('codex') } });
    if (path === '/api/agent-management/claude') return route.fulfill({ json: { state: stateFor('claude') } });
    return route.fulfill({ json: { agents: [{ agent: descriptor('codex', 'Codex'), state: stateFor('codex') }, { agent: descriptor('claude', 'Claude'), state: stateFor('claude') }] } });
  });
  await page.goto('/');
  await page.getByTitle('My account', { exact: true }).click();
  await page.getByRole('button', { name: 'Agent 配置' }).click();
  await expect(page.getByRole('heading', { name: 'xindu', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^xindu\b/ })).toBeVisible();
  await expect(page.getByText('deepseek-v4.1-flash').first()).toBeVisible();
  await page.getByRole('button', { name: /^配置文件/ }).click();
  await expect(page.getByText('/Users/ymchen/.codex-xindu/config.toml')).toBeVisible();
  await page.screenshot({ path: 'test-results/agent-management-codex.png', fullPage: true });
  await page.getByRole('button', { name: /Claude/ }).click();
  if (!await page.getByText('Claude Code 用户设置').isVisible()) await page.getByRole('button', { name: /^配置文件/ }).click();
  await expect(page.getByText('Claude Code 用户设置')).toBeVisible();
  await expect(page.getByText('/Users/ymchen/.claude/settings.json')).toBeVisible();
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
