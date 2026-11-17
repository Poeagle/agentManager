import {act,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {NotificationCenter} from '../src/components/NotificationCenter';
import {notificationApi,notificationTime,type Notification,type NotificationPage} from '../src/lib/notifications';
import {api} from '../src/lib/api';
import {useStreamStore} from '../src/lib/websocket';

vi.mock('../src/components/SessionConversation',()=>({SessionConversation:({session,onFocusTargetVisible}:{session:{id:string};onFocusTargetVisible:()=>void})=><div data-testid="notification-conversation">目标会话 {session.id}<textarea aria-label="通知回复草稿"/><button onClick={onFocusTargetVisible}>内容进入视口</button></div>}));
const row=(id:number,overrides:Partial<Notification>={}):Notification=>({id,session_id:`session-${id}`,native_id:`native-${id}`,source_id:'question:q',message_id:null,turn_id:'t',kind:'question',state:'pending',title:'Agent 需要你的回答',body:`问题 ${id}`,read_at:null,created_at:new Date().toISOString(),updated_at:new Date().toISOString(),project_id:'p',project_name:'项目 A',display_name:`标签 ${id}`,muted:false,current_binding:true,...overrides});
let client:QueryClient,page:NotificationPage;
const jump=vi.fn(),detail=vi.fn();
beforeEach(()=>{
  vi.clearAllMocks();client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  page={notifications:[row(1)],has_more:false,pending:1,unread:1,through_id:1,unread_by_project:{p:1},unread_by_session:{'session-1':1},preferences:{muted_project_ids:[]}};
  vi.spyOn(notificationApi,'list').mockImplementation(async query=>({...page,notifications:page.notifications.filter(row=>query?.filter==='unread'?!row.read_at:query?.filter==='pending'?row.state==='pending':true)}));
  vi.spyOn(notificationApi,'read').mockResolvedValue({ok:true});vi.spyOn(notificationApi,'dismiss').mockResolvedValue({ok:true});vi.spyOn(notificationApi,'preferences').mockResolvedValue({ok:true});
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
  await waitFor(()=>expect(notificationApi.dismiss).toHaveBeenCalledWith({through_id:1}));
});

it('opens the compact notification list and marks read only once the selected content is actually shown',async()=>{
  mount();const drawer=await open();await within(drawer).findByRole('button',{name:'项目 A · 标签 1'});
  fireEvent.click(within(drawer).getByRole('button',{name:'项目 A · 标签 1'}));
  expect(await screen.findByTestId('notification-conversation')).toHaveTextContent('目标会话 session-1');
  expect(notificationApi.read).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'内容进入视口'}));
  await waitFor(()=>expect(notificationApi.read).toHaveBeenCalledWith({ids:[1]}));
  expect(detail).toHaveBeenCalledWith(true);
});

it('jumps to the exact source without marking unread content read or submitting any input',async()=>{
  mount();const drawer=await open();fireEvent.click(await within(drawer).findByRole('button',{name:'项目 A · 标签 1'}));await screen.findByTestId('notification-conversation');fireEvent.click(within(drawer).getByRole('button',{name:'打开标签页'}));
  expect(jump).toHaveBeenCalledWith(expect.objectContaining({session_id:'session-1',native_id:'native-1'}));
  expect(screen.queryByRole('dialog',{name:'消息通知'})).not.toBeInTheDocument();expect(notificationApi.read).not.toHaveBeenCalled();
});

it('automatically inserts new notifications while preserving the selected conversation and draft',async()=>{
  mount();const drawer=await open();fireEvent.click(await within(drawer).findByRole('button',{name:'项目 A · 标签 1'}));await screen.findByTestId('notification-conversation');
  fireEvent.change(screen.getByRole('textbox',{name:'通知回复草稿'}),{target:{value:'保留正在编辑的回答'}});
  page={...page,notifications:[row(2),row(1)],unread:2,pending:2,through_id:2};
  await act(()=>client.invalidateQueries({queryKey:['notifications','u']}));
  expect(await within(drawer).findByRole('button',{name:'项目 A · 标签 2'})).toBeInTheDocument();
  expect(screen.getByTestId('notification-conversation')).toHaveTextContent('session-1');
  expect(screen.getByRole('textbox',{name:'通知回复草稿'})).toHaveValue('保留正在编辑的回答');
  expect(within(drawer).queryByRole('button',{name:/新通知，点击显示/})).not.toBeInTheDocument();
});

