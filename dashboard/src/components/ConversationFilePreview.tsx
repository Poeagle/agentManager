import {lazy,Suspense,useMemo,useState} from 'react';
import {Dialog} from './Dialog';
import {PanelRight,Maximize2} from 'lucide-react';
const FileExplorer=lazy(()=>import('./FileExplorer').then(module=>({default:module.FileExplorer})));
export interface ConversationPreviewFile {path:string;rootPath:string;projectId:string|null;name:string}
/** Reuse the workspace's read-only renderers without changing its open tabs. */
export function ConversationFilePreview({file,onClose,dock,onDock,canDock=true}:{file:ConversationPreviewFile;onClose:()=>void;dock?:{left:number;top:number;width:number;height:number};onDock?:()=>void;canDock?:boolean}) {
  const [tabsHost,setTabsHost]=useState<HTMLDivElement|null>(null);
  const request=useMemo(()=>({path:file.path,key:1}),[file.path]);
  return <Dialog title={`文件预览 · ${file.name}`} size="image" onClose={onClose} dock={dock} actions={onDock&&<button type="button" className="conversation-preview-dock" onClick={onDock} disabled={!dock&&!canDock} title={!canDock&&!dock?'窗口较窄，请使用居中预览':undefined}>{dock?<Maximize2 size={15}/>:<PanelRight size={15}/>}<span>{dock?'居中显示':'显示到侧边'}</span></button>}>
    <div ref={setTabsHost} className="flex shrink-0 overflow-x-auto border-b" style={{borderColor:'var(--border)'}} aria-label="预览文件标签"/>
    <div className="conversation-file-preview-stage" style={{height:dock?undefined:'min(74dvh,950px)',flex:dock?1:undefined,minHeight:0,position:'relative',overflow:'hidden'}}>
      <Suspense fallback={<p role="status" className="p-4">正在加载文件预览…</p>}><FileExplorer rootPath={file.rootPath} projectId={file.projectId||undefined} readOnly openFileRequest={request}
        workspace={{treeHost:null,tabsHost,editorActive:true,onActivate:()=>{},onEmpty:onClose}}/></Suspense>
    </div>
  </Dialog>;
}
