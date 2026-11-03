export interface DirectoryFile {path:string;file?:File}
export interface DroppedEntry {name:string;isDirectory:boolean;file?:(done:(file:File)=>void,fail:(error:DOMException)=>void)=>void;createReader?:()=>{readEntries:(done:(entries:DroppedEntry[])=>void,fail:(error:DOMException)=>void)=>void}}
const MAX_FILES=2000,MAX_BYTES=100*1024*1024;
export function directoryPath(path:string){
 const value=path.replaceAll('\\','/'),parts=value.replace(/\/$/,'').split('/');
 if(value.startsWith('/')||/^[a-z]:/i.test(value)||parts.some(part=>!part||part==='.'||part==='..'||/[\0-\x1f]/.test(part)))throw Error('目录包含无效的相对路径');
 return value;
}
export async function readDroppedDirectory(root:DroppedEntry,signal:AbortSignal):Promise<DirectoryFile[]>{
 const files:DirectoryFile[]=[];let bytes=0,count=0;
 async function visit(entry:DroppedEntry,parent:string,depth:number){
  signal.throwIfAborted();if(depth>64||++count>MAX_FILES+256)throw Error('目录层级过深或条目过多');
  const path=directoryPath(parent+entry.name);
  if(entry.isDirectory){
   const reader=entry.createReader!();let any=false;
   while(true){signal.throwIfAborted();const batch=await new Promise<DroppedEntry[]>((resolve,reject)=>reader.readEntries(resolve,reject));if(!batch.length)break;any=true;for(const child of batch)await visit(child,path+'/',depth+1);}
   if(!any)files.push({path:path+'/'});
  }else{
   const file=await new Promise<File>((resolve,reject)=>entry.file!(resolve,reject));bytes+=file.size;
   if(files.length>=MAX_FILES||bytes>MAX_BYTES)throw Error('每个目录最多 2000 个文件，原始文件合计最多 100 MB');files.push({path,file});
  }
 }
 await visit(root,'',0);return files;
}
/** Read files asynchronously; transfer bytes to one worker for compression.
 * Only one archive runs at a time through the existing attachment queue. */
export async function packDirectory(name:string,entries:DirectoryFile[],signal:AbortSignal,onProgress:(percent:number)=>void):Promise<File>{
 const root=directoryPath(name);if(root.includes('/'))throw Error('目录名称无效');
 if(entries.length>MAX_FILES+256||entries.filter(entry=>entry.file).length>MAX_FILES||entries.reduce((sum,entry)=>sum+(entry.file?.size||0),0)>MAX_BYTES)throw Error('每个目录最多 2000 个文件，原始文件合计最多 100 MB');
 const seen=new Set<string>(),data:Array<{path:string;data:ArrayBuffer}>=[];
 for(const [index,entry] of entries.entries()){
  signal.throwIfAborted();const path=directoryPath(entry.path);if(path!==root+'/'&&!path.startsWith(root+'/')||seen.has(path))throw Error('目录包含重复或越界的路径');seen.add(path);
  data.push({path,data:entry.file?await entry.file.arrayBuffer():new ArrayBuffer(0)});onProgress(Math.floor((index+1)*45/Math.max(1,entries.length)));
 }
 signal.throwIfAborted();if(!data.length)data.push({path:root+'/',data:new ArrayBuffer(0)});
 return new Promise((resolve,reject)=>{
  const worker=new Worker(new URL('../workers/directory-zip.ts',import.meta.url),{type:'module'});
  const cleanup=()=>{worker.terminate();signal.removeEventListener('abort',abort);};
  const abort=()=>{cleanup();reject(new DOMException('Aborted','AbortError'));};signal.addEventListener('abort',abort,{once:true});
  worker.onmessage=(event:MessageEvent<{progress?:number;data?:Uint8Array;error?:string}>)=>{
   if(event.data.error){cleanup();reject(Error(event.data.error));}
   else if(event.data.data){cleanup();onProgress(100);resolve(new File([event.data.data as Uint8Array<ArrayBuffer>],`${root}.zip`,{type:'application/zip'}));}
   else if(event.data.progress!==undefined)onProgress(45+Math.floor(event.data.progress*.55));
  };
  worker.onerror=()=>{cleanup();reject(Error('目录打包失败，请重试'));};
  worker.postMessage(data,data.map(entry=>entry.data));
 });
}
