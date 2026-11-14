import {lazy,Suspense,useEffect,useMemo,useState} from 'react';
import {Dialog} from './Dialog';
import {PanelRight,Maximize2,Loader2} from 'lucide-react';
import {ApiError,fetchJSON} from '../lib/api';
import {isWithinExplorerRoot} from '../lib/explorer-path';
import './ConversationFilePreview.css';
const FileExplorer=lazy(()=>import('./FileExplorer').then(module=>({default:module.FileExplorer})));
export interface ConversationPreviewFile {path:string;rootPath:string;projectId:string|null;name:string;fileOnly?:boolean}
interface PathInfo {path:string;type:'file'|'directory'|'other'}
interface PreviewProps {file:ConversationPreviewFile;onClose:()=>void;dock?:{left:number;top:number;width:number;height:number};onDock?:()=>void;canDock?:boolean}
/** Reuse the workspace's read-only tree and renderers without changing its tabs. */
export function ConversationFilePreview(props:PreviewProps) {
  const {file}=props;
  return <ScopedFilePreview key={JSON.stringify([file.path,file.rootPath,file.projectId,!!file.fileOnly])} {...props}/>;
}
function ScopedFilePreview({file,onClose,dock,onDock,canDock=true}:PreviewProps) {
  const rootPath=file.fileOnly?file.path:file.rootPath;
  const [tabsHost,setTabsHost]=useState<HTMLDivElement|null>(null);
  const [result,setResult]=useState<{requestKey:string;info?:PathInfo;error?:string}|null>(null);
  const [revision,setRevision]=useState(0);
  const allowed=isWithinExplorerRoot(file.path,rootPath);
  const requestKey=JSON.stringify([file.path,rootPath,file.projectId,file.fileOnly,revision]);
  useEffect(()=>{
    if(!allowed)return;
    const controller=new AbortController();
    const query=new URLSearchParams({path:file.path});if(file.projectId)query.set('project_id',file.projectId);
    void fetchJSON<PathInfo>(`/files/stat?${query}`,{signal:controller.signal}).then(info=>{
      if(!controller.signal.aborted)setResult((info.type==='other'||file.fileOnly&&info.type!=='file')?{requestKey,error:'该路径不是普通文件或目录，暂不支持预览'}:{requestKey,info});
    }).catch(error=>{
      if(!controller.signal.aborted)setResult({requestKey,error:error instanceof ApiError&&error.status===404?'路径不存在或已被删除':error instanceof ApiError&&error.status===403?'没有权限访问此路径':error instanceof Error?error.message:'无法读取路径信息'});
    });
    return ()=>controller.abort();
  },[file.path,file.projectId,file.fileOnly,requestKey,allowed]);
  const current=!allowed?{error:'只能访问当前项目目录及其子目录',info:undefined}:result?.requestKey===requestKey?result:null;
  const directory=current?.info?.type==='directory';
  const info=current?.info;
  const request=useMemo(()=>info?.type==='file'?{path:info.path,key:1}:null,[info]);
  return <Dialog title={`${directory?'目录':'文件'}预览 · ${file.name}`} size="image" onClose={onClose} dock={dock} actions={onDock&&<button type="button" className="conversation-preview-dock" onClick={onDock} disabled={!dock&&!canDock} title={!canDock&&!dock?'窗口较窄，请使用居中预览':undefined}>{dock?<Maximize2 size={15}/>:<PanelRight size={15}/>}<span>{dock?'居中显示':'显示到侧边'}</span></button>}>
    {!directory&&<div ref={setTabsHost} className="flex shrink-0 overflow-x-auto border-b" style={{borderColor:'var(--border)'}} aria-label="预览文件标签"/>}
    <div className={`conversation-file-preview-stage${directory?' conversation-directory-preview':''}`} style={{height:dock?undefined:'min(74dvh,950px)',flex:dock?1:undefined,minHeight:0,position:'relative',overflow:'hidden'}}>
      {!current&&<p role="status" className="flex items-center gap-2 p-4 text-sm"><Loader2 size={16} className="animate-spin"/>正在读取路径信息…</p>}
      {current?.error&&<div role="alert" className="p-4 text-sm"><p>{current.error}</p><button type="button" className="mt-3 hover:underline" style={{color:'var(--accent)'}} onClick={()=>setRevision(value=>value+1)}>重新加载</button></div>}
      {current?.info&&<Suspense fallback={<p role="status" className="p-4">正在加载预览…</p>}><FileExplorer key={`${directory?'directory':'file'}:${directory?current.info.path:rootPath}`} rootPath={directory?current.info.path:rootPath} projectId={file.projectId||undefined} readOnly openFileRequest={request}
        workspace={directory?undefined:{treeHost:null,tabsHost,editorActive:true,onActivate:()=>{},onEmpty:onClose}}/></Suspense>}
    </div>
  </Dialog>;
}
