import {useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {ArrowUp,ChevronRight,FolderOpen,Loader2} from 'lucide-react';
import {api,type BrowseResult} from '../lib/api';

export function FolderBrowser({onSelect,browse=api.projects.browse,cacheKey='browse'}:{onSelect:(path:string,name:string)=>void;browse?:(path?:string)=>Promise<BrowseResult>;cacheKey?:string}){
 const [path,setPath]=useState<string|undefined>();
 const query=useQuery({queryKey:[cacheKey,path],queryFn:()=>browse(path),retry:false});const data=query.data;
 return <div className="rounded-lg border overflow-hidden" style={{borderColor:'var(--border)',background:'var(--bg-primary)'}}>
  <div className="flex items-center gap-2 px-3 py-2 text-xs border-b" style={{borderColor:'var(--border)',background:'var(--bg-tertiary)',color:'var(--text-secondary)'}}>
   {data?.parent&&<button type="button" aria-label="返回上级目录" onClick={()=>setPath(data.parent!)}><ArrowUp size={14}/></button>}
   <span className="min-w-0 truncate font-mono" title={data?.path}>{data?.path||'~'}</span>
   <button type="button" className="ml-auto shrink-0 px-2 py-1 rounded" style={{background:'var(--accent)',color:'white'}} disabled={!data||data.path==='/'} onClick={()=>data&&onSelect(data.path,data.folderName)}>选择此目录</button>
  </div>
  <div className="max-h-64 overflow-y-auto">{query.isPending?<div className="flex justify-center py-6"><Loader2 className="animate-spin" size={16}/></div>:query.isError?<p role="alert" className="p-3">{query.error.message}</p>:!data?.dirs.length?<p className="p-3">没有可访问的子目录</p>:data.dirs.map(dir=><button type="button" key={dir.path} onClick={()=>setPath(dir.path)} onDoubleClick={()=>onSelect(dir.path,dir.name)} className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left"><FolderOpen size={16}/><span className="truncate">{dir.name}</span>{dir.hasChildren&&<ChevronRight size={12} className="ml-auto"/>}</button>)}</div>
 </div>;
}
