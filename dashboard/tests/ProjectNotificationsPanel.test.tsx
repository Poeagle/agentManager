import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectNotificationsPanel } from '../src/components/ProjectNotificationsPanel';
import { platformAiApi, type ProjectNotificationSettings } from '../src/lib/platform-ai';

vi.mock('../src/lib/platform-ai', () => ({platformAiApi: {
  projectNotifications: vi.fn(), saveProjectNotification: vi.fn(), deleteProjectNotification: vi.fn(),
}}));
let client: QueryClient;
let settings: ProjectNotificationSettings;
beforeEach(() => {
  vi.clearAllMocks();
  client = new QueryClient({defaultOptions:{queries:{retry:false}}});
  settings = {projects:[{id:'p1',name:'研究项目'},{id:'p2',name:'业务项目'}],recipients:[{id:'binding:b1',name:'企业微信 · 我的账号'}],rules:[]};
  vi.mocked(platformAiApi.projectNotifications).mockImplementation(async () => settings);
  vi.mocked(platformAiApi.saveProjectNotification).mockResolvedValue({rule:{id:'r1',project_id:'p1',recipient_id:'binding:b1',enabled:1,on_complete:1,on_input:1}});
  vi.mocked(platformAiApi.deleteProjectNotification).mockResolvedValue({ok:true});
});
afterEach(() => client.clear());
function mount(canWrite = true, enabled = true) {
  render(<QueryClientProvider client={client}><ProjectNotificationsPanel canWrite={canWrite} enabled={enabled} /></QueryClientProvider>);
}

describe('project notification configuration', () => {
  it('saves the selected project, recipient and independent event switches', async () => {
    mount();
    fireEvent.change(await screen.findByLabelText('项目'),{target:{value:'p2'}});
    fireEvent.change(screen.getByLabelText('接收渠道'),{target:{value:'binding:b1'}});
    fireEvent.click(screen.getByLabelText('任务完成时通知'));
    fireEvent.click(screen.getByRole('button',{name:'保存通知规则'}));
    await screen.findByText('通知规则已保存');
    expect(platformAiApi.saveProjectNotification).toHaveBeenCalledWith({project_id:'p2',recipient_id:'binding:b1',enabled:true,on_complete:false,on_input:true},undefined);
    expect(screen.getByLabelText('项目')).toHaveValue('');
  });
  it('edits, pauses and deletes a saved rule', async () => {
    const rule={id:'r1',project_id:'p1',recipient_id:'binding:b1',enabled:1,on_complete:1,on_input:0};
    settings.rules=[rule]; mount();
    fireEvent.click(await screen.findByRole('button',{name:'编辑'}));
    expect(screen.getByLabelText('项目')).toHaveValue('p1');
    expect(screen.getByLabelText('需要输入时通知')).not.toBeChecked();
    fireEvent.click(screen.getByRole('button',{name:'暂停'}));
    await screen.findByText('已暂停通知');
    expect(platformAiApi.saveProjectNotification).toHaveBeenCalledWith({project_id:'p1',recipient_id:'binding:b1',enabled:false,on_complete:true,on_input:false},'r1');
    fireEvent.click(screen.getByRole('button',{name:'删除'}));
    await screen.findByText('已删除通知规则');
    expect(platformAiApi.deleteProjectNotification).toHaveBeenCalledWith('r1');
  });
  it('keeps failed drafts available for correction and reports server errors', async () => {
    vi.mocked(platformAiApi.saveProjectNotification).mockRejectedValue(new Error('此项目已配置该通知渠道'));
    mount();
    fireEvent.change(await screen.findByLabelText('项目'),{target:{value:'p1'}});
    fireEvent.change(screen.getByLabelText('接收渠道'),{target:{value:'binding:b1'}});
    fireEvent.click(screen.getByRole('button',{name:'保存通知规则'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('此项目已配置该通知渠道');
    expect(screen.getByLabelText('项目')).toHaveValue('p1');
    expect(screen.getByRole('button',{name:'保存通知规则'})).toBeEnabled();
  });
  it('prevents empty-event rules and explains missing channels and disabled platform AI', async () => {
    settings.recipients=[]; mount(true,false);
    expect(await screen.findByText(/暂无可用接收渠道/)).toBeVisible();
    expect(screen.getByText(/平台 AI 尚未启用/)).toBeVisible();
    fireEvent.click(screen.getByLabelText('任务完成时通知'));
    fireEvent.click(screen.getByLabelText('需要输入时通知'));
    expect(screen.getByRole('button',{name:'保存通知规则'})).toBeDisabled();
  });
  it('shows read-only controls and invalid recipient or observation errors', async () => {
    settings.rules=[{id:'r1',project_id:'p1',recipient_id:'binding:removed',enabled:1,on_complete:1,on_input:1,error:'模型请求暂时失败'}];
    mount(false);
    expect(await screen.findByText('渠道或绑定已失效')).toBeVisible();
    expect(screen.getByText('模型请求暂时失败')).toBeVisible();
    expect(screen.getByRole('button',{name:'编辑'})).toBeDisabled();
    expect(screen.getByRole('button',{name:'暂停'})).toBeDisabled();
    expect(screen.getByRole('button',{name:'删除'})).toBeDisabled();
    expect(screen.getByLabelText('项目')).toBeDisabled();
  });
  it('recovers from a failed settings load', async () => {
    vi.mocked(platformAiApi.projectNotifications).mockRejectedValueOnce(new Error('网络错误'));
    mount(); expect(await screen.findByRole('alert')).toHaveTextContent('网络错误');
    fireEvent.click(screen.getByRole('button',{name:'重试'}));
    await waitFor(() => expect(screen.getByLabelText('项目')).toBeVisible());
  });
});
