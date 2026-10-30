import {act,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {FileExplorer} from '../src/components/FileExplorer';
import {api} from '../src/lib/api';
vi.mock('@uiw/react-codemirror',async(original)=>({...await original<typeof import('@uiw/react-codemirror')>(),default:({value,onChange}:{value:string;onChange:(value:string)=>void})=><textarea aria-label="文件编辑" value={value} onChange={event=>onChange(event.target.value)} />}));
vi.mock('../src/lib/api',async(original)=>{
  const actual=await original<typeof import('../src/lib/api')>();
  return {...actual,api:{...actual.api,files:{...actual.api.files,list:vi.fn(),read:vi.fn(),upload:vi.fn(),createDirectory:vi.fn()}}};
});
beforeEach(()=>{
  vi.clearAllMocks(); localStorage.clear(); Element.prototype.scrollIntoView=vi.fn();
  vi.mocked(api.files.list).mockResolvedValue({path:'/p',files:[
    {name:'a.txt',type:'file',size:3,extension:'txt',modified_at:'2026-10-01T00:00:00Z'},
    {name:'z.txt',type:'file',size:3,extension:'txt',modified_at:'2026-10-29T00:00:00Z'},
  ]});
  vi.mocked(api.files.read).mockImplementation(async(path)=>({path,content:'old',extension:'txt',size:3}));
  vi.mocked(api.files.createDirectory).mockResolvedValue({ok:true,created:true});
  vi.mocked(api.files.upload).mockResolvedValue({ok:true,path:'/p/x',size:1});
});
describe('frequent explorer operations',()=>{
  it('sorts by modification time and persists the selection',async()=>{
    const view=render(<FileExplorer rootPath="/p" instanceId="sort" />);
    await screen.findByText('a.txt');
    fireEvent.change(screen.getByLabelText('文件排序'),{target:{value:'modified_desc'}});
    const rows=within(screen.getByLabelText('文件上传区域')).getAllByRole('button').filter(button=>button.hasAttribute('data-filepath'));
    expect(rows.map(row=>row.textContent)).toEqual(['z.txt','a.txt']);
    await waitFor(()=>expect(JSON.parse(localStorage.getItem('agentmanager-explorer-sort')!).sortOrder).toBe('modified_desc'));
    view.unmount();render(<FileExplorer rootPath="/p" instanceId="sort" />);
    expect(screen.getByLabelText('文件排序')).toHaveValue('modified_desc');
  });
  it('refreshes the directory and disk content of a clean open file',async()=>{
    render(<FileExplorer rootPath="/p" />);
    fireEvent.click(await screen.findByText('a.txt'));
    expect(await screen.findByLabelText('文件编辑')).toHaveValue('old');
    vi.mocked(api.files.read).mockResolvedValue({path:'/p/a.txt',content:'new disk contents',extension:'txt',size:17});
    fireEvent.click(screen.getByRole('button',{name:'刷新目录和当前文件'}));
    await waitFor(()=>expect(screen.getByLabelText('文件编辑')).toHaveValue('new disk contents'));
    expect(api.files.list).toHaveBeenCalledTimes(2);
  });
  it('preserves drafts edited both before and during a refresh',async()=>{
    render(<FileExplorer rootPath="/p" />);fireEvent.click(await screen.findByText('a.txt'));
    const editor=await screen.findByLabelText('文件编辑');
    fireEvent.change(editor,{target:{value:'draft'}});
    fireEvent.click(screen.getByRole('button',{name:'刷新目录和当前文件'}));
    await screen.findByText(/已保留编辑内容/);expect(editor).toHaveValue('draft');
    expect(api.files.read).toHaveBeenCalledTimes(1);
    fireEvent.change(editor,{target:{value:'old'}});
    let finish!:(data:{path:string;content:string;extension:string;size:number})=>void;
    vi.mocked(api.files.read).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    fireEvent.click(screen.getByRole('button',{name:'刷新目录和当前文件'}));
    await waitFor(()=>expect(api.files.read).toHaveBeenCalledTimes(2));
    fireEvent.change(editor,{target:{value:'new draft'}});
    await act(async()=>finish({path:'/p/a.txt',content:'external update',extension:'txt',size:15}));
    expect(editor).toHaveValue('new draft');
  });
  it('uploads a selected folder with its full relative hierarchy',async()=>{
    render(<FileExplorer rootPath="/p" projectId="p" />);await screen.findByText('a.txt');
    const file=new File(['hi'],'note.txt');Object.defineProperty(file,'webkitRelativePath',{value:'folder/sub/note.txt'});
    fireEvent.change(screen.getByLabelText('选择上传文件夹'),{target:{files:[file]}});
    await screen.findByText(/已上传 1\/1/);
    expect(vi.mocked(api.files.createDirectory).mock.calls.map(call=>call[0])).toEqual(['/p/folder','/p/folder/sub']);
    expect(api.files.upload).toHaveBeenCalledWith('/p/folder/sub',file,expect.any(Function),'p');
  });
});
