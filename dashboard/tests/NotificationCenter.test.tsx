import {act,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {NotificationCenter} from '../src/components/NotificationCenter';
import {notificationApi,type Notification,type NotificationPage} from '../src/lib/notifications';
import {api} from '../src/lib/api';
import {useStreamStore} from '../src/lib/websocket';

vi.mock('../src/components/SessionConversation',()=>({SessionConversation:({session,onFocusTargetVisible}:{session:{id:string};onFocusTargetVisible:()=>void})=><div data-testid="notification-conversation">目标会话 {session.id}<button onClick={onFocusTargetVisible}>内容进入视口</button></div>}));
const row=(id:number,overrides:Partial<Notification>={}):Notification=>({id,session_id:`session-${id}`,native_id:`native-${id}`,source_id:'question:q',message_id:null,turn_id:'t',kind:'question',state:'pending',title:'Agent 需要你的回答',body:`问题 ${id}`,read_at:null,created_at:new Date().toISOString(),updated_at:new Date().toISOString(),project_id:'p',project_name:'项目 A',display_name:`标签 ${id}`,muted:false,current_binding:true,...overrides});
let client:QueryClient,page:NotificationPage;
const jump=vi.fn(),detail=vi.fn();
beforeEach(()=>{
  vi.clearAllMocks();client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  page={notifications:[row(1)],has_more:false,pending:1,unread:1,through_id:1,unread_by_project:{p:1},unread_by_session:{'session-1':1},preferences:{muted_project_ids:[]}};
  vi.spyOn(notificationApi,'list').mockImplementation(async query=>({...page,notifications:page.notifications.filter(row=>query?.filter==='unread'?!row.read_at:query?.filter==='pending'?row.state==='pending':true)}));
  vi.spyOn(notificationApi,'read').mockResolvedValue({ok:true});vi.spyOn(notificationApi,'preferences').mockResolvedValue({ok:true});
  vi.spyOn(api.rbac,'me').mockResolvedValue({roles:[],catalog:[],permissions:{agent_api:'write'}});
  vi.spyOn(api.sessions,'get').mockImplementation(async id=>({session:{id,project_id:'p',task:'任务',status:'running',mode:'session',cli_type:'codex',native_session_id:`native-${id.slice(-1)}`,created_at:new Date().toISOString()}}));
  useStreamStore.setState({connected:true});
});
afterEach(()=>{client.clear();vi.restoreAllMocks();});
function mount(){return render(<QueryClientProvider client={client}><NotificationCenter userId="u" projects={[{id:'p',name:'项目 A',owner_id:'u'}]} onOpen={jump} onDetailChange={detail}/></QueryClientProvider>);}
async function open(){fireEvent.click(await screen.findByRole('button',{name:'消息通知，1 条未读'}));return screen.findByRole('dialog',{name:'消息通知'});}

it('limits project options to the current owner even with administrative project access',async()=>{
  vi.mocked(api.rbac.me).mockResolvedValue({roles:[],catalog:[],permissions:{agent_api:'write',project_access:'write',users:'write'}});
  render(<QueryClientProvider client={client}><NotificationCenter userId="u" projects={[
    {id:'p',name:'我的项目',owner_id:'u'},
    {id:'other',name:'其他用户的项目',owner_id:'another-user'},
    {id:'unowned',name:'未分配项目',owner_id:null},
    {id:'unknown',name:'归属未知的项目'},
  ]} onOpen={jump} onDetailChange={detail}/></QueryClientProvider>);
  const drawer=await open(),select=within(drawer).getByRole('combobox',{name:'筛选通知项目'});
  expect(within(select).getAllByRole('option').map(option=>option.textContent)).toEqual(['全部项目','我的项目']);
  fireEvent.change(select,{target:{value:'p'}});
  await waitFor(()=>expect(notificationApi.list).toHaveBeenCalledWith({filter:'pending',project_id:'p'}));
});

it('clears a stale project scope when the selected project no longer belongs to the current user',async()=>{
  const view=mount(),drawer=await open();
  const select=within(drawer).getByRole('combobox',{name:'筛选通知项目'});
  fireEvent.change(select,{target:{value:'p'}});expect(select).toHaveValue('p');
  view.rerender(<QueryClientProvider client={client}><NotificationCenter userId="u" projects={[{id:'p',name:'已转交项目',owner_id:'another-user'}]} onOpen={jump} onDetailChange={detail}/></QueryClientProvider>);
  expect(select).toHaveValue('');expect(within(select).getAllByRole('option')).toHaveLength(1);
  expect(within(drawer).queryByRole('button',{name:'静音项目提醒'})).not.toBeInTheDocument();
  fireEvent.click(within(drawer).getByRole('button',{name:'全部标为已读'}));
  await waitFor(()=>expect(notificationApi.read).toHaveBeenCalledWith({through_id:1}));
});

it('opens the compact notification list and marks read only once the selected content is actually shown',async()=>{
  mount();const drawer=await open();await within(drawer).findByText('问题 1');
  fireEvent.click(within(drawer).getByRole('button',{name:'直接处理'}));
  expect(await screen.findByTestId('notification-conversation')).toHaveTextContent('目标会话 session-1');
  expect(notificationApi.read).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'内容进入视口'}));
  await waitFor(()=>expect(notificationApi.read).toHaveBeenCalledWith({ids:[1]}));
  expect(detail).toHaveBeenCalledWith(true);
});