it('explicitly dismisses observed notices and supports project muting and Escape',async()=>{
  mount();const drawer=await open();
  fireEvent.click(within(drawer).getByRole('button',{name:'全部标为已读'}));
  await waitFor(()=>expect(notificationApi.dismiss).toHaveBeenCalledWith({through_id:1}));
  expect(within(drawer).getByRole('button',{name:'项目 A · 标签 1'})).toBeInTheDocument();
  fireEvent.change(within(drawer).getByRole('combobox',{name:'筛选通知项目'}),{target:{value:'p'}});
  fireEvent.click(within(drawer).getByRole('button',{name:'静音项目提醒'}));
  await waitFor(()=>expect(notificationApi.preferences).toHaveBeenCalledWith(['p']));
  fireEvent.keyDown(drawer,{key:'Escape'});expect(screen.queryByRole('dialog',{name:'消息通知'})).not.toBeInTheDocument();
});

it('can mark a notice read without replying and preserves the draft when it disappears',async()=>{
  mount();const dialog=await open();fireEvent.click(await within(dialog).findByRole('button',{name:'项目 A · 标签 1'}));
  await screen.findByTestId('notification-conversation');fireEvent.change(screen.getByRole('textbox',{name:'通知回复草稿'}),{target:{value:'保留草稿'}});
  vi.mocked(notificationApi.dismiss).mockImplementation(async()=>{page={...page,notifications:[],pending:0,unread:0};return {ok:true};});
  fireEvent.click(within(dialog).getByRole('button',{name:'标为已读',exact:true}));
  await waitFor(()=>expect(notificationApi.dismiss).toHaveBeenCalledWith({ids:[1]}));
  await waitFor(()=>expect(within(dialog).queryByRole('button',{name:'项目 A · 标签 1'})).not.toBeInTheDocument());
  expect(screen.getByRole('textbox',{name:'通知回复草稿'})).toHaveValue('保留草稿');expect(jump).not.toHaveBeenCalled();
});

it('keeps a failed manual read visible with a retryable error',async()=>{
  vi.mocked(notificationApi.dismiss).mockRejectedValue(new Error('标记暂时失败'));
  mount();const dialog=await open();fireEvent.click(await within(dialog).findByRole('button',{name:'标为已读：项目 A · 标签 1'}));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('标记暂时失败');
  expect(within(dialog).getByRole('button',{name:'项目 A · 标签 1'})).toBeInTheDocument();
  expect(within(dialog).getByRole('button',{name:'标为已读：项目 A · 标签 1'})).toBeEnabled();
});

it('removes an instant reminder when the notice is handled elsewhere',async()=>{
  mount();await screen.findByRole('button',{name:'消息通知，1 条未读'});
  page={...page,notifications:[row(2),row(1)],pending:2,unread:2,through_id:2};
  await act(()=>client.invalidateQueries({queryKey:['notifications','u']}));
  expect(await screen.findByRole('complementary',{name:'新消息通知'})).toHaveTextContent('标签 2');
  page={...page,notifications:[row(1)],pending:1,unread:1};
  await act(()=>client.invalidateQueries({queryKey:['notifications','u']}));
  await waitFor(()=>expect(screen.queryByRole('complementary',{name:'新消息通知'})).not.toBeInTheDocument());
});

