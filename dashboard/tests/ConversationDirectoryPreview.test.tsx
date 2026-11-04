import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {ConversationFilePreview} from '../src/components/ConversationFilePreview';
import {api,ApiError,fetchJSON} from '../src/lib/api';
vi.mock('../src/lib/api',async()=>{
 const actual=await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
 return {...actual,fetchJSON:vi.fn(),api:{...actual.api,files:{...actual.api.files,list:vi.fn(),read:vi.fn()}}};
});
// Load the real lazy preview outside individual query timeouts under parallel suites.
beforeAll(async()=>{await import('../src/components/FileExplorer');});
const file={path:'/project/reports',rootPath:'/project',projectId:'project-1',name:'reports'};
const entry=(name:string,type:'file'|'directory')=>({name,type,size:10,extension:type==='file'?'md':'',modified_at:'2026-11-03T01:00:00Z'});
beforeEach(()=>{
 vi.clearAllMocks();vi.mocked(fetchJSON).mockResolvedValue({path:file.path,type:'directory'});
 vi.mocked(api.files.list).mockImplementation(async path=>({path,files:path===file.path?[entry('nested','directory')]:path===file.path+'/nested'?[entry('README.md','file')]:[]}));
 vi.mocked(api.files.read).mockImplementation(async path=>({path,content:'# 目录中的说明',extension:'md',size:25}));
});
describe('directory conversation previews',()=>{
 it('expands folders lazily and opens a file without trying to read the directory as a file',async()=>{
  render(<ConversationFilePreview file={file} onClose={()=>{}}/>);
  const folder=await screen.findByText('nested');expect(screen.getByRole('dialog',{name:'目录预览 · reports'})).toBeVisible();expect(api.files.read).not.toHaveBeenCalled();expect(api.files.list).toHaveBeenCalledTimes(1);
  fireEvent.click(folder);const readme=await screen.findByText('README.md');expect(api.files.list).toHaveBeenCalledWith('/project/reports/nested',true,'project-1');fireEvent.click(readme);
  expect(await screen.findByRole('heading',{name:'目录中的说明'},{timeout:3000})).toBeVisible();expect(api.files.read).toHaveBeenCalledExactlyOnceWith('/project/reports/nested/README.md','project-1');expect(screen.queryByRole('button',{name:'上传文件',exact:true})).not.toBeInTheDocument();expect(screen.queryByText('Path is not a file')).not.toBeInTheDocument();
  fireEvent.click(screen.getByTitle('Close'));expect(screen.getByRole('dialog',{name:'目录预览 · reports'})).toBeVisible();expect(screen.getByText('nested')).toBeVisible();
 });
 it('shows empty directories without a download error',async()=>{
  vi.mocked(api.files.list).mockResolvedValue({path:file.path,files:[]});render(<ConversationFilePreview file={file} onClose={()=>{}}/>);expect(await screen.findByText('No files found')).toBeVisible();expect(api.files.read).not.toHaveBeenCalled();expect(screen.queryByText('下载原文件')).not.toBeInTheDocument();
 });
 it('keeps files in the existing viewer',async()=>{
  vi.mocked(fetchJSON).mockResolvedValue({path:'/project/README.md',type:'file'});render(<ConversationFilePreview file={{...file,path:'/project/README.md',name:'README.md'}} onClose={()=>{}}/>);expect(await screen.findByRole('heading',{name:'目录中的说明'},{timeout:3000})).toBeVisible();expect(screen.getByRole('dialog',{name:'文件预览 · README.md'})).toBeVisible();
 });
 it('shows permission errors and retries after a path becomes available',async()=>{
  vi.mocked(fetchJSON).mockRejectedValueOnce(new ApiError('Forbidden',403));render(<ConversationFilePreview file={file} onClose={()=>{}}/>);expect(await screen.findByRole('alert')).toHaveTextContent('没有权限访问此路径');expect(api.files.list).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'重新加载'}));expect(await screen.findByText('nested')).toBeVisible();
 });
 it('rejects paths outside the current root before making a metadata request',async()=>{
  render(<ConversationFilePreview file={{...file,path:'/other'}} onClose={()=>{}}/>);expect(await screen.findByRole('alert')).toHaveTextContent('只能访问当前项目');expect(fetchJSON).not.toHaveBeenCalled();expect(api.files.list).not.toHaveBeenCalled();
 });
 it('uses path metadata for dotted directory names and does not reload on docking',async()=>{
  vi.mocked(fetchJSON).mockResolvedValue({path:'/project/reports.md',type:'directory'});const props={file:{...file,path:'/project/reports.md',name:'reports.md'},onClose:()=>{}};const view=render(<ConversationFilePreview {...props}/>);await screen.findByRole('dialog',{name:'目录预览 · reports.md'});view.rerender(<ConversationFilePreview {...props} dock={{left:0,top:0,width:500,height:650}}/>);expect(screen.getByRole('complementary',{name:'目录预览 · reports.md'})).toBeVisible();await waitFor(()=>expect(fetchJSON).toHaveBeenCalledTimes(1));
 });
});
