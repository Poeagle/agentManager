import {useEffect,useState} from 'react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {act,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {ProjectView} from '../src/components/ProjectView';
import {api,type Session} from '../src/lib/api';
const lifecycle=vi.hoisted(()=>({mounts:0,unmounts:0}));
vi.mock('../src/components/Terminal',()=>({Terminal:({visible,onReady,sessionId}:{visible:boolean;sessionId:string;onReady:(id:string)=>void})=>{
  const [draft,setDraft]=useState('');
  useEffect(()=>{lifecycle.mounts++;onReady(sessionId);return()=>{lifecycle.unmounts++;};},[]);
  return <div style={{visibility:visible?'visible':'hidden'}}><textarea aria-label="终端草稿" value={draft} onChange={e=>setDraft(e.target.value)}/></div>;
}}));
vi.mock('@uiw/react-codemirror',async original=>({...await original<typeof import('@uiw/react-codemirror')>(),default:({value,onChange}:{value:string;onChange:(value:string)=>void})=><textarea aria-label="文件编辑" value={value} onChange={e=>onChange(e.target.value)}/>}));
vi.mock('../src/components/GitPanel',()=>({GitPanel:({onOpenInExplorer}:{onOpenInExplorer:(path:string)=>void})=><button onClick={()=>onOpenInExplorer('/workspace/p/a.txt')}>打开关联文件</button>}));
vi.mock('../src/components/ProjectSkillsPanel',()=>({ProjectSkillsPanel:()=>null}));
vi.mock('../src/components/ScheduledTasksPanel',()=>({ScheduledTasksPanel:()=>null}));
vi.mock('../src/lib/api',async original=>{
  const actual=await original<typeof import('../src/lib/api')>();
  return {...actual,api:{...actual.api,
    projects:{...actual.api.projects,list:vi.fn()},sessions:{...actual.api.sessions,list:vi.fn(),create:vi.fn(),kill:vi.fn(),deleteRecord:vi.fn()},
    userState:{...actual.api.userState,getAll:vi.fn(),set:vi.fn()},
    files:{...actual.api.files,list:vi.fn(),read:vi.fn(),write:vi.fn()},
  }};
});
const session={id:'current',project_id:'p',task:'Terminal',mode:'terminal',cli_type:'codex',status:'running',pid:1,started_at:null,completed_at:null,exit_code:null,created_at:'2026-10-30T00:00:00Z'} satisfies Session;
let client:QueryClient;
beforeEach(()=>{
  vi.clearAllMocks();localStorage.clear();lifecycle.mounts=0;lifecycle.unmounts=0;Element.prototype.scrollIntoView=vi.fn();
  client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  localStorage.setItem('agentmanager-project-u-p',JSON.stringify({activeMode:'terminal',terminalInstances:[{id:'current',label:'Terminal 1'}],activeTerminalId:'current',explorerInstances:[]}));
  vi.mocked(api.projects.list).mockResolvedValue({projects:[]});
  vi.mocked(api.sessions.list).mockResolvedValue({sessions:[session]});vi.mocked(api.sessions.kill).mockResolvedValue({ok:true});vi.mocked(api.sessions.deleteRecord).mockResolvedValue({ok:true});
  vi.mocked(api.userState.getAll).mockResolvedValue({state:{}});vi.mocked(api.userState.set).mockResolvedValue({ok:true});
  vi.mocked(api.files.list).mockResolvedValue({path:'/workspace/p',files:['a.txt','b.txt'].map(name=>({name,type:'file',extension:'txt',size:4,modified_at:''}))});
  vi.mocked(api.files.read).mockImplementation(async path=>({path,content:`disk ${path.split('/').pop()}`,size:10,extension:'txt'}));
});
afterEach(()=>{client.clear();vi.restoreAllMocks();});
const mount=()=>render(<QueryClientProvider client={client}><ProjectView currentUserId="u" projectId="p" projectPath="/workspace/p" projectName="Project"/></QueryClientProvider>);
describe('file sidebar in the session workspace',()=>{
  it.each([false,true])('stops or deletes only after confirmation and keeps the terminal mounted until success (delete=%s)',async deleting=>{
    let complete!:(value:{ok:boolean})=>void;const handler=deleting?vi.mocked(api.sessions.deleteRecord):vi.mocked(api.sessions.kill);handler.mockImplementation(()=>new Promise(resolve=>{complete=resolve;}));
    mount();const raw=await screen.findByLabelText('终端草稿');fireEvent.click(screen.getByTitle('Close session'));
    expect(screen.queryByText(/仅隐藏标签/)).not.toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:deleting?'删除会话':'停止并关闭',exact:true}));expect(raw).toBeInTheDocument();
    expect(handler).toHaveBeenCalledWith(...(deleting?['current',true]:['current']));
    await act(async()=>complete({ok:true}));expect(screen.queryByLabelText('终端草稿')).not.toBeInTheDocument();
  });
  it('retains a failed stop in the open tab instead of hiding it',async()=>{
    vi.mocked(api.sessions.kill).mockRejectedValue(new Error('停止失败'));mount();const raw=await screen.findByLabelText('终端草稿');fireEvent.click(screen.getByTitle('Close session'));fireEvent.click(screen.getByRole('button',{name:'停止并关闭',exact:true}));expect(await screen.findByRole('alert')).toHaveTextContent('停止失败');expect(raw).toBeInTheDocument();expect(screen.getByRole('button',{name:'停止并关闭',exact:true})).toBeEnabled();
  });
  it('offers tree actions and delete confirmation while the terminal is active and no file has been opened',async()=>{
    mount();const raw=await screen.findByLabelText('终端草稿');
    fireEvent.click(screen.getByRole('button',{name:'File Explorer',exact:true}));
    const tree=screen.getByRole('complementary',{name:'项目文件树'}),file=await within(tree).findByRole('button',{name:'a.txt',exact:true});
    fireEvent.contextMenu(file,{clientX:120,clientY:180});
    const menu=screen.getByRole('menu');expect(menu).toBeVisible();
    fireEvent.click(within(menu).getByRole('button',{name:'Copy',exact:true}));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    fireEvent.contextMenu(file.parentElement!,{clientX:120,clientY:250});
    expect(screen.getByRole('menu')).toBeVisible();expect(screen.getByRole('button',{name:'Paste (copy)',exact:true})).toBeEnabled();
    fireEvent.keyDown(document,{key:'Escape'});
    fireEvent.contextMenu(file);fireEvent.click(screen.getByRole('button',{name:'Delete',exact:true}));
    expect(screen.getByRole('heading',{name:'Delete file?',exact:true})).toBeVisible();
    fireEvent.click(screen.getByRole('button',{name:'Cancel',exact:true}));
    expect(raw).toBeVisible();expect(api.files.read).not.toHaveBeenCalled();
  });
  it('toggles only the tree, keeps separate file/session rows and retains terminal and unsaved file drafts',async()=>{
    mount();const raw=await screen.findByLabelText('终端草稿');fireEvent.change(raw,{target:{value:'unfinished command'}});
    const treeToggle=screen.getByRole('button',{name:'File Explorer',exact:true});
    fireEvent.click(treeToggle);expect(treeToggle).toHaveAttribute('aria-expanded','true');expect(raw).toBeVisible();
    const tree=screen.getByRole('complementary',{name:'项目文件树'});expect(tree).toBeVisible();
    expect(screen.queryByText('Explorer 1')).not.toBeInTheDocument();expect(screen.queryByTitle('New Explorer')).not.toBeInTheDocument();
    fireEvent.click(await within(tree).findByRole('button',{name:'a.txt',exact:true}));
    const editor=await screen.findByLabelText('文件编辑');expect(editor).toHaveValue('disk a.txt');expect(raw).not.toBeVisible();
    const files=screen.getByLabelText('打开的文件标签'),sessions=screen.getByLabelText('会话标签');
    expect(sessions).not.toContainElement(files);expect(files).not.toContainElement(sessions);
    fireEvent.change(editor,{target:{value:'unsaved file draft'}});
    fireEvent.click(within(sessions).getByRole('button',{name:/Terminal 1/}));
    expect(raw).toBeVisible();expect(raw).toHaveValue('unfinished command');expect(editor).not.toBeVisible();expect(tree).toBeVisible();
    fireEvent.click(treeToggle);expect(tree).not.toBeVisible();expect(files).not.toBeVisible();expect(raw).toBeVisible();
    fireEvent.click(treeToggle);expect(tree).toBeVisible();expect(files).toBeVisible();expect(raw).toHaveValue('unfinished command');
    fireEvent.keyDown(window,{key:'s',ctrlKey:true});expect(api.files.write).not.toHaveBeenCalled();
    fireEvent.click(within(files).getByRole('button',{name:'a.txt',exact:true}));
    expect(editor).toBeVisible();expect(editor).toHaveValue('unsaved file draft');expect(raw).not.toBeVisible();
    fireEvent.click(treeToggle);expect(tree).not.toBeVisible();expect(files).not.toBeVisible();expect(editor).toBeVisible();
    fireEvent.click(treeToggle);expect(tree).toBeVisible();expect(files).toBeVisible();expect(editor).toHaveValue('unsaved file draft');
    const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);
    fireEvent.click(within(files).getByRole('button',{name:'关闭文件 a.txt'}));expect(confirm).toHaveBeenCalled();expect(editor).toBeVisible();
    confirm.mockReturnValue(true);fireEvent.click(within(files).getByRole('button',{name:'关闭文件 a.txt'}));
    expect(raw).toBeVisible();expect(files).toBeEmptyDOMElement();expect(lifecycle.mounts).toBe(1);expect(lifecycle.unmounts).toBe(0);expect(api.sessions.create).not.toHaveBeenCalled();
  });
  it('opens linked files from another tool while retaining the same terminal instance',async()=>{
    mount();const raw=await screen.findByLabelText('终端草稿');fireEvent.change(raw,{target:{value:'keep me'}});
    fireEvent.click(screen.getByRole('button',{name:'Source Control',exact:true}));expect(raw).not.toBeVisible();
    fireEvent.click(screen.getByRole('button',{name:'打开关联文件'}));expect(await screen.findByLabelText('文件编辑')).toBeVisible();
    expect(screen.getByLabelText('会话标签')).toBeVisible();expect(screen.queryByText('Explorer 1')).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByLabelText('会话标签')).getByRole('button',{name:/Terminal 1/}));expect(raw).toBeVisible();expect(raw).toHaveValue('keep me');expect(lifecycle.mounts).toBe(1);
  });
});
