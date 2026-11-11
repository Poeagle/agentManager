import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SharedResourcesPanel } from '../src/components/SharedResourcesPanel';
import { api, type SharedResources } from '../src/lib/api';
vi.mock('../src/lib/api', () => ({ api: { projects:{browse:vi.fn()}, sharedResources: { get: vi.fn(), save: vi.fn(), preview: vi.fn(), browse:vi.fn(), openEnv: vi.fn(), createEnv:vi.fn(), saveEnv: vi.fn() } } }));
const initial: SharedResources = { directory: '/work', scope_path: '/work', env_file: '/work/.env', enabled: true, revision: 1, instructions: '读取 .env，通过 API 访问 Jira。', env_exists: true };
function renderPanel(userId = 'owner') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } } });
  return { client, ...render(<QueryClientProvider client={client}><SharedResourcesPanel userId={userId} /></QueryClientProvider>) };
}
beforeEach(() => {
  vi.mocked(api.sharedResources.get).mockResolvedValue({ resources: structuredClone(initial) });
  vi.mocked(api.sharedResources.openEnv).mockResolvedValue({ path: '/work/.env', content: 'TOKEN=private-value\n', hash: 'a'.repeat(64), exists: true, revision: 1 });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });
describe('shared credential file and separate prompt', () => {
  it('renders Markdown by default and preserves source edits across display modes',async()=>{
    const instructions='## 服务说明\n\n使用 **已有账号**。\n\n| 项目 | 路径 |\n| --- | --- |\n| Demo | /work |';vi.mocked(api.sharedResources.get).mockResolvedValueOnce({resources:{...initial,instructions}});renderPanel();
    expect(await screen.findByRole('heading',{name:'服务说明'})).toBeVisible();expect(screen.getByText('已有账号').tagName).toBe('STRONG');expect(screen.getByRole('table')).toBeVisible();expect(screen.queryByRole('textbox',{name:'共享资源使用提示词'})).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'编辑源码'}));const input=screen.getByRole('textbox',{name:'共享资源使用提示词'});expect(input).toHaveValue(instructions);fireEvent.change(input,{target:{value:instructions+'\n\n- 新的说明'}});fireEvent.click(screen.getByRole('button',{name:'Markdown 阅读'}));expect(screen.getByText('新的说明').tagName).toBe('LI');fireEvent.click(screen.getByRole('button',{name:'编辑源码'}));expect(screen.getByRole('textbox',{name:'共享资源使用提示词'})).toHaveValue(instructions+'\n\n- 新的说明');expect(api.sharedResources.openEnv).not.toHaveBeenCalled();
  });
  it('shows only metadata and prompt until the user opens the file, then clears contents on close', async () => {
    const { client } = renderPanel();
    expect(await screen.findByRole('region',{name:'共享资源使用提示词（Markdown）'})).toHaveTextContent(initial.instructions);
    expect(api.sharedResources.openEnv).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('凭据文件内容')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '打开' }));
    expect(await screen.findByLabelText('凭据文件内容')).toHaveValue('TOKEN=private-value\n');
    fireEvent.click(screen.getByRole('button', { name: '关闭凭据文件' }));
    expect(screen.queryByLabelText('凭据文件内容')).not.toBeInTheDocument();
    expect(JSON.stringify(client.getQueryData(['shared-resources-file', 'owner']))).not.toContain('private-value');
    expect(client.getQueryData(['shared-resources-file', 'someone-else'])).toBeUndefined();
  });
  it('saves instructions without sending credential contents', async () => {
    vi.mocked(api.sharedResources.save).mockResolvedValue({ resources: { ...initial, revision: 2, instructions: '用本地 HTTP 读取 Confluence。' } });
    renderPanel();
    fireEvent.click(await screen.findByRole('button',{name:'编辑源码'}));
    fireEvent.change(await screen.findByLabelText('共享资源使用提示词'), { target: { value: '用本地 HTTP 读取 Confluence。' } });
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => expect(api.sharedResources.save).toHaveBeenCalledWith({ directory: '/work', enabled: true, revision: 1, instructions: '用本地 HTTP 读取 Confluence。' }));
    expect(api.sharedResources.openEnv).not.toHaveBeenCalled();
    expect(await screen.findByRole('status')).toHaveTextContent('配置已保存');
  });
  it('edits the real file through the separate endpoint using a concurrency hash', async () => {
    vi.mocked(api.sharedResources.saveEnv).mockResolvedValue({ path: '/work/.env', hash: 'b'.repeat(64), exists: true });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: '打开' }));
    fireEvent.change(await screen.findByLabelText('凭据文件内容'), { target: { value: 'TOKEN=replaced\n' } });
    fireEvent.click(screen.getByRole('button', { name: '保存文件' }));
    await waitFor(() => expect(api.sharedResources.saveEnv).toHaveBeenCalledWith({ content: 'TOKEN=replaced\n', expected_hash: 'a'.repeat(64), revision: 1 }));
    expect(await screen.findByRole('status')).toHaveTextContent('文件已保存');
    expect(api.sharedResources.save).not.toHaveBeenCalled();
  });
  it('keeps edits on a conflict and confirms before discarding unsaved contents', async () => {
    vi.mocked(api.sharedResources.saveEnv).mockRejectedValue(new Error('文件已被其他程序修改'));
    renderPanel();fireEvent.click(await screen.findByRole('button', { name: '打开' }));
    fireEvent.change(await screen.findByLabelText('凭据文件内容'), { target: { value: 'TOKEN=draft' } });
    fireEvent.click(screen.getByRole('button', { name: '保存文件' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('文件已被其他程序修改');
    expect(screen.getByLabelText('凭据文件内容')).toHaveValue('TOKEN=draft');
    fireEvent.click(screen.getByRole('button', { name: '关闭凭据文件' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '放弃更改并关闭' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('selects a directory and derives the credential path without editable scope or file fields',async()=>{
    vi.mocked(api.sharedResources.browse).mockResolvedValue({path:'/new',parent:'/',folderName:'new',dirs:[]});
    vi.mocked(api.sharedResources.save).mockResolvedValue({resources:{...initial,directory:'/new',scope_path:'/new',env_file:'/new/.env',revision:2,env_exists:true}});
    renderPanel();fireEvent.click(await screen.findByRole('button',{name:'选择目录'}));const choose=await screen.findByRole('button',{name:'选择此目录'});await waitFor(()=>expect(choose).toBeEnabled());fireEvent.click(choose);
    await waitFor(()=>expect(api.sharedResources.save).toHaveBeenCalledWith({directory:'/new',instructions:initial.instructions,enabled:true,revision:1}));
    expect(await screen.findByText('/new/.env')).toBeVisible();expect(screen.queryByLabelText('生效项目范围')).not.toBeInTheDocument();expect(screen.queryByLabelText('.env 文件路径')).not.toBeInTheDocument();
  });
  it('creates a missing .env before opening its editor',async()=>{
    vi.mocked(api.sharedResources.get).mockResolvedValue({resources:{...initial,env_exists:false}});
    vi.mocked(api.sharedResources.openEnv).mockResolvedValue({path:'/work/.env',content:'',hash:null,exists:false,revision:1});
    vi.mocked(api.sharedResources.createEnv).mockResolvedValue({path:'/work/.env',content:'',hash:'b'.repeat(64),exists:true,revision:1});
    renderPanel();fireEvent.click(await screen.findByRole('button',{name:'创建并打开'}));expect(await screen.findByLabelText('凭据文件内容')).toBeVisible();expect(api.sharedResources.createEnv).toHaveBeenCalledOnce();
  });
});