it('jumps to the exact source without marking unread content read or submitting any input',async()=>{
  mount();const drawer=await open();fireEvent.click(await within(drawer).findByRole('button',{name:'打开标签页'}));
  expect(jump).toHaveBeenCalledWith(expect.objectContaining({session_id:'session-1',native_id:'native-1'}));
  expect(screen.queryByRole('dialog',{name:'消息通知'})).not.toBeInTheDocument();expect(notificationApi.read).not.toHaveBeenCalled();
});

it('offers live reminders while preserving list positions and the selected conversation',async()=>{
  mount();const drawer=await open();fireEvent.click(await within(drawer).findByRole('button',{name:'直接处理'}));await screen.findByTestId('notification-conversation');
  page={...page,notifications:[row(2),row(1)],unread:2,pending:2,through_id:2};
  await act(()=>client.invalidateQueries({queryKey:['notifications','u']}));
  expect(await screen.findByRole('complementary',{name:'新消息通知'})).toHaveTextContent('标签 2');
  expect(screen.getByTestId('notification-conversation')).toHaveTextContent('session-1');
  expect(within(drawer).queryByText('问题 2')).not.toBeInTheDocument();
  fireEvent.click(await within(drawer).findByRole('button',{name:'1 条新通知，点击显示'}));
  expect(within(drawer).getByText('问题 2')).toBeInTheDocument();
});

it('keeps pending work separate from read-all and supports project muting and Escape',async()=>{
  mount();const drawer=await open();
  fireEvent.click(within(drawer).getByRole('button',{name:'全部标为已读'}));
  await waitFor(()=>expect(notificationApi.read).toHaveBeenCalledWith({through_id:1}));
  expect(within(drawer).getByText('问题 1')).toBeInTheDocument();
  fireEvent.change(within(drawer).getByRole('combobox',{name:'筛选通知项目'}),{target:{value:'p'}});
  fireEvent.click(within(drawer).getByRole('button',{name:'静音项目提醒'}));
  await waitFor(()=>expect(notificationApi.preferences).toHaveBeenCalledWith(['p']));
  fireEvent.keyDown(drawer,{key:'Escape'});expect(screen.queryByRole('dialog',{name:'消息通知'})).not.toBeInTheDocument();
});

it('shows a failed list load and allows retry without hiding the notification entry',async()=>{
  vi.mocked(notificationApi.list).mockRejectedValueOnce(new Error('读取失败'));
  mount();await waitFor(()=>expect(screen.getByRole('button',{name:'消息通知'})).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button',{name:'消息通知'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('读取失败');
  fireEvent.click(screen.getByRole('button',{name:'重试'}));
  await screen.findByText('问题 1');
});