it('shows a failed list load and allows retry without hiding the notification entry',async()=>{
  vi.mocked(notificationApi.list).mockRejectedValueOnce(new Error('读取失败'));
  mount();await waitFor(()=>expect(screen.getByRole('button',{name:'消息通知'})).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button',{name:'消息通知'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('读取失败');
  fireEvent.click(screen.getByRole('button',{name:'重试'}));
  await screen.findByRole('button',{name:'项目 A · 标签 1'});
});

it('shows only project, tab and full local date/time in the list and uses a centered modal',async()=>{
  page.notifications=[row(1,{created_at:new Date(2026,10,17,13,58).toISOString()})];
  mount();const dialog=await open();expect(dialog).toHaveAttribute('aria-modal','true');
  const list=within(dialog).getByRole('region',{name:'通知列表'});
  const source=await within(list).findByRole('button',{name:'项目 A · 标签 1'});
  expect(source).toHaveTextContent('2026.11.17 13:58');expect(source).not.toHaveTextContent('项目 A');expect(source).not.toHaveTextContent('问题 1');expect(source).not.toHaveTextContent('Agent 需要你的回答');
  expect(notificationTime(new Date(2026,0,2,3,4).toISOString())).toBe('2026.01.02 03:04');
});

it('groups notified tabs under their project without merging projects with the same name',async()=>{
  page.notifications=[row(4,{project_id:'second',project_name:'项目 A'}),row(3,{project_id:'p',project_name:'项目 A'}),row(2,{project_id:null,project_name:''}),row(1)];
  mount();const dialog=await open(),list=within(dialog).getByRole('region',{name:'通知列表'});
  await within(list).findByRole('button',{name:'项目 A · 标签 4'});
  const projects=within(list).getAllByRole('group',{name:'项目 A'});expect(projects).toHaveLength(2);
  expect(within(projects[0]).getByRole('button',{name:'项目 A · 标签 4'})).toBeInTheDocument();
  expect(within(projects[1]).getAllByRole('button',{name:/^项目 A · 标签/})).toHaveLength(2);
  expect(within(list).getByRole('group',{name:'工作会话'})).toHaveTextContent('标签 2');
  expect(within(list).queryByText('问题 4')).not.toBeInTheDocument();
});

it('preserves project folding and the open reply while new notified tabs arrive',async()=>{
  mount();const dialog=await open();fireEvent.click(await within(dialog).findByRole('button',{name:'项目 A · 标签 1'}));
  await screen.findByTestId('notification-conversation');fireEvent.change(screen.getByRole('textbox',{name:'通知回复草稿'}),{target:{value:'继续编辑'}});
  const toggle=within(dialog).getByRole('button',{name:'项目 A',exact:true});fireEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded','false');expect(within(dialog).queryByRole('button',{name:'项目 A · 标签 1'})).not.toBeInTheDocument();
  page={...page,notifications:[row(2),row(1)],pending:2,unread:2,through_id:2};
  await act(()=>client.invalidateQueries({queryKey:['notifications','u']}));
  expect(toggle).toHaveAttribute('aria-expanded','false');expect(screen.getByRole('textbox',{name:'通知回复草稿'})).toHaveValue('继续编辑');
  fireEvent.click(toggle);expect(toggle).toHaveAttribute('aria-expanded','true');
  expect(within(dialog).getByRole('button',{name:'项目 A · 标签 2'})).toBeInTheDocument();
  expect(within(dialog).getByRole('button',{name:'项目 A · 标签 1'})).toHaveAttribute('aria-pressed','true');
});

it('groups earlier pages into existing projects and removes a project after its last notice is handled',async()=>{
  vi.mocked(notificationApi.list).mockImplementation(async query=>query?.before?{...page,notifications:[row(1)],has_more:false}:{...page,notifications:[row(3)],has_more:true});
  mount();const dialog=await open(),list=within(dialog).getByRole('region',{name:'通知列表'});
  fireEvent.click(await within(list).findByRole('button',{name:'加载更早的通知'}));
  await within(list).findByRole('button',{name:'项目 A · 标签 1'});
  expect(within(list).getAllByRole('group',{name:'项目 A'})).toHaveLength(1);
  expect(within(list).getAllByRole('button',{name:/^项目 A · 标签/})).toHaveLength(2);
  vi.mocked(notificationApi.list).mockResolvedValue({...page,notifications:[],has_more:false,pending:0,unread:0});
  await act(()=>client.invalidateQueries({queryKey:['notifications','u']}));
  await waitFor(()=>expect(within(list).queryByRole('group',{name:'项目 A'})).not.toBeInTheDocument());
  expect(within(list).getByText('目前没有待处理事项')).toBeInTheDocument();
});

it('removes answered and submitted notifications even under all without losing an open reply draft',async()=>{
  mount();const dialog=await open();fireEvent.click(await within(dialog).findByRole('button',{name:'项目 A · 标签 1'}));
  await screen.findByTestId('notification-conversation');fireEvent.change(screen.getByRole('textbox',{name:'通知回复草稿'}),{target:{value:'尚未发送'}});
  fireEvent.click(within(dialog).getByRole('button',{name:'全部',exact:true}));
  page={...page,notifications:[row(1,{state:'resolved'}),row(2,{state:'submitted'})],pending:0,unread:0};
  await act(()=>client.invalidateQueries({queryKey:['notifications','u']}));
  const list=within(dialog).getByRole('region',{name:'通知列表'});
  await waitFor(()=>expect(within(list).queryByRole('button',{name:/项目 A · 标签/})).not.toBeInTheDocument());
  expect(screen.getByRole('textbox',{name:'通知回复草稿'})).toHaveValue('尚未发送');
});
